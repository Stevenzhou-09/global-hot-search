// Fetchers for all 11 sources. Ported faithfully from the original
// Muse Space version (server/src/actions.ts) — same endpoints, same
// parsing, same limits. Plain Node.js fetch, no third-party packages.
//
// Every fetcher resolves to:
//   { platform, label, region, ok, items: [{rank,title,heatLabel,url,extra}], error, note }

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

async function fetchText(url, ms = 15000) {
  const res = await fetch(url, {
    headers: { "User-Agent": UA, Accept: "*/*" },
    signal: AbortSignal.timeout(ms),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

async function fetchJson(url, ms = 15000) {
  const text = await fetchText(url, ms);
  return JSON.parse(text);
}

function isRecord(v) {
  return typeof v === "object" && v !== null;
}

export function formatHeat(n) {
  if (n >= 100_000_000) return `${(n / 100_000_000).toFixed(1).replace(/\.0$/, "")}亿`;
  if (n >= 10_000) return `${(n / 10_000).toFixed(1).replace(/\.0$/, "")}万`;
  return `${Math.round(n)}`;
}

function heatLabelOf(v) {
  if (typeof v === "number" && Number.isFinite(v) && v > 0) return formatHeat(v);
  if (typeof v === "string" && v.trim()) return v.trim();
  return null;
}

// ---------- Domestic platforms via the DailyHot aggregator ----------

export const DOMESTIC_PLATFORMS = [
  { key: "weibo", label: "微博", path: "weibo" },
  { key: "baidu", label: "百度", path: "baidu" },
  { key: "zhihu", label: "知乎", path: "zhihu" },
  { key: "douyin", label: "抖音", path: "douyin" },
  { key: "bilibili", label: "哔哩哔哩", path: "bilibili" },
  { key: "toutiao", label: "今日头条", path: "toutiao" },
];

async function fetchAggregator(p) {
  const base = { platform: p.key, label: p.label, region: "domestic", note: null };
  try {
    const json = await fetchJson(`https://hot.baiwumm.com/api/${p.path}`);
    if (!isRecord(json) || !Array.isArray(json.data)) throw new Error("bad response shape");
    const items = [];
    json.data.slice(0, 50).forEach((raw, i) => {
      if (!isRecord(raw) || typeof raw.title !== "string" || !raw.title.trim()) return;
      const url =
        typeof raw.url === "string" ? raw.url : typeof raw.mobileUrl === "string" ? raw.mobileUrl : null;
      items.push({
        rank: i + 1,
        title: raw.title.trim(),
        heatLabel: heatLabelOf(raw.hot),
        url,
        extra: null,
      });
    });
    if (items.length === 0) throw new Error("empty list");
    return { ...base, ok: true, items, error: null };
  } catch (e) {
    return { ...base, ok: false, items: [], error: e instanceof Error ? e.message : String(e) };
  }
}

async function fetchBaiduOfficial() {
  const json = await fetchJson("https://top.baidu.com/api/board?platform=wise&tab=realtime");
  if (!isRecord(json) || !isRecord(json.data) || !Array.isArray(json.data.cards)) {
    throw new Error("bad response shape");
  }
  const first = json.data.cards[0];
  if (!isRecord(first) || !Array.isArray(first.content)) throw new Error("no cards");
  const items = [];
  first.content.forEach((raw) => {
    if (!isRecord(raw) || !Array.isArray(raw.content)) return;
    raw.content.forEach((entry) => {
      if (!isRecord(entry) || typeof entry.word !== "string" || !entry.word.trim()) return;
      items.push({
        rank: items.length + 1,
        title: entry.word.trim(),
        heatLabel: entry.isTop === true ? "置顶" : null,
        url: typeof entry.url === "string" ? entry.url : null,
        extra: null,
      });
    });
  });
  return items.slice(0, 50);
}

// ---------- International sources ----------

const GT_GEOS = [
  { geo: "US", label: "美国" },
  { geo: "GB", label: "英国" },
  { geo: "JP", label: "日本" },
  { geo: "DE", label: "德国" },
  { geo: "IN", label: "印度" },
  { geo: "KR", label: "韩国" },
];

function parseTraffic(s) {
  const m = s.replace(/\+/g, "").trim().match(/^([\d.]+)\s*([KM])?$/i);
  if (!m || !m[1]) return 0;
  const n = parseFloat(m[1]);
  const unit = (m[2] ?? "").toUpperCase();
  return unit === "M" ? n * 1_000_000 : unit === "K" ? n * 1_000 : n;
}

function xmlField(block, tag) {
  const m = block.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
  if (!m || !m[1]) return null;
  return m[1]
    .replace(/^<!\[CDATA\[/, "")
    .replace(/\]\]>$/, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}

async function fetchGoogleTrends() {
  const base = {
    platform: "google_trends",
    label: "谷歌趋势",
    region: "international",
    note: "美国 · 英国 · 日本 · 德国 · 印度 · 韩国六国搜索趋势合并",
  };
  try {
    const perGeo = await Promise.allSettled(
      GT_GEOS.map(async (g) => {
        const xml = await fetchText(`https://trends.google.com/trending/rss?geo=${g.geo}`);
        const blocks = xml.split("<item>").slice(1);
        return blocks.map((b) => ({
          title: xmlField(b, "title") ?? "",
          traffic: xmlField(b, "ht:approx_traffic") ?? "",
          country: g.label,
        }));
      }),
    );
    const merged = new Map();
    for (const r of perGeo) {
      if (r.status !== "fulfilled") continue;
      for (const it of r.value) {
        if (!it.title) continue;
        const key = it.title.toLowerCase();
        const traffic = parseTraffic(it.traffic);
        const existing = merged.get(key);
        if (!existing) {
          merged.set(key, { title: it.title, traffic, trafficLabel: it.traffic, countries: [it.country] });
        } else {
          if (traffic > existing.traffic) {
            existing.traffic = traffic;
            existing.trafficLabel = it.traffic;
          }
          if (!existing.countries.includes(it.country)) existing.countries.push(it.country);
        }
      }
    }
    const items = [...merged.values()]
      .sort((a, b) => b.traffic - a.traffic)
      .slice(0, 50)
      .map((v, i) => ({
        rank: i + 1,
        title: v.title,
        heatLabel: v.trafficLabel ? `搜索量 ${v.trafficLabel}` : null,
        url: `https://trends.google.com/trending?geo=US`,
        extra: v.countries.join(" · "),
      }));
    if (items.length === 0) throw new Error("empty list");
    return { ...base, ok: true, items, error: null };
  } catch (e) {
    return { ...base, ok: false, items: [], error: e instanceof Error ? e.message : String(e) };
  }
}

function decodeEntities(s) {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .trim();
}

// X (Twitter) has no public trends API, so the worldwide trend list comes
// from trends24.in, a long-running mirror that republishes X's own global
// trending list as server-rendered HTML: the first trend-card list on the
// homepage is the current worldwide ranking, in order.
async function fetchTwitterTrends() {
  const base = {
    platform: "twitter",
    label: "X（推特）",
    region: "international",
    note: "全球趋势 · X 官方无公开接口，数据经 trends24 镜像",
  };
  try {
    const html = await fetchText("https://trends24.in/");
    const block = html.match(/<ol[^>]*trend-card__list[^>]*>([\s\S]*?)<\/ol>/);
    if (!block || !block[1]) throw new Error("trend list not found");
    const items = [];
    const seen = new Set();
    const re = /<a href="(https:\/\/twitter\.com\/search\?q=[^"]+)" class=trend-link>([\s\S]*?)<\/a>/g;
    let m;
    while ((m = re.exec(block[1])) !== null && items.length < 50) {
      const title = decodeEntities((m[2] ?? "").replace(/<[^>]+>/g, ""));
      const url = m[1] ?? null;
      if (!title || seen.has(title.toLowerCase())) continue;
      seen.add(title.toLowerCase());
      items.push({ rank: items.length + 1, title, heatLabel: null, url, extra: null });
    }
    if (items.length === 0) throw new Error("empty list");
    return { ...base, ok: true, items, error: null };
  } catch (e) {
    return { ...base, ok: false, items: [], error: e instanceof Error ? e.message : String(e) };
  }
}

async function fetchHackerNews() {
  const base = {
    platform: "hackernews",
    label: "Hacker News",
    region: "international",
    note: "全球科技社区实时热榜",
  };
  try {
    const ids = await fetchJson("https://hacker-news.firebaseio.com/v0/topstories.json");
    if (!Array.isArray(ids)) throw new Error("bad response shape");
    const top = ids.slice(0, 30).filter((x) => typeof x === "number");
    const fetched = await Promise.allSettled(
      top.map((id) => fetchJson(`https://hacker-news.firebaseio.com/v0/item/${id}.json`, 10000)),
    );
    const items = [];
    fetched.forEach((r) => {
      if (r.status !== "fulfilled" || !isRecord(r.value)) return;
      const v = r.value;
      if (typeof v.title !== "string" || !v.title.trim() || v.deleted === true) return;
      items.push({
        rank: items.length + 1,
        title: v.title.trim(),
        heatLabel: typeof v.score === "number" ? `${v.score} 分` : null,
        url:
          typeof v.url === "string"
            ? v.url
            : typeof v.id === "number"
              ? `https://news.ycombinator.com/item?id=${v.id}`
              : null,
        extra: null,
      });
    });
    if (items.length === 0) throw new Error("empty list");
    return { ...base, ok: true, items, error: null };
  } catch (e) {
    return { ...base, ok: false, items: [], error: e instanceof Error ? e.message : String(e) };
  }
}

async function fetchWikipedia(lang) {
  const base = {
    platform: `wikipedia_${lang}`,
    label: lang === "en" ? "维基百科（英文）" : "维基百科（中文）",
    region: "international",
    note: null,
  };
  try {
    // Wikimedia publishes pageviews with a lag: early in the UTC day,
    // "yesterday" often still 404s. Try yesterday first (same as the
    // original), then step back up to 3 days — the item extras and the
    // returned note always state the actual data date.
    let json = null;
    let y, m, day;
    let lastErr = null;
    for (let back = 1; back <= 3 && !json; back++) {
      const d = new Date(Date.now() - back * 86_400_000);
      y = d.getUTCFullYear();
      m = String(d.getUTCMonth() + 1).padStart(2, "0");
      day = String(d.getUTCDate()).padStart(2, "0");
      try {
        json = await fetchJson(
          `https://wikimedia.org/api/rest_v1/metrics/pageviews/top/${lang}.wikipedia/all-access/${y}/${m}/${day}`,
        );
      } catch (e) {
        lastErr = e;
      }
    }
    if (!json) throw lastErr ?? new Error("no pageviews data for the last 3 days");
    if (!isRecord(json) || !Array.isArray(json.items) || !isRecord(json.items[0]) || !Array.isArray(json.items[0].articles)) {
      throw new Error("bad response shape");
    }
    const skip = /^(Main_Page|主页|首頁|Wikipedia:|Special:|Help:|File:|Category:|维基百科:|特殊:|帮助:|檔案:|档案:)/;
    const items = [];
    for (const raw of json.items[0].articles) {
      if (items.length >= 25) break;
      if (!isRecord(raw) || typeof raw.article !== "string") continue;
      if (skip.test(raw.article)) continue;
      items.push({
        rank: items.length + 1,
        title: raw.article.replace(/_/g, " "),
        heatLabel: typeof raw.views === "number" ? `${formatHeat(raw.views)} 次阅读` : null,
        url: `https://${lang}.wikipedia.org/wiki/${raw.article}`,
        extra: `${y}-${m}-${day} 阅读量`,
      });
    }
    if (items.length === 0) throw new Error("empty list");
    return { ...base, ok: true, items, error: null, note: `数据日期 ${y}-${m}-${day}（维基官方隔日发布）` };
  } catch (e) {
    return { ...base, ok: false, items: [], error: e instanceof Error ? e.message : String(e) };
  }
}

// Fetch every source in parallel. Baidu gets a second chance via the
// official Baidu board API when the aggregator feed fails (same as original).
export async function fetchAllSources() {
  const results = await Promise.all([
    ...DOMESTIC_PLATFORMS.map((p) => fetchAggregator(p)),
    fetchGoogleTrends(),
    fetchTwitterTrends(),
    fetchHackerNews(),
    fetchWikipedia("en"),
    fetchWikipedia("zh"),
  ]);
  const baidu = results.find((r) => r.platform === "baidu");
  if (baidu && !baidu.ok) {
    try {
      const items = await fetchBaiduOfficial();
      if (items.length > 0) {
        baidu.ok = true;
        baidu.items = items;
        baidu.error = null;
      }
    } catch {
      // keep the aggregator failure recorded
    }
  }
  return results;
}

export { fetchText, fetchJson, decodeEntities };
