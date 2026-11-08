// Composite ranking — the anti-manipulation core, preserved faithfully
// from the original: titles are normalized and matched across platforms,
// and a topic scores rank points (51 − rank) from every platform carrying
// it, so no single platform's list — or its inflated heat numbers —
// decides the order.

export function normalizeTitle(t) {
  return t
    .toLowerCase()
    .replace(/#[^#]*#/g, "")
    .replace(/[\s\p{P}\p{S}]+/gu, "")
    .trim();
}

export const PLATFORM_LABELS = {
  weibo: "微博",
  baidu: "百度",
  zhihu: "知乎",
  douyin: "抖音",
  bilibili: "哔哩哔哩",
  toutiao: "今日头条",
  google_trends: "谷歌趋势",
  twitter: "X（推特）",
  hackernews: "Hacker News",
  wikipedia_en: "维基百科（英文）",
  wikipedia_zh: "维基百科（中文）",
};

export const PLATFORM_REGIONS = {
  weibo: "domestic",
  baidu: "domestic",
  zhihu: "domestic",
  douyin: "domestic",
  bilibili: "domestic",
  toutiao: "domestic",
  google_trends: "international",
  twitter: "international",
  hackernews: "international",
  wikipedia_en: "international",
  wikipedia_zh: "international",
};

export const PLATFORM_ORDER = [
  { platform: "weibo", region: "domestic" },
  { platform: "baidu", region: "domestic" },
  { platform: "zhihu", region: "domestic" },
  { platform: "douyin", region: "domestic" },
  { platform: "bilibili", region: "domestic" },
  { platform: "toutiao", region: "domestic" },
  { platform: "google_trends", region: "international" },
  { platform: "twitter", region: "international" },
  { platform: "hackernews", region: "international" },
  { platform: "wikipedia_en", region: "international" },
  { platform: "wikipedia_zh", region: "international" },
];

export const PLATFORM_NOTES = {
  google_trends: "美国 · 英国 · 日本 · 德国 · 印度 · 韩国六国搜索趋势合并",
  twitter: "全球趋势 · X 官方无公开接口，数据经 trends24 镜像",
  hackernews: "全球科技社区实时热榜",
};

export function buildComposite(items, filter) {
  const pool = items
    .filter((it) => filter === "all" || it.region === filter)
    .map((it) => ({ it, points: Math.max(0, 51 - it.rank), norm: normalizeTitle(it.title) }))
    .sort((a, b) => b.points - a.points);

  const groups = [];
  for (const { it, points, norm } of pool) {
    if (!norm) continue;
    let group = groups.find(
      (g) =>
        g.norm === norm ||
        (Math.min(g.norm.length, norm.length) >= 4 && (g.norm.includes(norm) || norm.includes(g.norm))),
    );
    if (!group) {
      group = { title: it.title, norm, score: 0, url: it.url, byPlatform: new Map() };
      groups.push(group);
    }
    const existing = group.byPlatform.get(it.platform);
    if (!existing) {
      group.byPlatform.set(it.platform, {
        platform: it.platform,
        label: PLATFORM_LABELS[it.platform] ?? it.platform,
        region: it.region,
        rank: it.rank,
        heatLabel: it.heatLabel,
        url: it.url,
      });
      group.score += points;
    } else if (it.rank < existing.rank) {
      group.score += Math.max(0, 51 - it.rank) - Math.max(0, 51 - existing.rank);
      existing.rank = it.rank;
      existing.heatLabel = it.heatLabel;
      existing.url = it.url;
    }
    if (!group.url && it.url) group.url = it.url;
  }
  return groups
    .map((g) => ({
      title: g.title,
      score: g.score,
      platformCount: g.byPlatform.size,
      url: g.url,
      appearances: [...g.byPlatform.values()].sort((a, b) => a.rank - b.rank),
    }))
    .sort((a, b) => b.score - a.score || b.platformCount - a.platformCount)
    .slice(0, 50);
}

// Build the /api/board response from the stored snapshot.
// store shape: { platforms: { [id]: { items, fetchedAt, origin } }, fetchLog: [...] }
export function buildBoard(store) {
  const allItems = [];
  const byPlatform = new Map();
  for (const { platform } of PLATFORM_ORDER) {
    const snap = store.platforms[platform];
    if (!snap || !Array.isArray(snap.items)) continue;
    const region = PLATFORM_REGIONS[platform];
    const items = snap.items.map((it) => ({
      region,
      platform,
      rank: it.rank,
      title: it.title,
      heatLabel: it.heatLabel ?? null,
      url: it.url ?? null,
      extra: it.extra ?? null,
    }));
    byPlatform.set(platform, items);
    allItems.push(...items);
  }

  const latestLog = new Map();
  for (const log of store.fetchLog ?? []) {
    if (!latestLog.has(log.source)) latestLog.set(log.source, log);
  }

  const fetchedTimes = [...byPlatform.keys()]
    .map((p) => store.platforms[p]?.fetchedAt)
    .filter(Boolean)
    .map((s) => new Date(s).getTime());
  const newestFetch = fetchedTimes.length > 0 ? new Date(Math.max(...fetchedTimes)) : null;

  return {
    fetchedAt: newestFetch ? newestFetch.toISOString() : null,
    sources: PLATFORM_ORDER.map(({ platform, region }) => {
      const log = latestLog.get(platform);
      const items = byPlatform.get(platform) ?? [];
      const snap = store.platforms[platform];
      return {
        platform,
        label: PLATFORM_LABELS[platform] ?? platform,
        region,
        ok: log ? log.ok === true : items.length > 0,
        count: items.length,
        fetchedAt: snap?.fetchedAt ?? (log ? log.fetchedAt : null),
        origin: snap?.origin ?? (log ? log.origin : null),
      };
    }),
    platforms: PLATFORM_ORDER.filter(({ platform }) => (byPlatform.get(platform) ?? []).length > 0).map(
      ({ platform, region }) => ({
        platform,
        label: PLATFORM_LABELS[platform] ?? platform,
        region,
        note:
          platform === "wikipedia_en" || platform === "wikipedia_zh"
            ? "维基官方隔日发布，此为昨日阅读量排名"
            : (PLATFORM_NOTES[platform] ?? null),
        items: (byPlatform.get(platform) ?? []).map((it) => ({
          rank: it.rank,
          title: it.title,
          heatLabel: it.heatLabel,
          url: it.url,
          extra: it.extra,
        })),
      }),
    ),
    composite: {
      fused: buildComposite(allItems, "all"),
      domestic: buildComposite(allItems, "domestic"),
      international: buildComposite(allItems, "international"),
    },
  };
}
