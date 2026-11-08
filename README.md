# 全球热搜榜 · Global Hot Search

一个**跨平台综合热搜榜**：同时抓取 11 个平台的公开热榜，用一套透明的跨平台计分算法算出综合排名——不照搬任何单一平台的榜单顺序，让任何一个平台（无论是靠资本撤热搜、买热搜，还是靠 editorial 意志压榜）都无法单独决定你看到的排名。

提供三个综合视图（综合榜 / 国内榜 / 国际榜）+ 每个平台的原始榜单，点开任何话题可以看到它在各平台的名次，以及一段根据公开搜索结果自动整理的话题汇总。

线上原型最初是作者在 Muse 里自用的一个 Space（见文末「与原版的关系」），**本仓库是完全独立、可自托管的开源版本：用你自己的算力跑，不依赖任何私有服务，不需要任何 API Key。**

## 为什么排名不被单一平台操纵

- **只认名次，不认各家的「热度值」**：每条话题在每个上榜平台得 `51 − 名次` 分（第 1 名 50 分、第 50 名 1 分），综合热度 = 它在所有平台得分之和。各平台自己标的热度数字（经常注水、口径各异）完全不进公式。
- **跨平台才算真热**：标题先做归一化（转小写、去掉 `#…#`、去掉空白/标点/符号），同一话题在不同平台的写法用「归一化后相等或互相包含（较短一方长度 ≥ 4）」匹配合并。一个话题同时出现在越多独立平台，分数天然越高；只红在一个平台的话题，排不过全网都在讨论的话题。
- **可核查**：每一行都标明它在哪些平台上榜、各第几名，页脚列出每个来源的抓取状态和时间。算法就在 `server/ranking.js` 里，不到 200 行，随便审计。
- **失败不造假**：某个来源抓失败时，保留它上一次的数据并在页脚如实标注，绝不用空数据覆盖、也不拿旧数据冒充新数据。

## 数据来源（11 个）

| 平台 | 区域 | 接口 | 说明 |
|---|---|---|---|
| 微博 | 国内 | DailyHot 聚合 `hot.baiwumm.com/api/weibo` | 微博官方接口拒绝未登录访问，故走聚合 |
| 百度 | 国内 | 同上 `/baidu`，失败时官方 `top.baidu.com/api/board` 兜底 | |
| 知乎 | 国内 | 同上 `/zhihu` | 知乎官方接口需登录 |
| 抖音 | 国内 | 同上 `/douyin` | |
| 哔哩哔哩 | 国内 | 同上 `/bilibili` | |
| 今日头条 | 国内 | 同上 `/toutiao` | |
| 谷歌趋势 | 国际 | `trends.google.com/trending/rss?geo=…` | 美国、英国、日本、德国、印度、韩国六国 RSS 按搜索量合并 |
| X（推特） | 国际 | `trends24.in` 镜像 | **X 官方没有公开趋势接口**（官方 API 需付费开发者账号），trends24 是长期运行的 X 全球趋势镜像站；页面中如实标注 |
| Hacker News | 国际 | `hacker-news.firebaseio.com/v0` 官方 API | 前 30 条 |
| 维基百科（英文） | 国际 | Wikimedia Pageviews API | **昨日**阅读量前 25（维基官方隔日发布；若昨日数据尚未发布会自动回退到更早一天，并标注实际日期） |
| 维基百科（中文） | 国际 | 同上 | 同上 |

数据源的完整调研记录（包括试过但被拒绝的官方接口）见 `docs/DATA-PLAN-original.md`。

## 快速开始

需要 Node.js ≥ 20（用了全局 `fetch` 与 `AbortSignal.timeout`），不需要任何 API Key：

```bash
git clone <this-repo-url> global-hot-search
cd global-hot-search
npm install
npm run build     # 构建前端到 dist/
npm start         # 启动：API + 前端在同一个进程，默认 http://localhost:3000
```

启动时如果本地还没有快照（或快照已过期），会自动先抓一轮；之后每 `REFRESH_MINUTES` 分钟自动刷新。页面上的「刷新」按钮也可以随时手动抓一轮。

Docker：

```bash
docker build -t global-hot-search .
docker run -p 3000:3000 -v ghs-data:/app/data global-hot-search
```

## 配置

见 `.env.example`（全部可选项，没有任何密钥类配置）：

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | `3000` | 监听端口 |
| `REFRESH_MINUTES` | `60` | 进程内自动刷新间隔（分钟）；`0` = 关掉定时器 |
| `DATA_FILE` | `./data/board.json` | 快照文件路径（一般不用改） |

