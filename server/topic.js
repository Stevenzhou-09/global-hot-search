// Topic detail (standalone version).
//
// The original Muse Space version used a proprietary hosted web-search
// tool plus an LLM to write the summary. This standalone version needs no
// API key and no LLM: it queries the keyless DuckDuckGo HTML endpoint,
// takes the returned titles/snippets as evidence, and builds an
// *extractive* summary from the snippets themselves (no invented facts).
// On any failure — search blocked, too few hits, unusable snippets — it
// honestly falls back to `links_only` with platform search links, exactly
// like the original's fallback.
import { decodeEntities, fetchText } from "./fetchers.js";

const MEDIA_NAMES = [
  [/thepaper\.cn/, "澎湃新闻"],
  [/people\.com\.cn/, "人民网"],
  [/xinhuanet\.com/, "新华社"],
  [/cctv\.com|cctvnews/, "央视新闻"],
  [/sina\.com\.cn/, "新浪新闻"],
  [/qq\.com/, "腾讯新闻"],
  [/163\.com/, "网易新闻"],
  [/sohu\.com/, "搜狐新闻"],
  [/ifeng\.com/, "凤凰网"],
  [/caixin\.com/, "财新"],
  [/jiemian\.com/, "界面新闻"],
  [/guancha\.cn/, "观察者网"],
  [/bbc\.com|bbc\.co\.uk/, "BBC"],
  [/reuters\.com/, "路透社"],
  [/apnews\.com/, "美联社"],
  [/nytimes\.com/, "纽约时报"],
  [/theguardian\.com/, "卫报"],
  [/cnn\.com/, "CNN"],
  [/bloomberg\.com/, "彭博社"],
  [/nikkei\.com/, "日经亚洲"],
  [/zhihu\.com/, "知乎"],
  [/weibo\.com/, "微博"],
  [/baidu\.com/, "百度"],
  [/wikipedia\.org/, "维基百科"],
];

export function mediaName(source, url) {
  const hay = `${source ?? ""} ${url}`;
  for (const [re, name] of MEDIA_NAMES) {
    if (re.test(hay)) return name;
  }
  if (source) return source.replace(/^www\./, "");
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "网络来源";
  }
}

export function fallbackLinks(title) {
  const q = encodeURIComponent(title);
  return [
    { title: `在微博搜索「${title}」`, source: "微博", url: `https://s.weibo.com/weibo?q=${q}` },
    { title: `在百度搜索「${title}」`, source: "百度", url: `https://www.baidu.com/s?wd=${q}` },
    { title: `在知乎搜索「${title}」`, source: "知乎", url: `https://www.zhihu.com/search?q=${q}` },
    { title: `在谷歌搜索「${title}」`, source: "谷歌", url: `https://www.google.com/search?q=${q}` },
  ];
}

function stripTags(s) {
  return decodeEntities(s.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

function unwrapDdgUrl(href) {
  try {
    const u = new URL(href.startsWith("//") ? `https:${href}` : href, "https://duckduckgo.com");
    const uddg = u.searchParams.get("uddg");
    if (uddg) return decodeURIComponent(uddg);
    return u.toString();
  } catch {
    return href;
  }
}

// Parse DuckDuckGo html endpoint results:
//   <a class="result__a" href="//duckduckgo.com/l/?uddg=...">Title</a>
//   <a class="result__snippet" ...>snippet…</a>
function parseDdgHtml(html) {
  const hits = [];
  const re = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  const snippetRe = /<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
  const snippets = [];
  let sm;
  while ((sm = snippetRe.exec(html)) !== null) snippets.push(stripTags(sm[1]));
  let m;
  let i = 0;
  while ((m = re.exec(html)) !== null && hits.length < 8) {
    const url = unwrapDdgUrl(m[1]);
    const title = stripTags(m[2]);
    if (!title || !/^https?:\/\//.test(url)) continue;
    hits.push({ title, url, source: null, snippet: snippets[i] ?? null });
    i += 1;
  }
  return hits;
}

// Parse the lite endpoint as a second chance (different markup).
function parseDdgLite(html) {
  const hits = [];
  const re = /<a[^>]*class="result-link"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  let m;
  while ((m = re.exec(html)) !== null && hits.length < 8) {
    const url = unwrapDdgUrl(m[1]);
    const title = stripTags(m[2]);
    if (!title || !/^https?:\/\//.test(url)) continue;
    hits.push({ title, url, source: null, snippet: null });
  }
  // Lite puts snippets in <td class="result-snippet">
  const snippetRe = /<td[^>]*class="result-snippet"[^>]*>([\s\S]*?)<\/td>/g;
  const snippets = [];
  let sm;
  while ((sm = snippetRe.exec(html)) !== null) snippets.push(stripTags(sm[1]));
  hits.forEach((h, idx) => {
    h.snippet = snippets[idx] ?? null;
  });
  return hits;
}

async function searchDuckDuckGo(title) {
  const q = encodeURIComponent(title);
  try {
    const html = await fetchText(`https://html.duckduckgo.com/html/?q=${q}`, 15000);
    const hits = parseDdgHtml(html);
    if (hits.length >= 2) return hits;
  } catch {
    // fall through to lite
  }
  const html = await fetchText(`https://lite.duckduckgo.com/lite/?q=${q}`, 15000);
  return parseDdgLite(html);
}

// Build an extractive summary purely from search snippets: take the most
// informative distinct snippets (prefer ones mentioning the title's core
// terms), join them in source order, and trim to a readable length.
// Nothing is paraphrased by a model and nothing is added.
function extractiveSummary(title, hits) {
  const seen = new Set();
  const parts = [];
  for (const h of hits) {
    if (!h.snippet) continue;
    let s = h.snippet.replace(/\s+/g, " ").trim();
    if (s.length < 30) continue;
    const key = s.slice(0, 40);
    if (seen.has(key)) continue;
    seen.add(key);
    // Attribute the snippet to its source so the summary stays honest.
    parts.push({ source: mediaName(h.source, h.url), text: s });
    if (parts.length >= 3) break;
  }
  if (parts.length === 0) return null;
  let summary = parts.map((p) => `据${p.source}报道，${p.text}`).join(" ");
  summary = summary.replace(/\s+([，。；：！？])/g, "$1");
  if (summary.length > 420) {
    summary = summary.slice(0, 420);
    const cut = Math.max(summary.lastIndexOf("。"), summary.lastIndexOf("；"));
    if (cut > 200) summary = summary.slice(0, cut + 1);
  }
  return summary.length >= 40 ? summary : null;
}

export async function generateTopicDetail(title) {
  let hits = [];
  try {
    hits = await searchDuckDuckGo(title);
  } catch {
    hits = [];
  }
  hits = hits.slice(0, 8);
  if (hits.length < 2) {
    return { status: "links_only", summary: null, links: fallbackLinks(title) };
  }
  const links = hits.slice(0, 6).map((h) => ({
    title: h.title,
    source: mediaName(h.source, h.url),
    url: h.url,
  }));
  const summary = extractiveSummary(title, hits);
  if (!summary) {
    return { status: "links_only", summary: null, links };
  }
  return { status: "ok", summary, links };
}
