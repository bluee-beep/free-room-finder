/* Free Room Finder · 纯逻辑回归测试
 * 运行：node tools/test_logic.js
 */
"use strict";

var assert = require("assert");
var path = require("path");
var fs = require("fs");
var Logic = require("./logic.js");

var data = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "data", "schedule.json"), "utf8"));
var periods = data.meta.defaults.periods;
var rooms = {};
data.rooms.forEach(function (room) { rooms[room.id] = room; });

function week(row) {
  return row.map(function (w) { return [w.start, w.end]; });
}

function roomWindows(id, day, weekNo) {
  return Logic.freeWindows(rooms[id], day, weekNo, periods).map(function (w) {
    return [w.start, w.end];
  });
}

function occupied(id, day, weekNo, period) {
  return Logic.isOccupied(rooms[id], day, weekNo, period);
}

// ==================== 基础计数 ====================
assert.strictEqual(data.rooms.length, 29, "应有 29 间教室");
assert.strictEqual(data.meta.roomCount, 29, "meta.roomCount");
assert.strictEqual(data.meta.entryCount, 474, "最终已知条目数");
assert.strictEqual(data.meta.unknownEntryCount, 0, "当前不应有 unknown 条目");
assert.strictEqual(rooms["308"].entries.length, 28, "308 覆盖表应为 28 条");
assert.strictEqual(rooms["308"].entries.filter(function (e) { return e.unknown; }).length, 0, "308 不应有 unknown");
assert.strictEqual(rooms["310"].entries.length, 34, "310 按可见课表应为 34 条");
assert.strictEqual(rooms["410"].entries.length, 43, "410 应为 43 条");

// ==================== 周次 ====================
assert.strictEqual(Logic.computeWeek(Logic.parseDateLocal("2026-08-31"), "2026-08-31"), 1);
assert.strictEqual(Logic.computeWeek(Logic.parseDateLocal("2026-10-26"), "2026-08-31"), 9);
assert.strictEqual(Logic.weekdayOf(Logic.parseDateLocal("2026-10-26")), 1);
assert.strictEqual(Logic.weekdayOf(Logic.parseDateLocal("2026-10-25")), 7);

// ==================== 空档与占用 ====================
assert.deepStrictEqual(roomWindows("301", 1, 8), [[1, 4], [9, 12]], "301 周一第8周");
assert.deepStrictEqual(roomWindows("301", 1, 1), [[1, 4], [9, 12]], "301 周一第1周");
assert.deepStrictEqual(roomWindows("404", 1, 9), [[1, 2], [7, 12]], "404 周一第9周");
assert.deepStrictEqual(roomWindows("308", 1, 9), [[5, 8], [11, 12]], "308 周一第9周");
assert.deepStrictEqual(roomWindows("304", 1, 9), [[11, 12]], "304 周一第9周");

assert.strictEqual(occupied("410", 1, 10, 6), true, "410 第10周周一第6节应被占用");
assert.strictEqual(occupied("308", 1, 5, 8), true, "308 第5周周一第8节应被占用");
assert.strictEqual(occupied("308", 5, 9, 11), true, "308 第9周周五第11节（马原）应被占用");
assert.strictEqual(occupied("308", 5, 9, 12), true, "308 第9周周五第12节（马原）应被占用");
assert.strictEqual(occupied("308", 5, 15, 11), false, "308 第15周周五第11节应空闲");
assert.strictEqual(occupied("410", 3, 7, 11), true, "410 第7周周三第11节（优化与决策）应被占用");

var optimizing = rooms["410"].entries.filter(function (e) {
  return e.course.indexOf("优化与决策") >= 0 && e.day === 3;
});
assert.strictEqual(optimizing.length, 3, "410 周三优化与决策应有 3 条");
assert.deepStrictEqual(optimizing.map(function (e) { return [e.start, e.end, e.weeks]; }).sort(function (a, b) { return a[0] - b[0]; }), [
  [7, 8, [[1, 3]]],
  [9, 10, [[1, 3], [6, 9]]],
  [11, 12, [[6, 9]]],
]);

// ==================== unknown 保守处理 ====================
var synthetic = {
  id: "999",
  name: "测试",
  capacity: 10,
  entries: [
    { day: 1, start: 3, end: 4, weeks: null, course: "未知", unknown: true },
  ],
};
var syntheticWindows = Logic.freeWindows(synthetic, 1, 9, periods);
assert.deepStrictEqual(syntheticWindows.map(function (w) { return [w.start, w.end]; }), [[1, 2], [5, 12]]);
assert.strictEqual(Logic.isUnknown(synthetic, 1, 9, 3), true);
assert.strictEqual(Logic.isOccupied(synthetic, 1, 9, 3), true);

