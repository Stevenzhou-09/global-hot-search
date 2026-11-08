#!/usr/bin/env python3
"""Direct-endpoint fetcher — the original script that ran on the author's
external box, fetching the domestic platforms from their own endpoints
(Weibo ajax, Baidu board, Zhihu hot-list, Douyin hot search, Bilibili
popular, Toutiao hot board) instead of an aggregator.

Included for reference and as an alternative fetcher: whether the direct
endpoints answer depends on your network egress (they answered from the
author's box; some reject datacenter IPs). Two small changes from the
original: (1) output location — it wrote to a hardcoded box path, here it
writes snapshot.json + snapshot.json.gz.b64 to the current directory;
(2) the Wikipedia fetcher falls back to 2–3 days ago when yesterday's
pageviews are not published yet (the original only tried yesterday).
The snapshot JSON shape is exactly what POST /api/import accepts.
"""
import json, re, time, urllib.request, urllib.parse, xml.etree.ElementTree as ET, gzip, base64
from datetime import datetime, timedelta, timezone

UA = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"}
HT = {"http://schemas.google.com/trends/2024": "ht", "https://trends.google.com/trending/rss": "ht"}

def fetch(url, headers=None, timeout=20):
    h = dict(UA); h.update(headers or {})
    req = urllib.request.Request(url, headers=h)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()
def get_json(url, headers=None):
    return json.loads(fetch(url, headers).decode("utf-8", "replace"))
def wan(n):
    try: n = float(n)
    except Exception: return None
    if n >= 10000:
        s = f"{n/10000:.1f}".rstrip("0").rstrip(".")
        return s + "万"
    return str(int(n))
def q(s): return urllib.parse.quote(str(s), safe="")

def f_weibo():
    d = get_json("https://weibo.com/ajax/side/hotSearch", {"Referer": "https://weibo.com/"})
    out = []
    for i, x in enumerate(d["data"]["realtime"][:50], 1):
        w = x.get("word_scheme") or x.get("word")
        out.append({"rank": i, "title": (x.get("word") or w).strip("#"), "url": f"https://s.weibo.com/weibo?q={q(w)}&t=31&Refer=top", "heatLabel": wan(x.get("num"))})
    return out
def f_baidu():
    d = get_json("https://top.baidu.com/api/board?platform=wise&tab=realtime")
    words = []
    def walk(o):
        if isinstance(o, dict):
            if isinstance(o.get("word"), str): words.append(o["word"])
            for v in o.values(): walk(v)
        elif isinstance(o, list):
            for v in o: walk(v)
    walk(d.get("data", {}))
    seen = []
    for w in words:
        if w not in seen: seen.append(w)
    return [{"rank": i, "title": w, "url": f"https://www.baidu.com/s?wd={q(w)}", "heatLabel": None} for i, w in enumerate(seen[:50], 1)]
def f_zhihu():
    d = get_json("https://api.zhihu.com/topstory/hot-list?limit=50")
    out = []
    for i, x in enumerate(d["data"][:30], 1):
        t = x["target"]; dt = (x.get("detail_text") or "").replace("热度", "").replace(" ", "")
        out.append({"rank": i, "title": t["title"], "url": f"https://www.zhihu.com/question/{t['id']}", "heatLabel": dt or None})
    return out
def f_douyin():
    d = get_json("https://www.douyin.com/aweme/v1/web/hot/search/list/?device_platform=webapp&aid=6383&channel=channel_pc_web", {"Referer": "https://www.douyin.com/"})
    out = []
    for i, x in enumerate(d["data"]["word_list"][:50], 1):
        sid = x.get("sentence_id")
        url = f"https://www.douyin.com/hot/{sid}" if sid else f"https://www.douyin.com/search/{q(x['word'])}"
        out.append({"rank": i, "title": x["word"], "url": url, "heatLabel": wan(x.get("hot_value"))})
    return out
def f_bilibili():
    d = get_json("https://api.bilibili.com/x/web-interface/popular?ps=50&pn=1", {"Referer": "https://www.bilibili.com/"})
    out = []
    for i, x in enumerate(d["data"]["list"][:50], 1):
        out.append({"rank": i, "title": x["title"], "url": f"https://www.bilibili.com/video/{x['bvid']}", "heatLabel": wan((x.get("stat") or {}).get("view"))})
    return out
