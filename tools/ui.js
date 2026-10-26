/* ==================== Free Room Finder · 界面 ==================== */
(function () {
  "use strict";

  var DATA = window.SCHEDULE_DATA;
  var L = window.AppLogic;
  var KEY = "silesia-free-room-settings-v1";
  if (!DATA || !L) {
    document.body.textContent = "课表数据加载失败，请重新运行构建脚本。";
    return;
  }

  var META = DATA.meta;
  var DEFAULTS = META.defaults;
  var ROOMS = DATA.rooms;
  var storageOk = true;
  var toastTimer = null;

  var el = {
    subtitle: document.getElementById("subtitle"),
    prevDay: document.getElementById("prevDay"),
    nextDay: document.getElementById("nextDay"),
    dateInput: document.getElementById("dateInput"),
    todayBtn: document.getElementById("todayBtn"),
    settingsBtn: document.getElementById("settingsBtn"),
    heroKicker: document.getElementById("heroKicker"),
    heroTitle: document.getElementById("heroTitle"),
    heroSub: document.getElementById("heroSub"),
    noteBar: document.getElementById("noteBar"),
    minFilter: document.getElementById("minFilter"),
    nowToggle: document.getElementById("nowToggle"),
    nowFilter: document.getElementById("nowFilter"),
    nextBlockToggle: document.getElementById("nextBlockToggle"),
    nextBlockFilter: document.getElementById("nextBlockFilter"),
    showAll: document.getElementById("showAll"),
    search: document.getElementById("search"),
    viewToggle: document.getElementById("viewToggle"),
    roomList: document.getElementById("roomList"),
    tableView: document.getElementById("tableView"),
    footNote: document.getElementById("footNote"),
    dataInfoBtn: document.getElementById("dataInfoBtn"),
    settingsModal: document.getElementById("settingsModal"),
    closeSettings: document.getElementById("closeSettings"),
    cancelSettings: document.getElementById("cancelSettings"),
    saveSettings: document.getElementById("saveSettings"),
    settingsError: document.getElementById("settingsError"),
    week1Input: document.getElementById("week1Input"),
    weekHint: document.getElementById("weekHint"),
    periodsEditor: document.getElementById("periodsEditor"),
    resetPeriods: document.getElementById("resetPeriods"),
    defaultMin: document.getElementById("defaultMin"),
    dataInfo: document.getElementById("dataInfo"),
    toast: document.getElementById("toast"),
  };

  var state = {
    date: L.todayISO(),
    weekOverride: null,
    minLen: 2,
    nowOnly: false,
    nextBlockOnly: false,
    showAll: false,
    query: "",
    view: "list",
    settings: defaultSettings(),
  };

  // ==================== 设置持久化 ====================
  function clonePeriods(periods) {
    return periods.map(function (p) { return { start: p.start, end: p.end }; });
  }

  function defaultSettings() {
    return {
      week1Monday: DEFAULTS.week1Monday,
      periods: clonePeriods(DEFAULTS.periods),
      minLen: 2,
      view: "list",
    };
  }

  function validDate(value) {
    return /^\d{4}-\d{2}-\d{2}$/.test(String(value || "")) &&
      !isNaN(L.parseDateLocal(value).getTime());
  }

  function validTime(value) {
    return /^([01]\d|2[0-3]):[0-5]\d$/.test(String(value || ""));
  }

  function validPeriods(periods) {
    if (!Array.isArray(periods) || periods.length !== 12) {
      return false;
    }
    var previousEnd = -1;
    return periods.every(function (p) {
      if (!p || !validTime(p.start) || !validTime(p.end)) {
        return false;
      }
      var start = L.minutesOf(p.start);
      var end = L.minutesOf(p.end);
      if (start >= end || start < previousEnd) {
        return false;
      }
      previousEnd = end;
      return true;
    });
  }

  function loadSettings() {
    var settings = defaultSettings();
    try {
      var raw = localStorage.getItem(KEY);
      if (raw) {
        var saved = JSON.parse(raw);
        if (validDate(saved.week1Monday) && L.weekdayOf(L.parseDateLocal(saved.week1Monday)) === 1) {
          settings.week1Monday = saved.week1Monday;
        }
        if (validPeriods(saved.periods)) {
          settings.periods = clonePeriods(saved.periods);
        }
        if ([0, 2, 4, 8].indexOf(Number(saved.minLen)) >= 0) {
          settings.minLen = Number(saved.minLen);
        }
        if (saved.view === "list" || saved.view === "table") {
          settings.view = saved.view;
        }
      }
    } catch (err) {
      storageOk = false;
    }
    return settings;
  }

  function savePreferences() {
    state.settings.minLen = state.minLen;
    state.settings.view = state.view;
    try {
      localStorage.setItem(KEY, JSON.stringify({
        week1Monday: state.settings.week1Monday,
        periods: state.settings.periods,
        minLen: state.settings.minLen,
        view: state.settings.view,
      }));
    } catch (err) {
      storageOk = false;
      showToast("浏览器不允许保存设置，本次修改仅在当前页面有效。");
    }
  }

  function applyUrlParams() {
    var params = new URLSearchParams(window.location.search);
    if (validDate(params.get("date"))) {
      state.date = params.get("date");
    }
    var week = Number(params.get("week"));
    if (isFinite(week) && week !== 0) {
      state.weekOverride = week;
    }
    var min = params.get("min");
    if (min !== null && [0, 2, 4, 8].indexOf(Number(min)) >= 0) {
      state.minLen = Number(min);
    }
    var view = params.get("view");
    if (view === "list" || view === "table") {
      state.view = view;
    }
    var time = params.get("time");
    if (params.get("now") === "1" || time === "now") {
      state.nowOnly = true;
    }
    if (time === "next") {
      state.nextBlockOnly = true;
      state.nowOnly = false;
    }
  }

  // ==================== 上下文 ====================
  function context() {
    var date = L.parseDateLocal(state.date);
    var autoDay = L.weekdayOf(date);
    var day = autoDay;
    var week = state.weekOverride !== null
      ? state.weekOverride
      : L.computeWeek(date, state.settings.week1Monday);
    var isToday = state.date === L.todayISO();
    var now = new Date();
    var nowInfo = isToday ? L.findCurrentPeriod(now, state.settings.periods) : null;
    var nextBlock = isToday ? L.nextBlock(now, state.settings.periods) : null;
    var canNow = !!(isToday && nowInfo);
    return {
      date: date,
      autoDay: autoDay,
      day: day,
      week: week,
      isToday: isToday,
      nowInfo: nowInfo,
      nextBlock: nextBlock,
      canNow: canNow,
      nowPeriod: nowInfo ? nowInfo.period : null,
    };
  }

  function blockLabel(block) {
    return "第" + block.start + "–" + block.end + "节 " + block.startTime + "–" + block.endTime;
  }

  function nowLabel(ctx) {
    if (!ctx.isToday) {
      return "";
    }
    if (!ctx.nowInfo) {
      return "今日课程已结束";
    }
    if (ctx.nowInfo.state === "in") {
      return "第" + ctx.nowInfo.period + "节 " + ctx.nowInfo.start + "–" + ctx.nowInfo.end;
    }
    return "课间 · 即将第" + ctx.nowInfo.period + "节 " + ctx.nowInfo.start + "–" + ctx.nowInfo.end;
  }

  function roomFreeAt(room, ctx, period) {
    if (!period) {
      return false;
    }
    return !L.isOccupied(room, ctx.day, ctx.week, period);
  }


  function buildSummaries(ctx) {
    var all = ROOMS.map(function (room) {
      return L.roomSummary(room, ctx.day, ctx.week, state.settings.periods, state.minLen);
    });
    var query = state.query.trim().toLowerCase();
    var visible = all.filter(function (s) {
      if (!state.showAll && state.minLen > 0 && !s.hasQualifying) {
        return false;
      }
      if (state.nowOnly) {
        if (!ctx.canNow || !roomFreeAt(s.room, ctx, ctx.nowPeriod)) {
          return false;
        }
      }
      if (state.nextBlockOnly) {
        if (!ctx.nextBlock || !L.isBlockFree(s.room, ctx.day, ctx.week, ctx.nextBlock)) {
          return false;
        }
      }
      if (query) {
        var hay = (s.room.id + " " + s.room.name + " " + (s.room.capacity || "")).toLowerCase();
        if (hay.indexOf(query) < 0) {
          return false;
        }
      }
      return true;
    });
    return { all: all, visible: L.sortRooms(visible) };
  }

  // ==================== 渲染：顶部 ====================
  function renderSubtitle(ctx) {
    var parts = [META.semester, "第" + ctx.week + "周", L.weekdayFull(ctx.autoDay) + " " + L.formatDateCN(ctx.date)];
    if (state.weekOverride !== null) {
      parts.push("手动周次");
    }
    el.subtitle.textContent = parts.join(" · ");
  }

  function renderHero(ctx) {
    el.heroKicker.textContent = ctx.isToday ? "今天" : "查看";
    el.heroTitle.textContent = L.weekdayFull(ctx.autoDay) + " · " + L.formatDateCN(ctx.date);

    var sub = META.semester + " · 第" + ctx.week + "周";
    var label = nowLabel(ctx);
    if (label) {
      sub += " · " + label;
    }
    if (ctx.nextBlock) {
      sub += " · 下一大节 " + blockLabel(ctx.nextBlock);
      if (state.nextBlockOnly) {
        sub += "（已筛选）";
      }
    }
    if (ctx.week < 1 || ctx.week > 30) {
      sub += " · 非教学周";
    }
    el.heroSub.textContent = sub;
  }

  function renderNotes(ctx) {
    el.noteBar.textContent = "";
    // 只保留功能性提示；数据细节收进「数据说明」，不再占用首屏
    if (ctx.week < 1 || ctx.week > 30) {
      var span = document.createElement("span");
      span.textContent = "第 " + ctx.week + " 周不在课表周次范围（1–30 周），结果仅供参考";
      el.noteBar.appendChild(span);
    }
  }

  function filteredWarnings() {
    var overridden = {};
    ROOMS.forEach(function (room) {
      if (room.status === "override") {
        overridden[room.id] = true;
      }
    });
    return (DATA.warnings || []).filter(function (w) {
      return !overridden[w.room];
    });
  }

  // ==================== 渲染：工具栏 ====================
  function renderToolbar(ctx) {
    Array.prototype.forEach.call(el.minFilter.querySelectorAll("button"), function (btn) {
      btn.classList.toggle("active", Number(btn.getAttribute("data-min")) === state.minLen);
    });
    Array.prototype.forEach.call(el.viewToggle.querySelectorAll("button"), function (btn) {
      btn.classList.toggle("active", btn.getAttribute("data-view") === state.view);
    });
    if (!ctx.canNow) {
      state.nowOnly = false;
    }
    if (!ctx.nextBlock) {
      state.nextBlockOnly = false;
    }
    el.nowFilter.checked = state.nowOnly && ctx.canNow;
    el.nowFilter.disabled = !ctx.canNow;
    el.nowToggle.classList.toggle("disabled", !ctx.canNow);
    el.nextBlockFilter.checked = state.nextBlockOnly && !!ctx.nextBlock;
    el.nextBlockFilter.disabled = !ctx.nextBlock;
    el.nextBlockToggle.classList.toggle("disabled", !ctx.nextBlock);
    el.nextBlockToggle.title = ctx.nextBlock
      ? "下一大节：" + blockLabel(ctx.nextBlock)
      : "当前没有完整的下一大节";
    el.showAll.checked = state.showAll;
    if (el.search.value !== state.query) {
      el.search.value = state.query;
    }
  }

  // ==================== 渲染：列表 ====================
  function makeStatusPill(ctx, room) {
    var span = document.createElement("span");
    if (!ctx.canNow) {
      if (ctx.isToday) {
        span.className = "status off";
        span.textContent = "已下课";
        return span;
      }
      return null;
    }
    var period = ctx.nowPeriod;
    if (L.isUnknown(room, ctx.day, ctx.week, period)) {
      span.className = "status unknown";
      span.textContent = "数据缺失";
    } else if (L.isOccupied(room, ctx.day, ctx.week, period)) {
      span.className = "status busy";
      span.textContent = "有课";
    } else {
      span.className = "status free";
      span.textContent = "空闲";
    }
    return span;
  }

  function makeBadge(text, kind) {
    var span = document.createElement("span");
    span.className = "badge" + (kind ? " " + kind : "");
    span.textContent = text;
    return span;
  }

  function makeWindowPill(window) {
    var pill = document.createElement("span");
    pill.className = "window-pill";
    var title = document.createElement("b");
    title.textContent = "第" + window.start + (window.end > window.start ? "–" + window.end : "") + "节";
    var time = document.createElement("span");
    time.textContent = window.startTime && window.endTime
      ? window.startTime + "–" + window.endTime
      : "";
    pill.appendChild(title);
    if (time.textContent) {
      pill.appendChild(time);
    }
    return pill;
  }

  function makeEntryItem(entry) {
    var li = document.createElement("li");
    li.className = "entry" + (entry.unknown ? " unknown" : "");
    var period = document.createElement("span");
    period.className = "entry-period";
    period.textContent = "第" + entry.start + (entry.end > entry.start ? "–" + entry.end : "") + "节";
    var course = document.createElement("span");
    course.className = "entry-course";
    course.textContent = entry.course;
    var meta = document.createElement("span");
    meta.className = "entry-meta";
    var bits = [L.formatWeekRanges(entry.weeks)];
    if (entry.teacher) {
      bits.push(entry.teacher);
    }
    if (entry.inferredEnd) {
      bits.push("节次已补全");
    }
    if (entry.unknown) {
      bits.push("数据缺失，按占用处理");
    }
    meta.textContent = bits.join(" · ");
    li.appendChild(period);
    li.appendChild(course);
    li.appendChild(meta);
    return li;
  }

  function renderList(ctx, summaries) {
    el.roomList.textContent = "";
    if (!summaries.visible.length) {
      el.roomList.appendChild(emptyState(
        "没有满足条件的教室",
        state.nowOnly ? "试试关闭“此刻空闲”，或降低连空节数。" : "试试降低“连空”要求，或打开“显示全部教室”。"
      ));
      return;
    }
    var fragment = document.createDocumentFragment();
    summaries.visible.forEach(function (s) {
      var room = s.room;
      var card = document.createElement("article");
      card.className = "room-card";
      if (s.unknown) {
        card.classList.add("has-unknown");
      }
      if (state.minLen > 0 && !s.hasQualifying) {
        card.classList.add("muted");
      }

      var head = document.createElement("div");
      head.className = "room-head";
      var info = document.createElement("div");
      var id = document.createElement("div");
      id.className = "room-id";
      id.textContent = room.id;
      var name = document.createElement("div");
      name.className = "room-name";
      name.textContent = room.name;
      var cap = document.createElement("div");
      cap.className = "room-cap";
      cap.textContent = room.capacity ? room.capacity + " 座" : "容量未知";
      info.appendChild(id);
      info.appendChild(name);
      info.appendChild(cap);
      head.appendChild(info);

      var statusBox = document.createElement("div");
      statusBox.className = "room-status";
      var status = makeStatusPill(ctx, room);
      if (status) {
        statusBox.appendChild(status);
      }
      if (state.nextBlockOnly && ctx.nextBlock) {
        statusBox.appendChild(makeBadge(
          "下一大节 第" + ctx.nextBlock.start + "–" + ctx.nextBlock.end + "节", "ok"
        ));
      }
      if (s.unknown) {
        statusBox.appendChild(makeBadge("含数据缺失", "warn"));
      }
      var active = L.activeEntries(room, ctx.day, ctx.week);
      if (active.some(function (e) { return e.inferredEnd; })) {
        statusBox.appendChild(makeBadge("节次已补全", "warn"));
      }
      head.appendChild(statusBox);
      card.appendChild(head);

      var windows = state.minLen > 0 ? s.qualifying : s.windows;
      var windowList = document.createElement("div");
      windowList.className = "window-list";
      if (windows.length) {
        windows.forEach(function (w) {
          windowList.appendChild(makeWindowPill(w));
        });
      } else if (s.longest) {
        var short = makeWindowPill(s.longest);
        short.classList.add("short");
        windowList.appendChild(short);
        var hint = document.createElement("span");
        hint.className = "window-pill short";
        hint.textContent = "不足 " + state.minLen + " 节";
        windowList.appendChild(hint);
      } else {
        var none = document.createElement("span");
        none.className = "no-window";
        none.textContent = "当天没有空闲节次";
        windowList.appendChild(none);
      }
      card.appendChild(windowList);

      if (active.length) {
        var details = document.createElement("details");
        details.className = "room-details";
        var summary = document.createElement("summary");
        summary.textContent = "课程明细 · " + active.length + " 条";
        details.appendChild(summary);
        var list = document.createElement("ul");
        list.className = "entry-list";
        active.sort(function (a, b) {
          return a.start - b.start || a.end - b.end || a.course.localeCompare(b.course, "zh-CN");
        }).forEach(function (entry) {
          list.appendChild(makeEntryItem(entry));
        });
        details.appendChild(list);
        card.appendChild(details);
      } else {
        var noEntries = document.createElement("div");
        noEntries.className = "room-details no-entries";
        noEntries.textContent = "当天无课";
        card.appendChild(noEntries);
      }
      fragment.appendChild(card);
    });
    el.roomList.appendChild(fragment);
  }

  function emptyState(title, sub) {
    var box = document.createElement("div");
    box.className = "empty";
    var strong = document.createElement("strong");
    strong.textContent = title;
    var span = document.createElement("span");
    span.textContent = sub;
    box.appendChild(strong);
    box.appendChild(span);
    return box;
  }

  // ==================== 渲染：总览表 ====================
  function shortCourse(entry) {
    var name = String(entry.course || "").replace(/\[[^\]]+\]/g, "");
    return name.length > 7 ? name.slice(0, 7) + "…" : name;
  }

  function renderTable(ctx, summaries) {
    el.tableView.textContent = "";
    if (!summaries.visible.length) {
      el.tableView.appendChild(emptyState("没有满足条件的教室", "调整筛选条件后再看总览表。"));
      return;
    }
    var headWrap = document.createElement("div");
    headWrap.className = "matrix-head-wrap";
    var headScroll = document.createElement("div");
    headScroll.className = "matrix-head-scroll";
    var headTable = document.createElement("table");
    headTable.className = "matrix matrix-header";
    var thead = document.createElement("thead");
    var headRow = document.createElement("tr");
    var roomHead = document.createElement("th");
    roomHead.className = "room-col";
    roomHead.textContent = "教室";
    headRow.appendChild(roomHead);
    var current = ctx.canNow ? ctx.nowPeriod : null;
    var focusBlock = state.nextBlockOnly ? ctx.nextBlock : null;
    for (var p = 1; p <= 12; p += 1) {
      var th = document.createElement("th");
      if (p === current) {
        th.className = "now";
      }
      if (focusBlock && p >= focusBlock.start && p <= focusBlock.end) {
        th.classList.add("block-focus");
      }
      th.textContent = "第" + p + "节";
      var small = document.createElement("small");
      small.textContent = state.settings.periods[p - 1] ? state.settings.periods[p - 1].start : "";
      th.appendChild(small);
      headRow.appendChild(th);
    }
    thead.appendChild(headRow);
    headTable.appendChild(thead);
    headScroll.appendChild(headTable);
    headWrap.appendChild(headScroll);

    var bodyScroll = document.createElement("div");
    bodyScroll.className = "matrix-body-scroll";
    var bodyTable = document.createElement("table");
    bodyTable.className = "matrix matrix-body";
    var tbody = document.createElement("tbody");
    summaries.visible.forEach(function (s) {
      var room = s.room;
      var tr = document.createElement("tr");
      var rh = document.createElement("th");
      rh.className = "room-col";
      var b = document.createElement("b");
      b.textContent = room.id;
      var sm = document.createElement("small");
      sm.textContent = room.capacity ? room.capacity + "座" : "";
      rh.appendChild(b);
      rh.appendChild(sm);
      tr.appendChild(rh);
      for (var p = 1; p <= 12; p += 1) {
        var td = document.createElement("td");
        td.className = "cell";
        if (p === current) {
          td.classList.add("cell-now");
        }
        if (focusBlock && p >= focusBlock.start && p <= focusBlock.end) {
          td.classList.add("block-focus");
        }
        if (L.isUnknown(room, ctx.day, ctx.week, p)) {
          td.classList.add("cell-unknown");
          td.textContent = "?";
          td.title = "该时段缺少周次信息，按占用处理";
        } else if (L.isOccupied(room, ctx.day, ctx.week, p)) {
          td.classList.add("cell-busy");
          var entries = L.activeEntries(room, ctx.day, ctx.week).filter(function (e) {
            return e.start <= p && p <= e.end;
          });
          td.textContent = entries.length ? shortCourse(entries[0]) + (entries.length > 1 ? " +" + (entries.length - 1) : "") : "有课";
          td.title = entries.map(function (e) {
            return "第" + e.start + (e.end > e.start ? "–" + e.end : "") + "节 " + e.course +
              (e.teacher ? "（" + e.teacher + "）" : "");
          }).join("\n");
        } else {
          td.classList.add("cell-free");
          td.textContent = "";
        }
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    });
    bodyTable.appendChild(tbody);
    bodyScroll.appendChild(bodyTable);
    el.tableView.appendChild(headWrap);
    el.tableView.appendChild(bodyScroll);
    bodyScroll.addEventListener("scroll", function () {
      headScroll.scrollLeft = bodyScroll.scrollLeft;
    }, { passive: true });

    var legend = document.createElement("div");
    legend.className = "legend";
    ["空闲", "有课", "数据缺失"].forEach(function (label, idx) {
      var span = document.createElement("span");
      var sw = document.createElement("i");
      sw.className = "swatch " + ["free", "busy", "unknown"][idx];
      var text = document.createElement("span");
      text.textContent = label;
      span.appendChild(sw);
      span.appendChild(text);
      legend.appendChild(span);
    });
    var note = document.createElement("span");
    var noteBits = [];
    if (current) {
      noteBits.push("蓝框 = 当前/即将节次");
    }
    if (focusBlock) {
      noteBits.push("绿框 = 下一大节 第" + focusBlock.start + "–" + focusBlock.end + "节");
    }
    note.textContent = noteBits.join(" · ");
    legend.appendChild(note);
    el.tableView.appendChild(legend);
  }

  // ==================== 主渲染 ====================
  function render() {
    var ctx = context();
    document.body.classList.toggle("table-view", state.view === "table");
    if (!ctx.canNow) {
      state.nowOnly = false;
    }
    if (!ctx.nextBlock) {
      state.nextBlockOnly = false;
    }
    if (state.nextBlockOnly) {
      state.nowOnly = false;
    }
    if (state.nowOnly) {
      state.nextBlockOnly = false;
    }
    el.dateInput.value = state.date;
    renderSubtitle(ctx);
    renderHero(ctx);
    renderNotes(ctx);
    renderToolbar(ctx);
    var summaries = buildSummaries(ctx);
    if (state.view === "table") {
      el.roomList.hidden = true;
      el.tableView.hidden = false;
      renderTable(ctx, summaries);
    } else {
      el.tableView.hidden = true;
      el.roomList.hidden = false;
      renderList(ctx, summaries);
    }
    el.footNote.textContent = "课表来自教室 PDF，离线可用 · 生成于 " +
      (META.generatedAt || "—") + " · 设置自动保存在本机" + (storageOk ? "" : "（当前浏览器禁止保存）");
  }

  // ==================== 设置弹窗 ====================
  function updateWeekHint() {
    if (!validDate(el.week1Input.value)) {
      el.weekHint.textContent = "请选择有效的日期。";
      return;
    }
    var date = L.parseDateLocal(el.week1Input.value);
    var week = L.computeWeek(new Date(), el.week1Input.value);
    if (L.weekdayOf(date) !== 1) {
      el.weekHint.textContent = "提示：第 1 周周一应选择周一；当前选择的是周" +
        "一二三四五六日".charAt(L.weekdayOf(date) - 1) + "。今天 = 第 " + week + " 周。";
      return;
    }
    el.weekHint.textContent = "今天 = 第 " + week + " 周（" + L.formatDateCN(new Date()) + "）";
  }

  function openSettings(focusData) {
    el.settingsError.textContent = "";
    el.week1Input.value = state.settings.week1Monday;
    updateWeekHint();
    el.defaultMin.value = String(state.minLen);
    buildPeriodsEditor(state.settings.periods);
    buildDataInfo();
    el.settingsModal.hidden = false;
    document.body.style.overflow = "hidden";
    if (focusData) {
      el.dataInfo.scrollIntoView({ block: "start" });
    } else {
      el.week1Input.focus();
    }
  }

  function closeSettings() {
    el.settingsModal.hidden = true;
    document.body.style.overflow = "";
    el.settingsError.textContent = "";
  }

  function buildPeriodsEditor(periods) {
    el.periodsEditor.textContent = "";
    periods.forEach(function (p, idx) {
      var label = document.createElement("span");
      label.className = "p-label";
      label.textContent = "第" + (idx + 1) + "节";
      var start = document.createElement("input");
      start.type = "time";
      start.step = "60";
      start.value = p.start;
      start.setAttribute("data-period", String(idx));
      start.setAttribute("data-kind", "start");
      start.setAttribute("aria-label", "第" + (idx + 1) + "节开始时间");
      var end = document.createElement("input");
      end.type = "time";
      end.step = "60";
      end.value = p.end;
      end.setAttribute("data-period", String(idx));
      end.setAttribute("data-kind", "end");
      end.setAttribute("aria-label", "第" + (idx + 1) + "节结束时间");
      el.periodsEditor.appendChild(label);
      el.periodsEditor.appendChild(start);
      el.periodsEditor.appendChild(end);
    });
  }

  function readPeriodsEditor() {
    var periods = [];
    var inputs = el.periodsEditor.querySelectorAll("input[data-period]");
    for (var i = 0; i < 12; i += 1) {
      var start = el.periodsEditor.querySelector('input[data-period="' + i + '"][data-kind="start"]');
      var end = el.periodsEditor.querySelector('input[data-period="' + i + '"][data-kind="end"]');
      periods.push({ start: start ? start.value : "", end: end ? end.value : "" });
    }
    return periods;
  }

  function buildDataInfo() {
    el.dataInfo.textContent = "";
    var dl = document.createElement("dl");
    function row(k, v) {
      var dt = document.createElement("dt");
      dt.textContent = k;
      var dd = document.createElement("dd");
      dd.textContent = v;
      dl.appendChild(dt);
      dl.appendChild(dd);
    }
    row("数据生成", META.generatedAt || "—");
    row("教室", META.roomCount + " 间（PDF " + META.pdfCount + " 份）");
    row("课程记录", META.entryCount + " 条已知" + (META.unknownEntryCount ? " / " + META.unknownEntryCount + " 条未知" : ""));
    row("解析统计", "原始 " + META.rawEntryCount + " 条，重复 " + META.duplicatesRemoved + " 条");
    row("未提供课表", (META.missingRooms || []).join(" / ") || "无");
    el.dataInfo.appendChild(dl);
    var warnings = filteredWarnings();
    var title = document.createElement("p");
    title.className = "hint";
    title.textContent = warnings.length ? "源数据提示：" : "源数据提示：无";
    el.dataInfo.appendChild(title);
    if (warnings.length) {
      var ul = document.createElement("ul");
      ul.className = "warning-list";
      warnings.forEach(function (w) {
        var li = document.createElement("li");
        li.textContent = (w.room ? w.room + " · " : "") + (w.kind || "") +
          (w.text ? " · " + w.text : "") + (w.note ? " · " + w.note : "");
        ul.appendChild(li);
      });
      el.dataInfo.appendChild(ul);
    }
    var help = document.createElement("p");
    help.className = "hint";
    help.textContent = "306/406/408/506 没有课表文件，未纳入计算。";
    el.dataInfo.appendChild(help);
  }

  function saveSettings() {
    var week1 = el.week1Input.value;
    if (!validDate(week1)) {
      el.settingsError.textContent = "请选择有效的第 1 周周一日期。";
      return;
    }
    if (L.weekdayOf(L.parseDateLocal(week1)) !== 1) {
      el.settingsError.textContent = "第 1 周周一必须选择周一，否则周次计算会偏移。";
      return;
    }
    var periods = readPeriodsEditor();
    if (!validPeriods(periods)) {
      el.settingsError.textContent = "作息时间必须 12 节齐全，且每节结束时间晚于开始时间。";
      return;
    }
    state.settings.week1Monday = week1;
    state.settings.periods = clonePeriods(periods);
    state.settings.minLen = Number(el.defaultMin.value);
    state.minLen = state.settings.minLen;
    state.weekOverride = null;
    savePreferences();
    closeSettings();
    render();
    showToast("设置已保存。");
  }

  // ==================== 事件 ====================
  function shiftDate(delta) {
    var d = L.parseDateLocal(state.date);
    d.setDate(d.getDate() + delta);
    state.date = L.formatISODate(d);
    state.weekOverride = null;
    render();
  }

  function showToast(message) {
    el.toast.textContent = message;
    el.toast.hidden = false;
    if (toastTimer) {
      clearTimeout(toastTimer);
    }
    toastTimer = setTimeout(function () {
      el.toast.hidden = true;
    }, 3200);
  }

  el.prevDay.addEventListener("click", function () { shiftDate(-1); });
  el.nextDay.addEventListener("click", function () { shiftDate(1); });
  el.dateInput.addEventListener("change", function () {
    if (!validDate(el.dateInput.value)) {
      showToast("日期格式无效。");
      return;
    }
    state.date = el.dateInput.value;
    state.weekOverride = null;
    render();
  });
  el.todayBtn.addEventListener("click", function () {
    state.date = L.todayISO();
    state.weekOverride = null;
    render();
  });
  el.minFilter.addEventListener("click", function (event) {
    var btn = event.target.closest("button[data-min]");
    if (!btn) {
      return;
    }
    state.minLen = Number(btn.getAttribute("data-min"));
    savePreferences();
    render();
  });
  el.viewToggle.addEventListener("click", function (event) {
    var btn = event.target.closest("button[data-view]");
    if (!btn) {
      return;
    }
    state.view = btn.getAttribute("data-view");
    savePreferences();
    render();
  });
  el.nowFilter.addEventListener("change", function () {
    state.nowOnly = el.nowFilter.checked;
    if (state.nowOnly) {
      state.nextBlockOnly = false;
    }
    render();
  });
  el.nextBlockFilter.addEventListener("change", function () {
    state.nextBlockOnly = el.nextBlockFilter.checked;
    if (state.nextBlockOnly) {
      state.nowOnly = false;
    }
    render();
  });
  el.showAll.addEventListener("change", function () {
    state.showAll = el.showAll.checked;
    render();
  });
  el.search.addEventListener("input", function () {
    state.query = el.search.value;
    render();
  });
  el.settingsBtn.addEventListener("click", function () { openSettings(false); });
  el.dataInfoBtn.addEventListener("click", function () { openSettings(true); });
  el.week1Input.addEventListener("input", updateWeekHint);
  el.week1Input.addEventListener("change", updateWeekHint);
  el.closeSettings.addEventListener("click", closeSettings);
  el.cancelSettings.addEventListener("click", closeSettings);
  el.settingsModal.addEventListener("click", function (event) {
    if (event.target.getAttribute("data-close") === "1") {
      closeSettings();
    }
  });
  el.resetPeriods.addEventListener("click", function () {
    buildPeriodsEditor(clonePeriods(DEFAULTS.periods));
  });
  el.saveSettings.addEventListener("click", saveSettings);
  document.addEventListener("keydown", function (event) {
    if (event.key === "Escape" && !el.settingsModal.hidden) {
      closeSettings();
    }
  });

  // ==================== 初始化 ====================
  state.settings = loadSettings();
  state.minLen = state.settings.minLen;
  state.view = state.settings.view;
  applyUrlParams();
  render();
  if (new URLSearchParams(window.location.search).get("settings") === "1") {
    openSettings(false);
  }
  if (!storageOk) {
    showToast("当前浏览器禁止保存设置，修改只在本次页面有效。");
  }

  var lastToday = L.todayISO();
  var lastNowKey = null;

  function nowKey(ctx) {
    var nowPart = ctx.nowInfo ? ctx.nowInfo.period + ":" + ctx.nowInfo.state : "none";
    var blockPart = ctx.nextBlock ? ctx.nextBlock.start + "-" + ctx.nextBlock.end : "none";
    return nowPart + "|" + blockPart;
  }
  lastNowKey = nowKey(context());

  setInterval(function () {
    var today = L.todayISO();
    if (today !== lastToday) {
      if (state.date === lastToday) {
        state.date = today;
      }
      lastToday = today;
      lastNowKey = null;
      render();
      lastNowKey = nowKey(context());
      return;
    }
    if (state.date === today) {
      var key = nowKey(context());
      if (key !== lastNowKey) {
        lastNowKey = key;
        render();
      }
    }
  }, 30000);
})();