// 任何空闲窗口都不得覆盖 unknown
data.rooms.forEach(function (room) {
  for (var day = 1; day <= 7; day += 1) {
    for (var w = 1; w <= 18; w += 1) {
      Logic.freeWindows(room, day, w, periods).forEach(function (win) {
        for (var p = win.start; p <= win.end; p += 1) {
          assert.strictEqual(Logic.isUnknown(room, day, w, p), false,
            room.id + " 第" + w + "周 周" + day + " 第" + p + "节 空闲窗口覆盖了 unknown");
        }
      });
    }
  }
});

// ==================== 连空筛选与当前节次 ====================
var windows301 = Logic.freeWindows(rooms["301"], 1, 8, periods);
assert.deepStrictEqual(Logic.qualifyingWindows(windows301, 3).map(function (w) { return [w.start, w.end]; }), [[1, 4], [9, 12]]);
assert.deepStrictEqual(Logic.qualifyingWindows(windows301, 5), []);

var now1 = Logic.findCurrentPeriod(new Date(2026, 9, 26, 10, 20), periods);
assert.deepStrictEqual(now1, { period: 3, state: "in", start: "10:05", end: "10:55" });
var now2 = Logic.findCurrentPeriod(new Date(2026, 9, 26, 12, 0), periods);
assert.deepStrictEqual(now2, { period: 5, state: "next", start: "13:30", end: "14:15" });
var now3 = Logic.findCurrentPeriod(new Date(2026, 9, 26, 21, 41), periods);
assert.strictEqual(now3, null);

// ==================== 下一大节（连堂 2 节） ====================
function nextBlockAt(h, m) {
  var b = Logic.nextBlock(new Date(2026, 9, 26, h, m), periods);
  return b ? [b.start, b.end, b.startTime, b.endTime] : null;
}
assert.deepStrictEqual(nextBlockAt(7, 30), [1, 2, "08:00", "09:35"], "第1节前应看第1-2节");
assert.deepStrictEqual(nextBlockAt(8, 10), [3, 4, "10:05", "11:40"], "第1节中应看下一大节第3-4节");
assert.deepStrictEqual(nextBlockAt(8, 46), [3, 4, "10:05", "11:40"], "1-2节小课间应看第3-4节");
assert.deepStrictEqual(nextBlockAt(8, 50), [3, 4, "10:05", "11:40"], "第2节开始应看第3-4节");
assert.deepStrictEqual(nextBlockAt(9, 40), [3, 4, "10:05", "11:40"], "2-3节大课间应看第3-4节");
assert.deepStrictEqual(nextBlockAt(10, 10), [5, 6, "13:30", "15:05"], "第3节中应看第5-6节");
assert.deepStrictEqual(nextBlockAt(12, 0), [5, 6, "13:30", "15:05"], "午休应看第5-6节");
assert.strictEqual(nextBlockAt(20, 10), null, "第11节中没有后续完整大节");
assert.strictEqual(nextBlockAt(21, 45), null, "全部结束后没有下一大节");

assert.strictEqual(Logic.isBlockFree(rooms["301"], 1, 9, { start: 3, end: 4 }), true, "301 第9周周一 3-4 空闲");
assert.strictEqual(Logic.isBlockFree(rooms["301"], 1, 9, { start: 5, end: 6 }), false, "301 第9周周一 5-6 有课");
assert.strictEqual(Logic.isBlockFree(rooms["301"], 1, 9, { start: 9, end: 10 }), true, "301 第9周周一 9-10 空闲");
assert.strictEqual(Logic.isBlockFree(rooms["304"], 1, 9, { start: 9, end: 10 }), false, "304 第9周周一 9-10 有课");
assert.strictEqual(Logic.isBlockFree(rooms["304"], 1, 9, { start: 11, end: 12 }), true, "304 第9周周一 11-12 空闲");
assert.strictEqual(Logic.isBlockFree(rooms["308"], 1, 9, { start: 5, end: 6 }), true, "308 第9周周一 5-6 空闲");
assert.strictEqual(Logic.isBlockFree(rooms["308"], 1, 9, { start: 9, end: 10 }), false, "308 第9周周一 9-10 有课");

// ==================== 教师（308 覆盖表） ====================
var xingshi = rooms["308"].entries.filter(function (e) {
  return e.course === "形势与政策Ⅰ";
});
assert.strictEqual(xingshi.length, 3, "308 形势与政策Ⅰ应有 3 条");
assert.ok(xingshi.some(function (e) { return e.day === 1 && e.weeks.join("|") === "7,8|11,11"; }));
assert.ok(xingshi.some(function (e) { return e.day === 2 && e.weeks.join("|") === "11,11|13,14"; }));
assert.ok(xingshi.some(function (e) { return e.day === 3 && e.weeks.join("|") === "7,8|11,11|13,14"; }));

console.log("OK  logic tests passed");
console.log("    29 rooms / 474 known / 0 unknown");
