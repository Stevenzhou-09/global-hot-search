# Data Plan

## Context provenance
- `这个空间的热搜排名不应该向微博那样子被资本所垄断，也不应该像百度那样子被政治所垄断，他应该真正符合搜索热度` (prior user statement; shaped the core design: no single platform's list is presented as truth — the headline ranking is a transparent cross-platform composite where a topic scores by appearing on multiple independent platforms' real lists, with the contributing platforms shown on every row)
- `他也应该与全球接轨融合可以分开，国内热搜与国际热搜` (prior user statement; shaped the three-view structure: 综合榜 (fused), 国内榜， 国际榜， plus per-platform raw lists)
- `页面需要简洁页面也需要美观` (prior user statement; shaped the single-column editorial ranking layout, no dashboard clutter)
- Refresh trigger from build request: `每 15 分钟重新抓取一次各平台热搜数据，更新榜单和综合排名` (drives the refreshHotData action + 15-minute cron)

## Tested sources
### DailyHot 聚合 API (hot.baiwumm.com) — 微博/知乎/抖音/百度/B站/今日头条
**Used by**: refreshHotData (primary source for all six domestic platforms)
**Test command**: `curl -s 'https://hot.baiwumm.com/api/weibo'` (also /zhihu /douyin /baidu /bilibili /toutiao)
**Sample output**: `{code:200, data:[{title:'武大回应网传学生诱骗同学去缅甸', hot:1111264, url:'https://s.weibo.com/weibo?q=...'}, ...]}` — zhihu/douyin/baidu/bilibili/toutiao all returned code 200 with ranked title lists; weixin/kuaishou returned HTML/empty and are excluded
**Processing**: take top 50 per platform; keep title, platform rank, raw heat value when present, source URL

