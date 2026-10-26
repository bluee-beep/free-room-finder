# CLAUDE.md — Free Room Finder

本目录是一个离线空教室查询工具：把教室课表 PDF 解析成结构化数据，再生成一个自包含 HTML 供学生自习选教室。公开站点：<https://bluee-beep.github.io/free-room-finder/>（仓库 `bluee-beep/free-room-finder`，`main` 分支 `/docs` 目录）。

## 目录结构

```
free-room-finder/
├── 空教室查询.html          # 生成物：本地双击入口
├── docs/
│   ├── index.html           # 生成物：GitHub Pages 入口（与本地入口同源）
│   └── .nojekyll            # 关闭 Jekyll 处理
├── data/
│   ├── schedule.json        # 生成物：结构化课表 + 元数据 + warnings
│   └── overrides/
│       └── 308.json         # 308 的手工核对覆盖表（权威数据）
├── tools/
│   ├── build.py             # PDF 解析、覆盖合并、JSON/HTML 生成、审计
│   ├── template.html        # 页面骨架 + 全部 CSS（含注入占位符）
│   ├── logic.js             # 纯调度逻辑（日期/周次/占用/空档），Node 可测
│   ├── ui.js                # DOM 渲染、筛选、设置、持久化、此刻刷新
│   └── test_logic.js        # Node 断言测试
├── README.md                # 使用/更新/依赖说明
├── CLAUDE.md                # 本文件
├── CHANGELOG.md             # 变更日志（版本历史）
├── .gitignore               # 排除 *.pdf、versions/ 等含个人信息的本地产物
├── versions/
│   └── v1.1.3_2026-10-26/   # 完整版本快照（只读存档，仅本地）
└── *.pdf                    # 原始教室课表（只读数据源，不入公开仓库）
```

## 数据流

```
教室 PDF (29 份)
   │  tools/build.py: Poppler pdftotext -enc UTF-8 -bbox-layout
   ▼
行状态机解析（按星期列、按行坐标；修交错/跨页/拆行）
   │  data/overrides/308.json 覆盖 308 的解析条目
   ▼
data/schedule.json（meta/rooms/warnings）
   │  tools/template.html + logic.js + ui.js 内联注入
   ▼
空教室查询.html（本地入口） + docs/index.html（GitHub Pages 入口）
```

## 关键设计决策

1. **单文件产物**：用户只需双击；数据、CSS、JS 全部内联，无 CDN/网络请求，`file://` 可用。
2. **行状态机而非整列拼接**：PDF 跨页/交错会让“第6节”排到下一门课名之后。解析按 `<line>` 坐标收集 spec 续行：
   - spec 以周次 token 开头的行作为锚点；
   - 只把 spec-like 行并入，跳过课程名/教师行；
   - `第N节-` 只接受同一单元格附近的纯节次续行；
   - 支持“11-12”+“周,...”拆行、课程名+周次同一行、跨块课程名续接。
3. **308 覆盖表**：308.pdf 文本交错最严重，用户提供了图片版和缺失条目详情图。`data/overrides/308.json` 的 28 条为权威数据；构建仍解析 PDF 取教室名/容量，但条目以覆盖表为准。替换 308.pdf 后需同步核对覆盖表。
4. **三态与保守 unknown**：空闲/占用/未知。源数据缺周次或节次的条目 `unknown:true`，按全学期占用，永不进入空闲窗口；UI 用灰色斜纹 + “?” 标注。当前数据 0 条 unknown（308 已由覆盖表补全）。
5. **计数口径**：解析原始 528 条，分页重复 58 条，解析唯一 470 条；308 覆盖表把解析的 24 条替换为 28 条，最终 **474 条已知**。310 的 34 条按可见课表校正（旧口径 36 含 2 条分页重复）。构建脚本会打印实际计数，偏离 474 时给出提示。
6. **默认配置**：第 1 周周一 `2026-08-31`（今天 2026-10-26 = 第 9 周）；12 节作息时间来自用户提供版本；设置存 `localStorage`（键 `silesia-free-room-settings-v1`），`file://` 下可能受限，UI 有降级提示。
7. **UI**：列表（默认）按最长符合条件空档排序；总览表为教室 × 12 节矩阵；支持连空阈值、此刻空闲、**下一大节**、显示全部、搜索、日期切换、URL 调试参数。总览表使用**页面级纵向滚动**：`body.table-view` 下顶栏改为 static；表头是独立的吸顶容器 `.matrix-head-wrap`（不在横向滚动容器内），表身 `.matrix-body-scroll` 横向滚动并用 `scroll` 事件同步表头横向位置；桌面端表格占满视口，手机端表身横向滑动但表头始终吸顶。所有课程名/教室名用 `textContent` 写入，禁止拼 `innerHTML`。
8. **下一大节（连堂 2 节）**：固定按 `1-2 / 3-4 / 5-6 / 7-8 / 9-10 / 11-12` 分块。`logic.js` 的 `nextBlock(now)` 返回下一个完整大节：
   - 当前在某一大节内 → 再下一个完整大节；
   - 课间/课前 → 若下一节是该块第一节，取该块；若下一节是第二节（本块已过半），取再下一个完整块；
   - 最后一节之后 → `null`。
   UI 的“下一大节”筛选只保留该块**两节都空**的教室（`isBlockFree`），顶部显示块时间，卡片带徽标，总览表用绿框标出这两节。
