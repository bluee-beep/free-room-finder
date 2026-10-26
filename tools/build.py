#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Free Room Finder — 课表构建脚本

将同目录上一层的教室课表 PDF 解析为 data/schedule.json，
再把数据、逻辑与界面注入 tools/template.html，生成单文件
空教室查询.html（双击即可打开）。

解析依赖 Poppler 的 pdftotext（需支持 -bbox-layout）。
"""

from __future__ import annotations

import argparse
import datetime as dt
import glob
import hashlib
import html
import json
import os
import re
import shutil
import subprocess
import sys
from collections import OrderedDict, defaultdict
from dataclasses import dataclass, field
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TOOLS = ROOT / "tools"
DATA_DIR = ROOT / "data"
OVERRIDE_DIR = DATA_DIR / "overrides"
DEFAULT_JSON = DATA_DIR / "schedule.json"
DEFAULT_HTML = ROOT / "空教室查询.html"

DAY_NAMES = ["星期一", "星期二", "星期三", "星期四", "星期五", "星期六", "星期日"]

# 用户提供的作息时间（第 1–12 节）
DEFAULT_PERIODS = [
    ("08:00", "08:45"), ("08:50", "09:35"), ("10:05", "10:55"), ("10:55", "11:40"),
    ("13:30", "14:15"), ("14:20", "15:05"), ("15:35", "16:20"), ("16:25", "17:10"),
    ("18:10", "18:55"), ("19:00", "19:45"), ("20:05", "20:50"), ("20:55", "21:40"),
]
DEFAULT_WEEK1_MONDAY = "2026-08-31"
CURRENT_WEEK_HINT = 9
MISSING_ROOMS = ["306", "406", "408", "506"]

PAGE_RE = re.compile(r'<page width="([\d.]+)" height="([\d.]+)">(.*?)</page>', re.S)
BLOCK_RE = re.compile(
    r'<block xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)">(.*?)</block>',
    re.S,
)
LINE_RE = re.compile(
    r'<line xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)">(.*?)</line>',
    re.S,
)
WORD_RE = re.compile(
    r'<word xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)">(.*?)</word>',
    re.S,
)

# 规范化后的 spec：周次 + 星期 + 节次（结束节次可省略）
SPEC_FULL_RE = re.compile(
    r"((?:\d{1,2}(?:-\d{1,2})?周,?)+),?"
    r"(?:星期([1-7一二三四五六日天])|周([1-7])),?"
    r"第(\d+)节(?:-(?:第)?(\d+)节)?"
)
SPEC_LIKE_RE = re.compile(r"^[0-9,、\-周星期一二三四五六日天第节期单双]+$")
ANCHOR_RE = re.compile(r"^\d{1,2}(?:-\d{1,2})?周")
PERIOD_ONLY_RE = re.compile(r"^(?:第)?\d+节$")
PERIOD_DASH_RE = re.compile(r"第\d+节-$")
CODE_RE = re.compile(r"\[[0-9A-Za-z]+\]")
# 完整 spec 出现在一行中间（课程名/教师与 spec 挤在同一行时）
EMBED_SPEC_RE = re.compile(
    r"((?:\d{1,2}(?:-\d{1,2})?周,?)+),?"
    r"(?:星期([1-7一二三四五六日天])|周([1-7])),?"
    r"第(\d+)节(?:-(?:第)?(\d+)节)?"
)
# 只有 第N节- 的截断 spec，用于保守补全为 N-(N+1)
PARTIAL_SPEC_RE = re.compile(
    r"((?:\d{1,2}(?:-\d{1,2})?周,?)+),?"
    r"(?:星期([1-7一二三四五六日天])|周([1-7])),?"
    r"第(\d+)节-$"
)


# ==================== 基础工具 ====================

def norm(text: str) -> str:
    """去掉空白，统一逗号/连字符，便于 spec 正则匹配。"""
    text = re.sub(r"\s+", "", text)
    text = text.replace("，", ",").replace("、", ",")
    for ch in "－—–~～至":
        text = text.replace(ch, "-")
    return text


def chinese_count(text: str) -> int:
    return len(re.findall(r"[一-鿿]", text))


def find_pdftotext(explicit: str | None) -> str:
    candidates: list[str] = []
    if explicit:
        candidates.append(explicit)
    which = shutil.which("pdftotext")
    if which:
        candidates.append(which)
    local = os.environ.get("LOCALAPPDATA")
    if local:
        pattern = str(Path(local) / "Microsoft" / "WinGet" / "Packages" /
                      "oschwartz10612.Poppler*" / "**" / "pdftotext.exe")
        candidates.extend(glob.glob(pattern, recursive=True))
    seen = set()
    for candidate in candidates:
        if not candidate or candidate in seen:
            continue
        seen.add(candidate)
        try:
            proc = subprocess.run([candidate, "-h"], capture_output=True)
        except OSError:
            continue
        help_text = (proc.stdout + proc.stderr).decode("utf-8", "replace")
        if "-bbox-layout" in help_text:
            return candidate
    raise SystemExit(
        "未找到支持 -bbox-layout 的 Poppler pdftotext。\n"
        "请安装：winget install oschwartz10612.Poppler\n"
        "或使用 --pdftotext 指定完整路径。"
    )


def run_bbox(pdftotext: str, pdf: Path) -> str:
    proc = subprocess.run(
        [pdftotext, "-enc", "UTF-8", "-bbox-layout", str(pdf), "-"],
        capture_output=True,
    )
    if proc.returncode != 0:
        raise RuntimeError(f"pdftotext 失败：{pdf.name}\n{proc.stderr.decode('utf-8', 'replace')}")
    return proc.stdout.decode("utf-8", "replace")


# ==================== PDF 结构 ====================

@dataclass
class Line:
    page: int
    block_id: int
    x0: float
    y0: float
    x1: float
    y1: float
    text: str


@dataclass
class Block:
    page: int
    block_id: int
    x0: float
    y0: float
    x1: float
    y1: float
    lines: list[Line] = field(default_factory=list)

    @property
    def text(self) -> str:
        return "".join(line.text for line in self.lines)


@dataclass
class Room:
    id: str
    name: str
    capacity: int | None
    internal_id: str
    entries: list[dict] = field(default_factory=list)
    status: str = "ok"
    override_source: str | None = None
    raw_count: int = 0
    duplicate_count: int = 0
    warnings: list[dict] = field(default_factory=list)


def parse_pages(xml: str) -> list[str]:
    return [body for _, _, body in PAGE_RE.findall(xml)]


def parse_blocks(page_body: str, page_no: int) -> list[Block]:
    blocks: list[Block] = []
    for idx, match in enumerate(BLOCK_RE.finditer(page_body)):
        x0, y0, x1, y1 = map(float, match.groups()[:4])
        block = Block(page_no, idx, x0, y0, x1, y1)
        for lm in LINE_RE.finditer(match.group(5)):
            lx0, ly0, lx1, ly1 = map(float, lm.groups()[:4])
            text = "".join(html.unescape(w) for w in re.findall(
                r"<word[^>]*>(.*?)</word>", lm.group(5), re.S))
            if text:
                block.lines.append(Line(page_no, idx, lx0, ly0, lx1, ly1, text))
        if block.lines:
            blocks.append(block)
    return blocks


def header_values(xml: str) -> tuple[str, int | None, str, str]:
    room_match = re.search(r"教室：([^<]+)</word>", xml)
    room_text = html.unescape(room_match.group(1)) if room_match else ""
    cap_match = re.search(r"容量：(\d+)</word>", xml)
    capacity = int(cap_match.group(1)) if cap_match else None
    sem_match = re.search(r"(\d{4}-\d{4}学年[^<]*?学期)</word>", xml)
    semester = html.unescape(sem_match.group(1)) if sem_match else "2026-2027学年 秋季学期"
    # 楼名不写死：取「楼」后的三位数字作为内部教室号
    id_match = re.search(r"楼\s*(\d{3})", room_text)
    internal_id = id_match.group(1) if id_match else ""
    return room_text, capacity, semester, internal_id


def column_centers(page_body: str) -> list[float] | None:
    centers: dict[str, float] = {}
    for match in WORD_RE.finditer(page_body):
        text = html.unescape(match.group(5))
        if text in DAY_NAMES:
            x0, x1 = float(match.group(1)), float(match.group(3))
            centers[text] = (x0 + x1) / 2
    if len(centers) != 7:
        return None
    return [centers[name] for name in DAY_NAMES]


def is_header_block(block: Block) -> bool:
    text = norm(block.text)
    if not text:
        return True
    if block.y0 < 55 or block.y0 > 805:
        return True
    if "全校课表" in text or "教室：" in text or "学期" in text:
        return True
    if "http" in text or re.fullmatch(r"\d+/\d+", text):
        return True
    if "节次" in text:
        return True
    if text in [norm(name) for name in DAY_NAMES]:
        return True
    if re.fullmatch(r"第\d+节", text):
        return True
    if text.startswith("2026/") or re.fullmatch(r"\d{4}/\d{2}/\d{2}\d{2}:\d{2}", text):
        return True
    return False


def row_label_bands(blocks: list[Block]) -> list[tuple[int, float, float]]:
    """从左侧第N节标签的中心 y 推断每个节次的行带。"""
    centers: dict[int, float] = {}
    for block in blocks:
        text = block.text.strip()
        match = re.fullmatch(r"第(\d+)节", text)
        if match and block.x0 < 65:
            centers[int(match.group(1))] = (block.y0 + block.y1) / 2
    if not centers:
        return []
    periods = sorted(centers)
    ys = [centers[p] for p in periods]
    diffs = [b - a for a, b in zip(ys, ys[1:]) if b > a]
    step = (sum(diffs) / len(diffs)) if diffs else 80.0
    bands = []
    for i, p in enumerate(periods):
        y = centers[p]
        lo = (centers[periods[i - 1]] + y) / 2 if i > 0 else y - step / 2
        hi = (centers[periods[i + 1]] + y) / 2 if i + 1 < len(periods) else y + step / 2
        bands.append((p, lo, hi))
    return bands


# ==================== spec 解析 ====================

def is_spec_like(text: str) -> bool:
    text = norm(text)
    if not SPEC_LIKE_RE.match(text):
        return False
    # 单个“三/五”之类的教师名尾字不能当作 spec 续行
    return bool(re.search(r"[0-9周星期第节期]", text))


def merge_split_week_headers(lines: list[Line]) -> list[Line]:
    """合并被拆成 “11-12” + “周,14周,星...” 的周次表头。"""
    merged: list[Line] = []
    i = 0
    while i < len(lines):
        line = lines[i]
        if (re.fullmatch(r"\d{1,2}(?:-\d{1,2})?", line.text.strip())
                and i + 1 < len(lines)
                and lines[i + 1].page == line.page
                and lines[i + 1].block_id == line.block_id
                and lines[i + 1].text.strip().startswith("周")):
            merged.append(Line(line.page, line.block_id, line.x0, line.y0,
                               line.x1, line.y1,
                               line.text + lines[i + 1].text))
            i += 2
            continue
        merged.append(line)
        i += 1
    return merged


def expand_embedded_specs(lines: list[Line]) -> list[Line]:
    """把“课程名+教师+周次”同一行拆成名字行与 spec 行。"""
    expanded: list[Line] = []
    for line in lines:
        match = EMBED_SPEC_RE.search(line.text)
        if match and match.start() > 0:
            before = line.text[:match.start()]
            spec = line.text[match.start():match.end()]
            after = line.text[match.end():]
            if before.strip():
                expanded.append(Line(line.page, line.block_id, line.x0, line.y0,
                                     line.x1, line.y1, before))
            expanded.append(Line(line.page, line.block_id, line.x0, line.y0,
                                 line.x1, line.y1, spec))
            if after.strip():
                expanded.append(Line(line.page, line.block_id, line.x0, line.y0,
                                     line.x1, line.y1, after))
        else:
            expanded.append(line)
    return expanded


def near_spec_continuation(anchor: Line, cand: Line) -> bool:
    """第N节- 的续行必须在同一单元格附近，避免吞掉下一门课的节次。"""
    if cand.page == anchor.page:
        return abs(cand.y0 - anchor.y0) <= 170
    if cand.page == anchor.page + 1 and anchor.y0 > 700 and cand.y0 < 180:
        return True
    return False


def collect_specs(lines: list[Line]) -> tuple[list[dict], set[int]]:
    """按行收集 spec。返回 spec 列表和已消费的行号集合。

    关键：spec 的续行可能被下一门课的课程名挡住（跨页/交错），
    因此跳过非 spec-like 行继续向后找，直到 spec 完整。
    """
    specs: list[dict] = []
    consumed: set[int] = set()
    i = 0
    while i < len(lines):
        if i in consumed:
            i += 1
            continue
        text = norm(lines[i].text)
        if not ANCHOR_RE.match(text):
            i += 1
            continue
        consumed.add(i)
        spec_text = text
        indices = [i]
        j = i + 1
        tries = 0
        while j < len(lines) and tries < 15:
            if j in consumed:
                j += 1
                continue
            if SPEC_FULL_RE.fullmatch(spec_text):
                break
            nxt = norm(lines[j].text)
            if PERIOD_DASH_RE.search(spec_text):
                # 当前停在第N节-，只接受同一单元格附近的纯节次续行
                if PERIOD_ONLY_RE.match(nxt) and near_spec_continuation(lines[i], lines[j]):
                    spec_text += nxt
                    indices.append(j)
                    consumed.add(j)
                    j += 1
                    tries += 1
                    continue
                j += 1
                tries += 1
                continue
            if ANCHOR_RE.match(nxt) and re.search(
                    r"(?:星期[1-7一二三四五六日天]|周[1-7])", spec_text) and \
                    re.search(r"第\d+节", spec_text):
                break
            if is_spec_like(nxt):
                spec_text += nxt
                indices.append(j)
                consumed.add(j)
                j += 1
                tries += 1
                continue
            j += 1
            tries += 1
        match = SPEC_FULL_RE.fullmatch(spec_text)
        specs.append({
            "anchor": i,
            "indices": indices,
            "text": spec_text,
            "match": match,
        })
        i += 1
    return specs, consumed


def parse_weeks(group: str) -> list[list[int]]:
    weeks: set[int] = set()
    for token in filter(None, group.replace("，", ",").split(",")):
        token = token.rstrip("周")
        if not token:
            continue
        if "-" in token:
            parts = token.split("-")
            if len(parts) != 2 or not parts[0].isdigit() or not parts[1].isdigit():
                continue
            a, b = int(parts[0]), int(parts[1])
            if a <= b:
                weeks.update(range(a, b + 1))
        elif token.isdigit():
            weeks.add(int(token))
    if not weeks:
        return []
    ordered = sorted(weeks)
    ranges: list[list[int]] = []
    start = prev = ordered[0]
    for value in ordered[1:]:
        if value == prev + 1:
            prev = value
            continue
        ranges.append([start, prev])
        start = prev = value
    ranges.append([start, prev])
    return ranges


def group_name_lines(lines: list[Line], indices: list[int]) -> list[list[Line]]:
    groups: "OrderedDict[tuple[int, int], list[Line]]" = OrderedDict()
    for idx in indices:
        line = lines[idx]
        groups.setdefault((line.page, line.block_id), []).append(line)
    result = []
    for group in groups.values():
        group.sort(key=lambda l: (l.y0, l.x0))
        result.append(group)
    result.sort(key=lambda g: (g[0].page, min(l.y0 for l in g)))
    return result


def group_text(group: list[Line]) -> str:
    return "".join(line.text for line in group)


def looks_like_course_name(text: str) -> bool:
    text = text.strip()
    if not text:
        return False
    if CODE_RE.search(text):
        return True
    # 无课号的纯课程名（如“形势与政策Ⅰ”）；排除含数字的教师/容量行
    if re.search(r"\d", text):
        return False
    return chinese_count(text) >= 5


def clean_course(text: str) -> str:
    text = "".join(text.split())
    # 交错残片："-第理论力学8节…" / "-数字时代管第6节…"
    if text.startswith("-第"):
        text = text[2:]
    else:
        text = text.lstrip("-")
    text = re.sub(r"\d+节", "", text)
    match = CODE_RE.search(text)
    if match:
        return text[:match.end()]
    return text


def infer_periods_for_group(
    group: list[Line],
    bands_by_page: dict[int, list[tuple[int, float, float]]],
    fallback: tuple[int, int] | None,
) -> tuple[int, int]:
    page = group[0].page
    bands = bands_by_page.get(page, [])
    text = group_text(group)
    code_match = CODE_RE.search(text)
    course_part = text[:code_match.end()] if code_match else text
    y0 = min(line.y0 for line in group)
    y1 = max(line.y1 for line in group)
    yc = (y0 + y1) / 2
    if code_match:
        # 课程名通常位于合并单元格顶部；用块中心判断
        pass
    hit = [p for p, lo, hi in bands if lo <= yc <= hi]
    if not hit:
        overlap = [(p, max(0, min(y1, hi) - max(y0, lo))) for p, lo, hi in bands]
        overlap = [item for item in overlap if item[1] > 0]
        if overlap:
            best = max(overlap, key=lambda item: item[1])
            hit = [best[0]]
    if fallback:
        # 同一单元格里有已配对 spec 时，优先采用其完整节次
        return fallback
    if hit:
        return min(hit), max(hit)
    return 1, 12


# ==================== 单个教室解析 ====================

def parse_room(pdf: Path, pdftotext: str) -> tuple[Room | None, dict]:
    xml = run_bbox(pdftotext, pdf)
    pages = parse_pages(xml)
    if not pages:
        return None, {"file": pdf.name, "reason": "PDF 没有可解析页面"}
    room_text, capacity, semester, internal_id = header_values(xml)
    room_id = pdf.stem
    if internal_id and internal_id != room_id:
        return None, {
            "file": pdf.name,
            "reason": f"内部教室号为 {internal_id}，与文件名 {room_id} 不一致",
        }
    # 显示名去掉楼名前缀与末尾的楼宇编码，只保留「301多媒体」这样的教室标识
    room_name = re.sub(r"\(\d+\)$", "", room_text).strip()
    room_name = re.sub(r"^[^\d]*?楼", "", room_name).strip() or room_id

    centers = None
    for body in pages:
        centers = column_centers(body)
        if centers:
            break
    if not centers:
        return None, {"file": pdf.name, "reason": "找不到星期一至星期日表头"}

    # 收集所有页的数据块与行标签
    page_blocks: dict[int, list[Block]] = {}
    bands_by_page: dict[int, list[tuple[int, float, float]]] = {}
    for page_no, body in enumerate(pages, 1):
        blocks = parse_blocks(body, page_no)
        page_blocks[page_no] = blocks
        bands_by_page[page_no] = row_label_bands(blocks)

    day_lines: dict[int, list[Line]] = {d: [] for d in range(1, 8)}
    warnings: list[dict] = []
    for page_no, blocks in page_blocks.items():
        for block in blocks:
            if is_header_block(block):
                continue
            cx = (block.x0 + block.x1) / 2
            day_idx = min(range(7), key=lambda i: abs(centers[i] - cx))
            if abs(centers[day_idx] - cx) > 55:
                warnings.append({
                    "room": room_id, "kind": "far_column",
                    "text": block.text[:60],
                    "note": "文本块离最近星期列较远，按最近列处理",
                })
            day_lines[day_idx + 1].extend(block.lines)

    entries: list[dict] = []
    raw_entries: list[dict] = []
    for day, lines in day_lines.items():
        if not lines:
            continue
        lines.sort(key=lambda l: (l.page, l.y0, l.x0))
        lines = merge_split_week_headers(lines)
        lines = expand_embedded_specs(lines)
        specs, consumed = collect_specs(lines)

        # 审计：未被 spec 消费的、形似周次/节次的行
        for idx, line in enumerate(lines):
            if idx in consumed:
                continue
            t = norm(line.text)
            if is_spec_like(t):
                warnings.append({
                    "room": room_id, "kind": "unconsumed_spec_fragment",
                    "day": day, "text": line.text,
                    "note": "有 spec 形状但未归属，请人工核对",
                })

        parsed_specs: list[dict] = []
        for spec in specs:
            current_entry: dict | None = None
            anchor = spec["anchor"]
            prev_anchor = parsed_specs[-1]["anchor"] if parsed_specs else -1
            name_indices = [
                k for k in range(prev_anchor + 1, anchor)
                if k not in consumed
            ]
            groups = group_name_lines(lines, name_indices)
            code_groups = [g for g in groups if CODE_RE.search(group_text(g))]
            chosen = code_groups[-1] if code_groups else (groups[-1] if groups else None)
            orphan_groups = []
            if chosen is not None:
                chosen_y = min(line.y0 for line in chosen)
                for group in groups:
                    if group is chosen:
                        continue
                    # 只把课程名块上方（同一单元格内）的额外名字当作孤儿；
                    # 名字下方的通常是教师/容量续行，不能误判。
                    if max(line.y1 for line in group) > chosen_y + 1:
                        continue
                    if code_groups and group in code_groups and code_groups.index(group) < code_groups.index(chosen):
                        orphan_groups.append(group)
                    elif looks_like_course_name(group_text(group)) and not CODE_RE.search(group_text(group)):
                        orphan_groups.append(group)
            course = "未知课程"
            if chosen is not None:
                chosen_text = group_text(chosen)
                # 课程名被拆成“优化与决策” + “（智能学院）[01]”两个块时合并
                if chosen_text.lstrip().startswith(("（", "(", "[", "）", ")")):
                    chosen_y = min(line.y0 for line in chosen)
                    above = [
                        g for g in groups
                        if g is not chosen and max(line.y1 for line in g) <= chosen_y + 1
                    ]
                    if above:
                        merge_group = above[-1]
                        chosen_text = group_text(merge_group) + chosen_text
                        if merge_group in orphan_groups:
                            orphan_groups.remove(merge_group)
                course = clean_course(chosen_text)
                if not course:
                    course = "未知课程"
            match = spec["match"]
            if match:
                weeks = parse_weeks(match.group(1))
                dv = match.group(2) or match.group(3)
                spec_day = (("一二三四五六日天".index(dv) + 1)
                            if dv in "一二三四五六日天" else int(dv))
                start = int(match.group(4))
                end = int(match.group(5) or match.group(4))
                if spec_day != day:
                    warnings.append({
                        "room": room_id, "kind": "day_mismatch",
                        "text": spec["text"], "note": "spec 星期与所在列不一致",
                    })
                if weeks and 1 <= start <= end <= 12:
                    entry = {
                        "day": day, "start": start, "end": end,
                        "weeks": weeks, "course": course, "unknown": False,
                    }
                    raw_entries.append(entry)
                    entries.append(entry)
                    current_entry = entry
                else:
                    warnings.append({
                        "room": room_id, "kind": "invalid_spec",
                        "text": spec["text"], "note": "周次/节次非法，转为未知占用",
                    })
                    current_entry = {
                        "day": day, "start": start if 1 <= start <= 12 else 1,
                        "end": end if 1 <= end <= 12 else 12,
                        "weeks": None, "course": course, "unknown": True,
                    }
                    entries.append(current_entry)
            else:
                partial = PARTIAL_SPEC_RE.fullmatch(spec["text"])
                if partial:
                    weeks = parse_weeks(partial.group(1))
                    dv = partial.group(2) or partial.group(3)
                    spec_day = (("一二三四五六日天".index(dv) + 1)
                                if dv in "一二三四五六日天" else int(dv))
                    start = int(partial.group(4))
                    end = min(start + 1, 12)
                    if weeks and 1 <= start <= end <= 12 and spec_day == day:
                        warnings.append({
                            "room": room_id, "kind": "inferred_end",
                            "text": spec["text"],
                            "note": f"节次范围在 PDF 中截断，按 {start}-{end} 补全",
                        })
                        current_entry = {
                            "day": day, "start": start, "end": end,
                            "weeks": weeks, "course": course,
                            "unknown": False, "inferredEnd": True,
                        }
                        raw_entries.append(current_entry)
                        entries.append(current_entry)
                    else:
                        warnings.append({
                            "room": room_id, "kind": "incomplete_spec",
                            "text": spec["text"], "note": "spec 不完整，按未知占用处理",
                        })
                        current_entry = {
                            "day": day, "start": 1, "end": 12,
                            "weeks": None, "course": course, "unknown": True,
                        }
                        entries.append(current_entry)
                else:
                    warnings.append({
                        "room": room_id, "kind": "incomplete_spec",
                        "text": spec["text"], "note": "spec 不完整，按未知占用处理",
                    })
                    current_entry = {
                        "day": day, "start": 1, "end": 12,
                        "weeks": None, "course": course, "unknown": True,
                    }
                    entries.append(current_entry)
            # 先记录 spec 锚点，供下一条计算 name 范围
            parsed_specs.append(spec)

            # 同一单元格里未被采用的名字块 → 孤儿，保守按占用
            fallback = (current_entry["start"], current_entry["end"]) if current_entry else None
            for group in orphan_groups:
                name = clean_course(group_text(group))
                if not name or name == "未知课程":
                    continue
                o_start, o_end = infer_periods_for_group(group, bands_by_page, fallback)
                entries.append({
                    "day": day, "start": o_start, "end": o_end,
                    "weeks": None, "course": name, "unknown": True,
                    "note": "源 PDF 该条目缺少完整周次/节次信息",
                })
                warnings.append({
                    "room": room_id, "kind": "orphan_name",
                    "day": day, "text": group_text(group),
                    "note": "只有课程名、缺少完整 spec；已按 unknown 占用处理",
                })

        # 最后一个 spec 之后的名字块（如周五第 11 节的孤儿）
        if specs:
            last_spec = specs[-1]
            tail_start = max(last_spec["indices"] + [last_spec["anchor"]]) + 1
            tail_indices = [k for k in range(tail_start, len(lines)) if k not in consumed]
            for group in group_name_lines(lines, tail_indices):
                if not looks_like_course_name(group_text(group)):
                    continue
                name = clean_course(group_text(group))
                if not name or name == "未知课程":
                    continue
                fallback = None
                if last_spec["match"]:
                    fallback = (
                        int(last_spec["match"].group(4)),
                        int(last_spec["match"].group(5) or last_spec["match"].group(4)),
                    )
                o_start, o_end = infer_periods_for_group(group, bands_by_page, fallback)
                entries.append({
                    "day": day, "start": o_start, "end": o_end,
                    "weeks": None, "course": name, "unknown": True,
                    "note": "源 PDF 该条目缺少完整周次/节次信息",
                })
                warnings.append({
                    "room": room_id, "kind": "orphan_tail",
                    "day": day, "text": group_text(group),
                    "note": "列尾只有课程名、缺少 spec；已按 unknown 占用处理",
                })

    # 精确去重（同一教室）
    unique: list[dict] = []
    seen = set()
    for entry in entries:
        key = (
            entry["day"], entry["start"], entry["end"],
            tuple(map(tuple, entry.get("weeks") or [])),
            entry["course"], bool(entry.get("unknown")),
        )
        if key in seen:
            continue
        seen.add(key)
        unique.append(entry)
    unique.sort(key=lambda e: (e["day"], e["start"], e["end"], e["course"]))
    room = Room(
        id=room_id, name=room_name, capacity=capacity, internal_id=internal_id,
        entries=unique, raw_count=len(raw_entries),
        duplicate_count=max(0, len(entries) - len(unique)), warnings=warnings,
    )
    meta = {"semester": semester, "file": pdf.name}
    return room, meta


# ==================== 覆盖表 ====================

def load_overrides() -> dict[str, dict]:
    overrides: dict[str, dict] = {}
    if not OVERRIDE_DIR.exists():
        return overrides
    for path in sorted(OVERRIDE_DIR.glob("*.json")):
        data = json.loads(path.read_text(encoding="utf-8"))
        room_id = str(data.get("roomId") or path.stem)
        overrides[room_id] = data
    return overrides


def normalize_override_entry(entry: dict) -> dict:
    weeks = entry.get("weeks")
    unknown = bool(entry.get("unknown")) or weeks is None
    out = {
        "day": int(entry["day"]),
        "start": int(entry["start"]),
        "end": int(entry["end"]),
        "weeks": weeks,
        "course": str(entry.get("course") or "未知课程").strip(),
        "unknown": unknown,
    }
    if entry.get("teacher"):
        out["teacher"] = str(entry["teacher"])
    if entry.get("note") or unknown:
        out["note"] = str(entry.get("note") or "周次未知，按全学期占用处理")
    return out


def apply_overrides(rooms: list[Room], overrides: dict[str, dict]) -> tuple[list[str], list[dict]]:
    warnings: list[dict] = []
    applied: list[str] = []
    by_id = {room.id: room for room in rooms}
    for room_id, data in overrides.items():
        room = by_id.get(room_id)
        if room is None:
            warnings.append({
                "room": room_id, "kind": "override_missing_room",
                "note": "覆盖表对应的教室不在 PDF 解析结果中",
            })
            continue
        entries = [normalize_override_entry(e) for e in data.get("entries", [])]
        for e in entries:
            if not (1 <= e["day"] <= 7 and 1 <= e["start"] <= e["end"] <= 12):
                raise SystemExit(f"覆盖表 {room_id} 有非法 day/节次：{e}")
            if e["weeks"] is not None:
                for a, b in e["weeks"]:
                    if not (1 <= a <= b <= 30):
                        raise SystemExit(f"覆盖表 {room_id} 有非法周次：{e}")
        entries.sort(key=lambda e: (e["day"], e["start"], e["end"], e["course"]))
        room.entries = entries
        room.status = "override"
        room.override_source = str(data.get("source") or "manual")
        applied.append(room_id)
    return applied, warnings


# ==================== 校验与组装 ====================

def entry_known_count(rooms: list[Room]) -> tuple[int, int]:
    known = unknown = 0
    for room in rooms:
        for e in room.entries:
            if e.get("unknown") or e.get("weeks") is None:
                unknown += 1
            else:
                known += 1
    return known, unknown


def validate_rooms(rooms: list[Room]) -> list[str]:
    errors: list[str] = []
    for room in rooms:
        if not room.entries:
            errors.append(f"{room.id}: 没有解析到任何课程")
        for e in room.entries:
            if not (1 <= e["day"] <= 7):
                errors.append(f"{room.id}: day 越界 {e}")
            if not (1 <= e["start"] <= e["end"] <= 12):
                errors.append(f"{room.id}: 节次越界 {e}")
            if not e.get("course"):
                errors.append(f"{room.id}: 课程名为空 {e}")
            if e.get("weeks") is not None:
                for a, b in e["weeks"]:
                    if not (1 <= a <= b <= 30):
                        errors.append(f"{room.id}: 周次越界 {e}")
    return errors


def spot_checks(rooms: list[Room]) -> list[str]:
    by_id = {room.id: room for room in rooms}
    errors: list[str] = []

    def has(room_id: str, day: int, start: int, end: int, course_part: str, week: int) -> bool:
        room = by_id.get(room_id)
        if not room:
            return False
        for e in room.entries:
            if e["day"] == day and e["start"] == start and e["end"] == end and \
                    course_part in e["course"] and e.get("weeks"):
                if any(a <= week <= b for a, b in e["weeks"]):
                    return True
        return False

    checks = [
        ("301", 1, 3, 4, "职业生涯规划", 14),
        ("404", 1, 1, 2, "模拟与数字信号处理", 1),
        ("410", 1, 5, 6, "数字时代管理理论与实践[27]", 10),
        ("308", 1, 7, 8, "概率论与数理统计B（智能学院）[04]", 5),
        ("308", 5, 11, 12, "马克思主义基本原理", 9),
        ("508", 1, 9, 12, "材料成型", 3),
    ]
    for args in checks:
        if not has(*args):
            errors.append("抽检失败: " + " ".join(map(str, args)))
    # 308 覆盖表必须 28 条且 0 unknown
    room308 = by_id.get("308")
    if room308:
        if len(room308.entries) != 28:
            errors.append(f"308 覆盖表条目数 {len(room308.entries)} != 28")
        unknown = [e for e in room308.entries if e.get("unknown")]
        if unknown:
            errors.append(f"308 覆盖表仍有 {len(unknown)} 条 unknown")
    return errors


def make_schedule(rooms: list[Room], meta_extra: dict, warnings: list[dict]) -> dict:
    known, unknown = entry_known_count(rooms)
    raw_total = sum(room.raw_count for room in rooms)
    dup_total = sum(room.duplicate_count for room in rooms)
    parser_unique = sum(len(room.entries) for room in rooms if room.status != "override") + \
        sum(room.raw_count for room in rooms if room.status == "override")
    # 上面只是展示用：解析唯一数 = 原始 - 重复（覆盖表前的口径）
    parser_unique = raw_total - dup_total
    day_dist: dict[str, int] = defaultdict(int)
    for room in rooms:
        for e in room.entries:
            if not e.get("unknown"):
                day_dist[str(e["day"])] += 1
    return {
        "meta": {
            "semester": meta_extra.get("semester", "2026-2027学年 秋季学期"),
            "generatedAt": dt.datetime.now().strftime("%Y-%m-%d %H:%M"),
            "pdfCount": meta_extra.get("pdf_count", len(rooms)),
            "roomCount": len(rooms),
            "missingRooms": MISSING_ROOMS,
            "excludedFiles": meta_extra.get("excluded", []),
            "rawEntryCount": raw_total,
            "duplicatesRemoved": dup_total,
            "parserUniqueCount": parser_unique,
            "entryCount": known,
            "unknownEntryCount": unknown,
            "manualOverrides": meta_extra.get("overrides", []),
            "defaults": {
                "week1Monday": DEFAULT_WEEK1_MONDAY,
                "currentWeekHint": CURRENT_WEEK_HINT,
                "periods": [{"start": a, "end": b} for a, b in DEFAULT_PERIODS],
            },
        },
        "rooms": [
            {
                "id": room.id,
                "name": room.name,
                "capacity": room.capacity,
                "status": room.status,
                **({"overrideSource": room.override_source} if room.override_source else {}),
                "entries": room.entries,
            }
            for room in sorted(rooms, key=lambda r: r.id)
        ],
        "warnings": warnings,
    }


# ==================== 页面生成 ====================

def inject_html(template: str, schedule: dict) -> str:
    logic_js = (TOOLS / "logic.js").read_text(encoding="utf-8")
    ui_js = (TOOLS / "ui.js").read_text(encoding="utf-8")
    data_json = json.dumps(schedule, ensure_ascii=False, separators=(",", ":"))
    data_json = data_json.replace("<", "\\u003c")
    data_script = "<script>window.SCHEDULE_DATA = " + data_json + ";</script>"
    logic_script = "<script>\n" + logic_js + "\n</script>"
    ui_script = "<script>\n" + ui_js + "\n</script>"
    output = template.replace("<!--__SCHEDULE_DATA__-->", data_script)
    output = output.replace("<!--__LOGIC_JS__-->", logic_script)
    output = output.replace("<!--__UI_JS__-->", ui_script)
    for token in ("__SCHEDULE_DATA__", "__LOGIC_JS__", "__UI_JS__"):
        if token in output:
            raise SystemExit(f"模板占位符未替换：{token}")
    return output


# ==================== 主流程 ====================

def main() -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description="Free Room Finder 课表构建")
    parser.add_argument("--pdftotext", default=None, help="Poppler pdftotext 路径")
    parser.add_argument("--pdf-dir", default=str(ROOT), help="PDF 目录")
    parser.add_argument("--out-json", default=str(DEFAULT_JSON))
    parser.add_argument("--out-html", default=str(DEFAULT_HTML))
    args = parser.parse_args()

    pdftotext = find_pdftotext(args.pdftotext)
    pdf_dir = Path(args.pdf_dir)
    pdfs = sorted(pdf_dir.glob("*.pdf"))
    if not pdfs:
        raise SystemExit(f"没有找到 PDF：{pdf_dir}")

    rooms: list[Room] = []
    excluded: list[dict] = []
    warnings: list[dict] = []
    semester = "2026-2027学年 秋季学期"
    signatures: dict[str, str] = {}

    print(f"Poppler: {pdftotext}")
    print(f"PDF: {len(pdfs)} 份")
    for pdf in pdfs:
        room, meta = parse_room(pdf, pdftotext)
        if room is None:
            excluded.append(meta)
            warnings.append({
                "room": pdf.stem, "kind": "excluded_file",
                "note": meta.get("reason", "文件无效"),
            })
            continue
        semester = meta.get("semester", semester)
        # 内容签名（去掉生成时间，避免同一课表因打印时间不同而漏检）
        xml = run_bbox(pdftotext, pdf)
        signature = hashlib.sha1(
            re.sub(r"\d{4}/\d{2}/\d{2}\s+\d{2}:\d{2}", "", xml).encode("utf-8")
        ).hexdigest()
        if signature in signatures:
            excluded.append({
                "file": pdf.name, "reason": f"内容与 {signatures[signature]} 重复",
            })
            warnings.append({
                "room": pdf.stem, "kind": "duplicate_file",
                "note": f"内容与 {signatures[signature]} 重复，已排除",
            })
            continue
        signatures[signature] = pdf.name
        rooms.append(room)
        warnings.extend(room.warnings)
        print(f"  {room.id}: {len(room.entries)} 条（raw {room.raw_count}, dup {room.duplicate_count}）")

    overrides = load_overrides()
    applied, override_warnings = apply_overrides(rooms, overrides)
    warnings.extend(override_warnings)
    # 覆盖表已替代该教室的解析结果，解析阶段的该教室告警不再展示
    applied_set = set(applied)
    warnings = [w for w in warnings if w.get("room") not in applied_set]

    errors = validate_rooms(rooms)
    if errors:
        print("\n校验失败：")
        for error in errors:
            print("  !", error)
        return 1
    # 抽检是针对当前学期的回归提示；换学期后课程变化不应阻塞构建
    checks = spot_checks(rooms)
    if checks:
        print("\n抽检提示（不阻塞构建）：")
        for check in checks:
            print("  ?", check)
        warnings.extend({"kind": "spot_check", "note": check} for check in checks)

    # 未消费片段单独计数，保留为 warning（不致命）
    unconsumed = [w for w in warnings if w.get("kind") == "unconsumed_spec_fragment"]
    if unconsumed:
        print(f"\n注意：{len(unconsumed)} 条疑似未归属的 spec 片段（见 warnings）")

    schedule = make_schedule(rooms, {
        "semester": semester,
        "pdf_count": len(pdfs),
        "excluded": excluded,
        "overrides": applied,
    }, warnings)
    known, unknown = entry_known_count(rooms)
    print(f"\n解析：raw {schedule['meta']['rawEntryCount']} / "
          f"dup {schedule['meta']['duplicatesRemoved']} / "
          f"parser unique {schedule['meta']['parserUniqueCount']}")
    print(f"最终：{known} 条已知 / {unknown} 条 unknown / {len(rooms)} 间教室")
    print(f"缺失课表：{', '.join(MISSING_ROOMS)}")
    print(f"覆盖表：{', '.join(applied) if applied else '无'}")
    if warnings:
        print(f"warnings：{len(warnings)} 条（详见 JSON）")
    # 310 的旧口径曾因分页重复高估 2 条；按可见课表校正为 34 条，
    # 故最终已知条目为 474 而不是计划初稿的 476。
    expected = 474
    if known != expected or unknown != 0:
        print(f"注意：最终计数与当前基准（{expected} 已知 / 0 unknown）不同，请核对数据是否变化。")

    out_json = Path(args.out_json)
    out_json.parent.mkdir(parents=True, exist_ok=True)
    out_json.write_text(json.dumps(schedule, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    template_path = TOOLS / "template.html"
    if not template_path.exists():
        raise SystemExit(f"缺少模板：{template_path}")
    output = inject_html(template_path.read_text(encoding="utf-8"), schedule)
    out_html = Path(args.out_html)
    out_html.write_text(output, encoding="utf-8", newline="\n")

    # GitHub Pages 站点入口：docs/ 由仓库分支直接发布，保持与本地产物同源
    site_html = ROOT / "docs" / "index.html"
    site_html.parent.mkdir(parents=True, exist_ok=True)
    site_html.write_text(output, encoding="utf-8", newline="\n")

    print(f"已生成：{out_json}")
    print(f"已生成：{out_html}")
    print(f"已生成：{site_html}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
