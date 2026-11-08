// 全球热搜榜 — standalone server.
//
// Node.js built-ins only (node:http), no web framework: the API surface
// is four routes, and a framework would be dead weight. Serves the REST
// API and the built frontend (dist/) from one process.
//
//   GET  /api/board           current board (composites computed on read)
//   GET  /api/topic?title=... topic detail (cached; DDG search + fallback)
//   POST /api/refresh         fetch all 11 sources now
//   POST /api/import          accept an external fetcher's snapshot round
//
// Env: PORT (default 3000), REFRESH_MINUTES (default 60; 0 disables the
// in-process timer), DATA_FILE (default ./data/board.json).
import { createServer } from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { fetchAllSources } from "./fetchers.js";
import { PLATFORM_LABELS, PLATFORM_REGIONS, buildBoard, normalizeTitle } from "./ranking.js";
import { generateTopicDetail } from "./topic.js";
import { Store } from "./store.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DIST = join(ROOT, "dist");
const PORT = Number.parseInt(process.env.PORT ?? "3000", 10);
const REFRESH_MINUTES = Number.parseInt(process.env.REFRESH_MINUTES ?? "60", 10);
const DATA_FILE = process.env.DATA_FILE ?? join(ROOT, "data", "board.json");

const store = new Store(DATA_FILE);

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function readBody(req, maxBytes = 5_000_000) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > maxBytes) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

// ---------- refresh ----------
let refreshInFlight = null;

async function runRefresh() {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = (async () => {
    const now = new Date();
    const results = await fetchAllSources();
    for (const r of results) store.applyFetchResult(r, now.toISOString(), "self");
    store.save();
    return {
      ok: true,
      mode: "self_fetch",
      note: null,
      fetchedAt: now.toISOString(),
      sources: results.map((r) => ({
        platform: r.platform,
        label: r.label,
        ok: r.ok,
        count: r.items.length,
        error: r.error,
      })),
    };
  })();
  try {
    return await refreshInFlight;
  } finally {
    refreshInFlight = null;
  }
}

// ---------- import ----------
function sanitizeImport(body) {
  if (!body || typeof body !== "object") throw new Error("body must be a JSON object");
  if (typeof body.fetchedAt !== "string" || Number.isNaN(Date.parse(body.fetchedAt))) {
    throw new Error("fetchedAt must be an ISO date-time string");
  }
  if (!Array.isArray(body.sources) || body.sources.length < 1 || body.sources.length > 30) {
    throw new Error("sources must be an array of 1..30 entries");
  }
  for (const src of body.sources) {
    if (!src || typeof src.platform !== "string" || typeof src.ok !== "boolean" || !Array.isArray(src.items)) {
      throw new Error("each source needs platform (string), ok (boolean), items (array)");
    }
    if (src.items.length > 200) throw new Error("items per source must be <= 200");
  }
  return body;
}

function handleImport(body) {
  const parsed = new Date(body.fetchedAt);
  // A slightly future clock on the fetcher is fine; a wildly future one is not.
  const fetchedAt = parsed.getTime() > Date.now() + 5 * 60_000 ? new Date() : parsed;
  const fetchedAtIso = fetchedAt.toISOString();

  const summary = [];
  const seen = new Set();
  let appliedSources = 0;

  for (const src of body.sources) {
    const region = PLATFORM_REGIONS[src.platform];
    const label = PLATFORM_LABELS[src.platform] ?? src.platform;
    if (!region) {
      summary.push({ platform: src.platform, label, ok: false, received: src.items.length, applied: false, note: "未知平台标识，已忽略" });
      continue;
    }
    if (seen.has(src.platform)) {
      summary.push({ platform: src.platform, label, ok: false, received: src.items.length, applied: false, note: "同一轮导入中重复出现，已忽略" });
      continue;
    }
    seen.add(src.platform);

    // Sanitize: drop blank titles, dedupe ranks (first wins), sort by rank.
    const clean = [];
    const usedRanks = new Set();
    for (const it of src.items) {
      if (!it || typeof it.title !== "string" || !Number.isInteger(it.rank)) continue;
      const title = it.title.trim().slice(0, 500);
      if (!title || usedRanks.has(it.rank) || it.rank < 1 || it.rank > 999) continue;
      usedRanks.add(it.rank);
      clean.push({
        rank: it.rank,
        title,
        heatLabel: typeof it.heatLabel === "string" && it.heatLabel.trim() ? it.heatLabel.trim().slice(0, 200) : null,
        url: typeof it.url === "string" && it.url.trim() ? it.url.trim().slice(0, 2048) : null,
        extra: typeof it.extra === "string" && it.extra.trim() ? it.extra.trim().slice(0, 500) : null,
      });
    }
    clean.sort((a, b) => a.rank - b.rank);

    if (src.ok && clean.length > 0) {
      store.data.platforms[src.platform] = { items: clean, fetchedAt: fetchedAtIso, origin: "import" };
      store.logOnly({ source: src.platform, ok: true, count: clean.length, error: null, origin: "import", fetchedAt: fetchedAtIso });
      appliedSources += 1;
      summary.push({ platform: src.platform, label, ok: true, received: clean.length, applied: true, note: null });
    } else {
      const error = src.ok
        ? "导入的条目为空或全部无效，保留上一次数据"
        : (typeof src.error === "string" && src.error ? src.error.slice(0, 500) : "外部抓取报告该来源失败，保留上一次数据");
      store.logOnly({ source: src.platform, ok: false, count: 0, error, origin: "import", fetchedAt: fetchedAtIso });
      summary.push({ platform: src.platform, label, ok: false, received: clean.length, applied: false, note: error });
    }
  }

  for (const platform of Object.keys(PLATFORM_LABELS)) {
    if (!seen.has(platform)) {
      summary.push({
        platform,
        label: PLATFORM_LABELS[platform],
        ok: false,
        received: 0,
        applied: false,
        note: "本次导入未包含该平台，保留上一次数据",
      });
    }
  }

  store.save();
  return { ok: true, fetchedAt: fetchedAtIso, receivedSources: body.sources.length, appliedSources, sources: summary };
}

