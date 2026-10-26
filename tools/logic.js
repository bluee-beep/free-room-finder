/* ==================== Free Room Finder · 纯调度逻辑 ====================
 * 不依赖 DOM；浏览器中挂到 window.AppLogic，Node 中 module.exports。
 */
(function (root) {
  "use strict";

  var DAY_NAMES = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];
  var DAY_FULL = ["星期一", "星期二", "星期三", "星期四", "星期五", "星期六", "星期日"];

  function pad(n) {
    return (n < 10 ? "0" : "") + n;
  }

  function parseDateLocal(value) {
    if (value instanceof Date) {
      return new Date(value.getFullYear(), value.getMonth(), value.getDate(), 12, 0, 0, 0);
    }
    var parts = String(value || "").split("-").map(Number);
    if (parts.length !== 3 || parts.some(function (x) { return !isFinite(x); })) {
      return new Date(NaN);
    }
    return new Date(parts[0], parts[1] - 1, parts[2], 12, 0, 0, 0);
  }

  function formatISODate(date) {
    return date.getFullYear() + "-" + pad(date.getMonth() + 1) + "-" + pad(date.getDate());
  }

  function todayISO() {
    return formatISODate(new Date());
  }

  function weekdayOf(date) {
    var d = date.getDay();
    return d === 0 ? 7 : d;
  }

  function computeWeek(date, week1Monday) {
    var start = parseDateLocal(week1Monday);
    var current = parseDateLocal(date);
    if (isNaN(start.getTime()) || isNaN(current.getTime())) {
      return NaN;
    }
    var days = Math.floor((current.getTime() - start.getTime()) / 86400000);
    return Math.floor(days / 7) + 1;
  }

  function entryActive(entry, week) {
    if (!entry) {
      return false;
    }
    if (entry.unknown || entry.weeks === null || entry.weeks === undefined) {
      return true;
    }
    return (entry.weeks || []).some(function (range) {
      return week >= range[0] && week <= range[1];
    });
  }

  function entryCovers(entry, period) {
    return period >= entry.start && period <= entry.end;
  }

  function activeEntries(room, day, week) {
    return (room.entries || []).filter(function (entry) {
      return entry.day === day && entryActive(entry, week);
    });
  }

  function isOccupied(room, day, week, period) {
    return (room.entries || []).some(function (entry) {
      return entry.day === day && entryActive(entry, week) && entryCovers(entry, period);
    });
  }

  function isUnknown(room, day, week, period) {
    return (room.entries || []).some(function (entry) {
      return entry.day === day && entryCovers(entry, period) &&
        (entry.unknown || entry.weeks === null || entry.weeks === undefined);
    });
  }

  function freePeriods(room, day, week, total) {
    total = total || 12;
    var result = [];
    for (var p = 1; p <= total; p += 1) {
      result.push(!isOccupied(room, day, week, p));
    }
    return result;
  }

  function periodTime(periods, index) {
    if (!periods || !periods[index]) {
      return null;
    }
    return periods[index];
  }

  function freeWindows(room, day, week, periods) {
    var total = (periods && periods.length) || 12;
    var free = freePeriods(room, day, week, total);
    var windows = [];
    var start = null;
    for (var p = 1; p <= total; p += 1) {
      if (free[p - 1]) {
        if (start === null) {
          start = p;
        }
      } else if (start !== null) {
        windows.push(makeWindow(start, p - 1, periods));
        start = null;
      }
    }
    if (start !== null) {
      windows.push(makeWindow(start, total, periods));
    }
    return windows;
  }

  function makeWindow(start, end, periods) {
    var st = periodTime(periods, start - 1);
    var en = periodTime(periods, end - 1);
    return {
      start: start,
      end: end,
      length: end - start + 1,
      startTime: st ? st.start : "",
      endTime: en ? en.end : "",
    };
  }

  function qualifies(window, minLen) {
    return !minLen || window.length >= minLen;
  }

  function qualifyingWindows(windows, minLen) {
    return (windows || []).filter(function (w) {
      return qualifies(w, minLen);
    });
  }

  function longestWindow(windows) {
    return (windows || []).reduce(function (best, w) {
      return !best || w.length > best.length ? w : best;
    }, null);
  }

  function roomSummary(room, day, week, periods, minLen) {
    var windows = freeWindows(room, day, week, periods);
    var qualifying = qualifyingWindows(windows, minLen);
    var longest = longestWindow(qualifying.length ? qualifying : windows);
    var unknown = false;
    for (var p = 1; p <= 12; p += 1) {
      if (isUnknown(room, day, week, p)) {
        unknown = true;
        break;
      }
    }
    return {
      room: room,
      windows: windows,
      qualifying: qualifying,
      longest: longest,
      hasQualifying: qualifying.length > 0,
      unknown: unknown,
    };
  }

  function sortRooms(summaries) {
    return summaries.slice().sort(function (a, b) {
      var la = a.longest ? a.longest.length : 0;
      var lb = b.longest ? b.longest.length : 0;
      if (lb !== la) {
        return lb - la;
      }
      var sa = a.longest ? a.longest.start : 99;
      var sb = b.longest ? b.longest.start : 99;
      if (sa !== sb) {
        return sa - sb;
      }
      return String(a.room.id).localeCompare(String(b.room.id), "zh-CN", { numeric: true });
    });
  }

  function minutesOf(value) {
    if (!value || value.indexOf(":") < 0) {
      return NaN;
    }
    var parts = value.split(":").map(Number);
    return parts[0] * 60 + parts[1];
  }

  function nowMinutes(now) {
    now = now || new Date();
    return now.getHours() * 60 + now.getMinutes();
  }

  function findCurrentPeriod(now, periods) {
    if (!periods || !periods.length) {
      return null;
    }
    var current = nowMinutes(now);
    for (var i = 0; i < periods.length; i += 1) {
      var start = minutesOf(periods[i].start);
      var end = minutesOf(periods[i].end);
      if (current >= start && current < end) {
        return { period: i + 1, state: "in", start: periods[i].start, end: periods[i].end };
      }
    }
    for (var j = 0; j < periods.length; j += 1) {
      if (minutesOf(periods[j].start) > current) {
        return { period: j + 1, state: "next", start: periods[j].start, end: periods[j].end };
      }
    }
    return null;
  }

  function blockByIndex(index, periods) {
    if (!periods || index < 0 || index * 2 + 2 > periods.length) {
      return null;
    }
    var start = index * 2 + 1;
    var end = start + 1;
    var st = periods[start - 1];
    var en = periods[end - 1];
    if (!st || !en) {
      return null;
    }
    return {
      start: start,
      end: end,
      length: 2,
      startTime: st.start,
      endTime: en.end,
    };
  }

  /**
   * “下一大节”：按 1-2、3-4、5-6、7-8、9-10、11-12 的连堂块，
   * 返回下一个完整的 2 节块；如果当前正处在某个块内，则返回再下一个块。
   * 课间：如果下一个节次是某个块的第一节，则返回该块；
   * 如果下一个节次是第二节（块已过半），则返回再下一个完整块。
   */
  function nextBlock(now, periods) {
    if (!periods || !periods.length) {
      return null;
    }
    var current = nowMinutes(now);
    for (var i = 0; i < periods.length; i += 1) {
      var start = minutesOf(periods[i].start);
      var end = minutesOf(periods[i].end);
      if (current >= start && current < end) {
        return blockByIndex(Math.floor(i / 2) + 1, periods);
      }
    }
    var nextIndex = -1;
    for (var j = 0; j < periods.length; j += 1) {
      if (minutesOf(periods[j].start) > current) {
        nextIndex = j;
        break;
      }
    }
    if (nextIndex < 0) {
      return null;
    }
    // nextIndex 是 0-based；1-based 节次为 nextIndex+1
    if ((nextIndex + 1) % 2 === 1) {
      return blockByIndex(Math.floor(nextIndex / 2), periods);
    }
    return blockByIndex(Math.floor(nextIndex / 2) + 1, periods);
  }

  function isBlockFree(room, day, week, block) {
    if (!block) {
      return false;
    }
    for (var p = block.start; p <= block.end; p += 1) {
      if (isOccupied(room, day, week, p)) {
        return false;
      }
    }
    return true;
  }

  function isBlockUnknown(room, day, week, block) {
    if (!block) {
      return false;
    }
    for (var p = block.start; p <= block.end; p += 1) {
      if (isUnknown(room, day, week, p)) {
        return true;
      }
    }
    return false;
  }

  function formatClock(value) {
    return value || "";
  }

  function weekdayName(day) {
    return DAY_NAMES[day - 1] || "";
  }

  function weekdayFull(day) {
    return DAY_FULL[day - 1] || "";
  }

  function formatDateCN(date) {
    return (date.getMonth() + 1) + "月" + date.getDate() + "日";
  }

  function formatWeekRanges(weeks) {
    if (weeks === null || weeks === undefined) {
      return "周次未知";
    }
    return (weeks || []).map(function (range) {
      return range[0] === range[1] ? String(range[0]) : range[0] + "-" + range[1];
    }).join(",") + "周";
  }

  var Logic = {
    DAY_NAMES: DAY_NAMES,
    DAY_FULL: DAY_FULL,
    parseDateLocal: parseDateLocal,
    formatISODate: formatISODate,
    todayISO: todayISO,
    weekdayOf: weekdayOf,
    computeWeek: computeWeek,
    entryActive: entryActive,
    entryCovers: entryCovers,
    activeEntries: activeEntries,
    isOccupied: isOccupied,
    isUnknown: isUnknown,
    freePeriods: freePeriods,
    freeWindows: freeWindows,
    qualifies: qualifies,
    qualifyingWindows: qualifyingWindows,
    longestWindow: longestWindow,
    roomSummary: roomSummary,
    sortRooms: sortRooms,
    minutesOf: minutesOf,
    findCurrentPeriod: findCurrentPeriod,
    blockByIndex: blockByIndex,
    nextBlock: nextBlock,
    isBlockFree: isBlockFree,
    isBlockUnknown: isBlockUnknown,
    weekdayName: weekdayName,
    weekdayFull: weekdayFull,
    formatDateCN: formatDateCN,
    formatWeekRanges: formatWeekRanges,
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = Logic;
  } else {
    root.AppLogic = Logic;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