## API

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/board` | 当前榜单：三个综合榜 + 各平台原榜 + 每家来源状态（含 `origin`：`self` 本机自抓 / `import` 外部导入） |
| GET | `/api/topic?title=…` | 话题详情：用免 Key 的 DuckDuckGo 公开搜索取标题/摘要，做**摘录式**汇总（只拼接来源原文摘要并注明出处，不经过大模型、不编造）；搜不到时诚实返回 `links_only` + 各平台搜索页链接。结果缓存 6 小时（失败缓存 30 分钟） |
| POST | `/api/refresh` | 立即全量自抓一轮，返回每家 `ok/count/error` |
| POST | `/api/import` | 接收外部抓取器的一轮数据（格式见下）；成功的来源替换快照，失败/缺失的来源保留上一次数据 |

导入格式（与 `fetcher/fetch_hot.py` 的输出一致）：

```json
{
  "fetchedAt": "2026-11-08T03:00:00Z",
  "sources": [
    { "platform": "weibo", "ok": true,
      "items": [ { "rank": 1, "title": "…", "url": "https://…", "heatLabel": "123万", "extra": null } ] }
  ]
}
```

## 可选：独立的 Python 抓取器

`fetcher/fetch_hot.py` 只用 Python 标准库，在任何机器上都能跑出与服务端自抓完全相同的一轮快照：

```bash
python3 fetcher/fetch_hot.py --out snapshot.json                    # 写快照文件
python3 fetcher/fetch_hot.py --post http://localhost:3000/api/import  # 直接导入到服务
```

适合把抓取放在另一台机器/另一个定时任务里（例如一台常开的小主机），看板服务只负责排名与展示。抓取和展示用谁的算力，由你自己决定。

另一个选择是 `fetcher/fetch_hot_direct.py`：这是作者最初在外部机器上跑的原始抓取脚本，国内六家直接抓各平台自己的接口（不用聚合站），输出同格式的 `snapshot.json`。它能不能抓通取决于你的网络出口（有些官方接口会拒绝机房 IP），可与上一个抓取器互为对照和备选。

## 架构

```
client/            React + Vite + Tailwind 前端（原版界面，改用 REST 调用）
server/
  index.js         HTTP 服务（Node 内置模块，零框架）：4 个 API + 静态托管 + 定时刷新
  fetchers.js      11 个来源的抓取（与原版逐一对应的接口与解析）
  ranking.js       标题归一化 + 跨平台综合排名（核心算法）
  topic.js         话题详情：DuckDuckGo 搜索 → 摘录式汇总 / links_only 兜底
  store.js         文件快照存储（原子写）
fetcher/           可选的独立 Python 抓取器（标准库）
data/board.json    唯一的运行时状态：各平台快照 + 抓取日志（上限 200 条）+ 话题缓存
```

几个刻意的取舍：

- **后端零框架、零运行时依赖**：API 只有 4 条路由，Node 内置 `http` 足够，少一层供应链风险；唯一的运行时 npm 依赖是前端的 React / React Query。
- **存储用 JSON 文件而不是数据库**：数据量只有约 460 条快照 + 有界日志，一个可读、可备份、删掉即重置的文件是最省事的选择；写入走临时文件 + rename 原子替换。
- **综合榜在读取时实时计算**：快照只存各平台原榜，排名永远由同一份算法从原榜算出，导入和自抓两条通道自动共用同一套排名。

## 与原版（Muse Space）的关系

原版是作者在 [Muse](https://muse.ai) 里使用的个人 Space，依赖 Muse 私有的 Space SDK、托管搜索和大模型推理，代码离开 Muse 无法运行。**本仓库是它的独立重写版**：抓取接口、排名算法、界面布局逐一对应原版，凡是依赖私有能力的地方都换成了公开替代——

- Space SDK 的 action 调用 → 本仓库的 REST API；
- 话题汇总的大模型生成 → DuckDuckGo 搜索结果的摘录式汇总（效果更朴素：它只引用来源摘要原文，不做改写综述；搜不到就 `links_only`）；
- 原版的外部 Box 抓取通道 → 本仓库的 `/api/import` + `fetcher/fetch_hot.py`，任何机器都能当抓取端；
- 存储从托管数据库 → 本地 `data/board.json`。

本机自抓和外部导入在页脚分别标注「本机自抓 / 外部导入」，和原版一样不混淆来源。

## 许可证

[MIT](LICENSE) © 2026 Steven Zhou

数据来自各平台公开页面与其公开接口，版权归各来源所有；本项目只做聚合与排名展示。请遵守各数据源的服务条款，控制抓取频率（默认每小时一轮已经很克制）。

---

## English

**Global Hot Search** is a cross-platform composite trending board. It fetches the public hot lists of 11 platforms — Weibo, Baidu, Zhihu, Douyin, Bilibili and Toutiao (via the DailyHot aggregator, with Baidu's official API as fallback), Google Trends (US/GB/JP/DE/IN/KR RSS merged), X/Twitter (via the trends24 mirror, because X offers no public trends API), Hacker News (official API), and English/Chinese Wikipedia (yesterday's pageviews) — and ranks topics with one transparent rule:

> A topic earns `51 − rank` points from every platform that carries it. Rank points only — never a platform's self-reported (and often inflated) "heat" numbers. Titles are normalized and matched across platforms, so a topic discussed everywhere outranks a topic that is merely #1 on one platform whose operator can promote or bury stories at will.

Every row shows exactly which platforms carry the topic and at what rank, and the footer reports each source's fetch status — the ranking is fully auditable (`server/ranking.js`, under 200 lines).

**Run it yourself** (Node.js ≥ 20, no API keys, your own compute):

```bash
npm install
npm run build
npm start          # http://localhost:3000, auto-refreshes hourly
```

Or with Docker: `docker build -t global-hot-search . && docker run -p 3000:3000 global-hot-search`.

Configuration is just `PORT` and `REFRESH_MINUTES` (see `.env.example`). The server exposes `GET /api/board`, `GET /api/topic?title=…`, `POST /api/refresh`, and `POST /api/import` (for an external fetcher — a dependency-free Python one is included in `fetcher/`). State lives in a single JSON file, `data/board.json`.

This is the standalone open-source rewrite of a personal [Muse](https://muse.ai) Space: same sources, same ranking algorithm, same UI — with every proprietary dependency (hosted SDK, hosted search, LLM summarization) replaced by a public, keyless alternative. Topic summaries here are *extractive* (stitched from search-result snippets with attribution, falling back to plain search links when search yields too little), not LLM-written.

MIT License © 2026 Steven Zhou. All data belongs to its respective sources; please respect their terms and keep fetch rates modest.