9. **文件一致性**：构建校验文件名与 PDF 内部教室号一致，并检查归一化内容签名重复；不合格文件不进入可用列表。当前 29 份均有效（原 404 曾是 403 复制，已替换）。
10. **公开发布与隐私**：仓库 `bluee-beep/free-room-finder` 公开，站点由 GitHub Pages 从 `main` 分支 `/docs` 发布。源 PDF 含任课教师姓名，`*.pdf` 与含 PDF 的 `versions/` 均被 `.gitignore` 排除；308 覆盖表已删除手工教师字段。构建把同一份内联 HTML 写到 `空教室查询.html` 与 `docs/index.html`，推送即上线。教室显示名去掉楼名前缀（解析正则需要保留原文匹配）。
11. **品牌命名**：对外名称统一为 **Free Room Finder**（英文），页面标题、H1、品牌图标（FR）一致；不在用户可见文案中使用原机构名。
12. **移动端安全区**：`viewport-fit=cover` 必须保留，否则 `env(safe-area-inset-*)` 恒为 0。顶栏用 `padding-top/left/right` 铺开背景并避让灵动岛/刘海，`.app` 与 toast 用 `calc(... + var(--safe-bottom))` 避让 Home 指示条；表格视图的吸顶表头用 `top: var(--safe-top)`，不要再加 `padding-top`（会在未吸顶时留白）。改动顶栏布局时需同时回归 iPhone 竖屏、横屏与总览表。

## 构建与测试命令

```bash
# 解析全部 PDF，生成 data/schedule.json + 空教室查询.html
py -3 tools/build.py

# 逻辑回归测试（29 间 / 474 条已知 / 0 unknown；空档、占用、unknown、下一大节、筛选、当前节次）
node tools/test_logic.js
```

构建依赖 Poppler `pdftotext`（需支持 `-bbox-layout`）；`find_pdftotext()` 会依次尝试 `--pdftotext`、PATH、Winget 安装目录。Python 仅使用标准库。

## 版本管理

- 根目录是工作区；`versions/` 存放只读版本快照。
- 每次发布：更新 `CHANGELOG.md`，创建 `versions/vX.Y.Z_YYYY-MM-DD/`，复制 HTML、`data/`、`tools/`、README/CLAUDE/CHANGELOG 与 29 份 PDF，生成 `VERSION.md`、`PDF_MANIFEST.txt`、`SHA256SUMS.txt`。
- 快照可独立打开和重新构建；不要修改快照文件。
- 当前稳定版：**v1.1.3（2026-10-26）**，快照 `versions/v1.1.3_2026-10-26/`（仅本地，不入库）。

## 已知数据事实

- 29 间教室；缺 306/406/408/506 的 PDF。
- 404 已是正确的 404 教室课表（内部标题 404，3 页）。
- 308 覆盖表 28 条：周一 5–6 形势与政策Ⅰ（7–8、11 周）、周二 7–8（11、13–14 周）、周三 5–6（7–8、11、13–14 周）、周五 11–12 马原（9–14 周）。
- 310 周三 11–12 优化与决策（6–9 周）、410 周三 11–12 优化与决策（6–9 周）等跨块课程名已由“续名合并”修复。
- 3 条 `inferred_end`：310 两处、504 一处，节次范围在 PDF 截断，按相邻 2 节补全（README/设置里可见）。

## 约定

- 用户可见文案、注释、日志使用中文；变量/函数/文件名使用英文。
- 不引入前端框架、构建工具、网络字体；保持离线单文件。
- 修改 `tools/template.html` / `logic.js` / `ui.js` 后，可只重注入（无需重新解析 PDF）：
  ```python
  python -c "import json,sys; from pathlib import Path; sys.path.insert(0,'tools'); import build; d=json.loads(Path('data/schedule.json').read_text(encoding='utf-8')); Path('空教室查询.html').write_text(build.inject_html(Path('tools/template.html').read_text(encoding='utf-8'), d), encoding='utf-8')"
  ```
  若改了 PDF 或覆盖表，请重新运行 `py -3 tools/build.py`。
- **站点同步**：完整构建会自动写 `docs/index.html`；若只用上面的重注入片段，必须同时把结果复制到 `docs/index.html`，否则线上会滞后。`docs/.nojekyll` 不可删除。
- **不入库的文件**：`*.pdf` 与 `versions/` 含教师姓名与个人信息，仅保留在本地，不要 `git add -f`。