### 百度热搜官方接口 (top.baidu.com) — fallback/cross-check
**Used by**: refreshHotData (fallback if aggregator's baidu feed fails)
**Test command**: `curl -s 'https://top.baidu.com/api/board?platform=wise&tab=realtime'`
**Sample output**: `{success:true, data:{cards:[{content:[{word:'暴雪大暴雪 周六强度达巅峰', index:2, url:...}]}]}}`
**Processing**: extract word + index as rank

### 微博/知乎/抖音官方接口 — REJECTED (blocked)
**Test command**: `curl -s 'https://weibo.com/ajax/side/hotSearch'` → `{"error":"Forbidden"}`; zhihu api → AuthenticationError; douyin hot list → empty. Hence the aggregator above is the access path for these three.

### Google Trends RSS (trends.google.com) — 国际搜索趋势（多国）
**Used by**: refreshHotData (international: geo=US, GB, JP, DE, IN, KR)
**Test command**: `curl -s 'https://trends.google.com/trending/rss?geo=US'` (JP/DE also verified; geo=CN returns 400 and is excluded)
**Sample output**: RSS items with `<title>carson daly</title>`, `<ht:approx_traffic>1000+</ht:approx_traffic>`, pubDate, linked news item
**Processing**: parse title + approx_traffic per geo; merge geos into one Google Trends (全球） list ranked by traffic bucket, country tag kept per item

### trends24.in — X（推特）全球趋势镜像
**Used by**: refreshHotData (international: X/Twitter worldwide trends)
**Test command**: `curl -s 'https://trends24.in/'` — server-rendered HTML; the first `<ol class="trend-card__list">` is the current worldwide ranking (50 entries, verified live 2026-11-06 with real current trends)
**Why a mirror**: X has no public trends API (the official trends endpoint requires a paid developer account); trends24 republishes X's own global trending list. The platform tab and source footer label this honestly as 「全球趋势 · X 官方无公开接口，数据经 trends24 镜像」
**Processing**: parse the first trend-card list in order; keep title + the twitter.com/search link as the item URL; no tweet counts are published for the worldwide list, so heatLabel stays empty

### Hacker News 官方 API (hacker-news.firebaseio.com)
**Used by**: refreshHotData (international tech ranking)
**Test command**: `curl -s 'https://hacker-news.firebaseio.com/v0/topstories.json'` → array of story ids; titles fetched per item from /v0/item/<id>.json
**Sample output**: `[50390124, 50392118, ...]` (500 ids, order = current rank)
**Processing**: top 30 ids → fetch items → title, score, url

### Wikimedia Pageviews (wikimedia.org) — 维基百科热读（英/中）
**Used by**: refreshHotData (international reference list, labeled 昨日热读 since it lags one day)
**Test command**: `curl -s 'https://wikimedia.org/api/rest_v1/metrics/pageviews/top/en.wikipedia/all-access/2026/11/05'`
**Sample output**: `{items:[{articles:[{article:'2026_New_York_City_mayoral_election', views:532393, rank:1}, ...]}]}`
**Processing**: yesterday's date in UTC; filter out Special:/Main_Page utility pages; top 25 with view counts

## Box import channel (added 2026-11-08)
- **Primary fetch path**: an external Simular Box fetches all 11 sources itself (same endpoints tested above, verified on the Box with matching counts/titles) and posts each round to the new `importHotData` action: `{ fetchedAt (ISO), sources: [{ platform, ok, items: [{ rank, title, url, heatLabel }] }] }` with platform ids weibo/baidu/zhihu/douyin/bilibili/toutiao/google_trends/twitter/hackernews/wikipedia_en/wikipedia_zh.
- **Import semantics**: ok sources with ≥1 valid item replace that platform's snapshot (stored at the import's fetchedAt); ok=false, empty, or missing sources keep the previous snapshot and are logged as failed with a note — never overwritten with empty data. Unknown platform ids are rejected in the summary. The action returns per-source received/applied counts.
- **Provenance**: `fetch_log.origin` distinguishes the two channels — `box` for imports, `self` for local fetches — and `getBoard` exposes it per source; the footer renders 「Box 抓取」 vs 「本地兜底抓取」 so neither is ever passed off as the other.
- **Watchdog fallback**: `refreshHotData` (still on the hourly cron) first checks the latest `origin='box'` log time; if <90 minutes old it returns the current snapshot with `mode: "fresh_import"` and fetches nothing. Otherwise it runs the original full self-fetch (`mode: "fallback_fetch"`, logged as origin `self`). Composite ranking, platform set, and topic-detail generation are unchanged — composites are computed from snapshots at read time, so imports flow through the same scoring.

## Long-term data behavior
- **Refresh policy**: cron every 15 minutes calls refreshHotData, which fetches all sources in parallel, replaces the current snapshot rows per platform, recomputes composite rankings, and records a fetch log row (per-source ok/fail + counts + timestamp). A source that fails keeps its previous snapshot and is marked stale in the UI rather than vanishing. Manual refresh button calls the same action.
- **Growth**: only the latest snapshot per platform is kept (rows replaced each refresh); fetch log capped by pruning to the newest ~50 rows. No unbounded history.
- **Ordering**: composite rank by score desc; platform lists by platform rank asc.
- **Time semantics**: fetched_at stored as UTC instant, rendered viewer-local (Asia/Shanghai); Wikimedia list explicitly labeled with its data date.

## Composite ranking method (the anti-manipulation core)
- Normalize titles (strip #…#, punctuation, whitespace) and match the same topic across platforms by normalized-title equality/containment.
- Score = sum over platforms of rank points (51 − rank, min 0) — rank-based, so no platform's inflated heat numbers dominate — plus a cross-platform bonus: topics on ≥2 platforms surface with an 「N 个平台同时在热」 badge.
- Domestic composite uses the 6 domestic platforms; international composite uses Google Trends geos + HN + Wikipedia; the fused 综合榜 merges both pools with region tags. Every row links to its original platform page and lists which platforms carry it — the method is shown on the page so the ranking is auditable.

## Rejected approaches
- **Tried**: direct official APIs for Weibo/Zhihu/Douyin/Reddit/X
  **Why rejected**: Weibo Forbidden, Zhihu auth-gated, Douyin empty, Reddit network-blocked, X official trends API is paywalled. Aggregator + Google Trends + HN + Wikipedia cover the same ground with real data; X is covered via the trends24 mirror above instead of the official API.
- **Tried**: a second DailyHot mirror (api-hot.imsyy.top) as co-primary
  **Why rejected**: returned empty responses in probes; kept only as a code-level fallback attempt, not a relied-on source.

Imagery not needed: this is a text ranking product; platform identity is carried by typographic badges, and hot-topic thumbnails from aggregator CDNs are expiring signed URLs that would break — rows are designed to read clean without images.