// ---------- topic ----------
async function handleTopic(title) {
  const key = normalizeTitle(title) || title.trim().toLowerCase();
  const now = Date.now();
  const cached = store.getTopic(key);
  if (cached) {
    const ageMs = now - new Date(cached.generatedAt).getTime();
    const ttlMs = cached.status === "ok" ? 6 * 3_600_000 : 30 * 60_000;
    if (ageMs < ttlMs) return { ...cached, title, cached: true };
  }
  const detail = await generateTopicDetail(title);
  const value = {
    status: detail.status,
    summary: detail.summary,
    links: detail.links,
    generatedAt: new Date(now).toISOString(),
  };
  store.putTopic(key, value);
  store.save();
  return { ...value, title, cached: false };
}

// ---------- static frontend ----------
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
};

function serveStatic(req, res, pathname) {
  let rel = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  let file = normalize(join(DIST, rel));
  if (!file.startsWith(DIST) || !existsSync(file) || !statSync(file).isFile()) {
    // SPA fallback
    file = join(DIST, "index.html");
    rel = "index.html";
  }
  if (!existsSync(file)) {
    res.writeHead(503, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Frontend not built yet. Run: npm run build\n");
    return;
  }
  const body = readFileSync(file);
  res.writeHead(200, {
    "Content-Type": MIME[extname(rel)] ?? "application/octet-stream",
    "Content-Length": body.length,
    "Cache-Control": rel === "index.html" ? "no-cache" : "public, max-age=31536000, immutable",
  });
  res.end(req.method === "HEAD" ? undefined : body);
}

// ---------- server ----------
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const path = url.pathname;

    if (path === "/api/board" && req.method === "GET") {
      return json(res, 200, buildBoard(store.data));
    }
    if (path === "/api/topic" && req.method === "GET") {
      const title = (url.searchParams.get("title") ?? "").trim();
      if (!title || title.length > 300) return json(res, 400, { error: "title query param required (1..300 chars)" });
      return json(res, 200, await handleTopic(title));
    }
    if (path === "/api/refresh" && req.method === "POST") {
      return json(res, 200, await runRefresh());
    }
    if (path === "/api/import" && req.method === "POST") {
      let body;
      try {
        body = sanitizeImport(JSON.parse(await readBody(req)));
      } catch (e) {
        return json(res, 400, { error: e instanceof Error ? e.message : String(e) });
      }
      return json(res, 200, handleImport(body));
    }
    if (path.startsWith("/api/")) {
      return json(res, 404, { error: "unknown API route" });
    }
    if (req.method === "GET" || req.method === "HEAD") {
      return serveStatic(req, res, path);
    }
    res.writeHead(405);
    res.end();
  } catch (e) {
    console.error("request failed:", e);
    if (!res.headersSent) json(res, 500, { error: "internal error" });
  }
});

server.listen(PORT, () => {
  console.log(`全球热搜榜 listening on http://localhost:${PORT}`);
  console.log(`data file: ${DATA_FILE}`);

  // Fetch on start when the snapshot is empty or stale.
  const newest = store.newestFetchedAt();
  const staleMs = REFRESH_MINUTES > 0 ? REFRESH_MINUTES * 60_000 : 0;
  if (!newest || (staleMs > 0 && Date.now() - newest.getTime() >= staleMs)) {
    runRefresh()
      .then((r) => console.log(`initial refresh: ${r.sources.filter((s) => s.ok).length}/${r.sources.length} sources ok`))
      .catch((e) => console.error("initial refresh failed:", e));
  }
  if (REFRESH_MINUTES > 0) {
    const timer = setInterval(() => {
      runRefresh().catch((e) => console.error("scheduled refresh failed:", e));
    }, REFRESH_MINUTES * 60_000);
    timer.unref();
    console.log(`auto-refresh every ${REFRESH_MINUTES} minute(s)`);
  }
});