def f_toutiao():
    d = get_json("https://www.toutiao.com/hot-event/hot-board/?origin=toutiao_pc", {"Referer": "https://www.toutiao.com/"})
    out = []
    for i, x in enumerate(d["data"][:50], 1):
        cid = x.get("ClusterId") or x.get("ClusterIdStr")
        url = f"https://www.toutiao.com/trending/{cid}/" if cid else "https://www.toutiao.com/"
        out.append({"rank": i, "title": x["Title"], "url": url, "heatLabel": wan(x.get("HotValue"))})
    return out
def f_google():
    seen, out = set(), []
    for geo in ["US", "GB", "JP", "DE", "IN", "KR"]:
        try:
            root = ET.fromstring(fetch(f"https://trends.google.com/trending/rss?geo={geo}"))
        except Exception:
            continue
        for item in root.iter("item"):
            t = item.findtext("title")
            if not t or t in seen: continue
            seen.add(t)
            traffic = None
            for el in item:
                if el.tag.endswith("approx_traffic"): traffic = el.text
            out.append({"rank": len(out)+1, "title": t, "url": item.findtext("link") or "https://trends.google.com/trending", "heatLabel": traffic})
            if len(out) >= 50: return out
    return out
def f_twitter():
    html = fetch("https://trends24.in/").decode("utf-8", "replace")
    out, seen = [], set()
    for m in re.findall(r'twitter\.com/search\?q=([^"&]+)', html):
        t = urllib.parse.unquote_plus(m).strip()
        if t and t not in seen:
            seen.add(t)
            out.append({"rank": len(out)+1, "title": t, "url": f"https://twitter.com/search?q={m}", "heatLabel": None})
        if len(out) >= 50: break
    return out
def f_hn():
    ids = get_json("https://hacker-news.firebaseio.com/v0/topstories.json")[:30]
    out = []
    for sid in ids:
        it = get_json(f"https://hacker-news.firebaseio.com/v0/item/{sid}.json")
        if it and it.get("title"):
            out.append({"rank": len(out)+1, "title": it["title"], "url": it.get("url") or f"https://news.ycombinator.com/item?id={sid}", "heatLabel": str(it.get("score")) if it.get("score") is not None else None})
    return out
BAD = ("Main_Page", "Special:", "Wikipedia:", "Help:", "Template:", "Category:", "File:", "Portal:", "Draft:", "MediaWiki:", "Talk:", "User:", "-")
def f_wiki(lang):
    # Yesterday's pageviews are often not published yet early in the UTC
    # day (404); fall back to 2 and 3 days ago, as the Node server does.
    d = None
    for back in (1, 2, 3):
        day = datetime.now(timezone.utc) - timedelta(days=back)
        try:
            d = get_json(f"https://wikimedia.org/api/rest_v1/metrics/pageviews/top/{lang}.wikipedia/all-access/{day:%Y/%m/%d}")
            break
        except Exception:
            continue
    if d is None: raise RuntimeError("wikipedia pageviews unavailable")
    out = []
    for a in d["items"][0]["articles"]:
        if a["article"].startswith(BAD): continue
        out.append({"rank": len(out)+1, "title": a["article"].replace("_", " "), "url": f"https://{lang}.wikipedia.org/wiki/{a['article']}", "heatLabel": f"{a['views']:,}"})
        if len(out) >= 25: break
    return out

FUNCS = [("weibo", f_weibo), ("baidu", f_baidu), ("zhihu", f_zhihu), ("douyin", f_douyin), ("bilibili", f_bilibili), ("toutiao", f_toutiao), ("google_trends", f_google), ("twitter", f_twitter), ("hackernews", f_hn), ("wikipedia_en", lambda: f_wiki("en")), ("wikipedia_zh", lambda: f_wiki("zh"))]
sources = []
t_all = time.time()
for name, fn in FUNCS:
    t0 = time.time()
    try:
        items = fn()
        sources.append({"platform": name, "ok": True, "items": items})
        print(f"{name:14s} ok count={len(items):3d} {time.time()-t0:4.1f}s")
    except Exception as e:
        sources.append({"platform": name, "ok": False, "items": []})
        print(f"{name:14s} FAIL {type(e).__name__}: {str(e)[:120]}")
snap = {"fetchedAt": datetime.now(timezone.utc).isoformat(), "sources": sources}
raw = json.dumps(snap, ensure_ascii=False).encode()
with open("snapshot.json", "wb") as f: f.write(raw)
with open("snapshot.json.gz.b64", "w") as f: f.write(base64.b64encode(gzip.compress(raw)).decode())
total = sum(len(s["items"]) for s in sources)
print(f"TOTAL {total} items, json {len(raw)} bytes, b64gz {len(base64.b64encode(gzip.compress(raw)))} chars, elapsed {time.time()-t_all:.1f}s")
