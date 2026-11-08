#!/usr/bin/env python3
"""全球热搜榜 — standalone Python fetcher (standard library only).

Fetches all 11 sources and outputs one snapshot round in exactly the
shape the server's POST /api/import endpoint accepts:

    { "fetchedAt": "<ISO8601>",
      "sources": [ { "platform": "weibo", "ok": true,
                     "items": [ { "rank": 1, "title": "...",
                                  "url": "...", "heatLabel": "...",
                                  "extra": null } ] } ] }

Usage:
    # write a snapshot file (default: ./snapshot.json)
    python3 fetcher/fetch_hot.py --out snapshot.json

    # POST straight to a running server
    python3 fetcher/fetch_hot.py --post http://localhost:3000/api/import

    # print to stdout
    python3 fetcher/fetch_hot.py --out -

This is the cleaned, self-hostable counterpart of the fetcher that
originally ran on the author's external box: same endpoints, same
parsing, no machine-specific paths, no credentials. The Node server can
also fetch everything by itself (POST /api/refresh); this script exists
for people who prefer to run fetching on a separate machine/schedule.

Sources (see README for honest notes):
  domestic       weibo / baidu / zhihu / douyin / bilibili / toutiao
                 via the DailyHot aggregator (hot.baiwumm.com), with a
                 Baidu official-API fallback for baidu
  google_trends  Google Trends RSS for US/GB/JP/DE/IN/KR, merged
  twitter        X worldwide trends via the trends24.in mirror
                 (X has no public trends API)
  hackernews     official Firebase API, top 30
  wikipedia_en   Wikimedia pageviews, yesterday (UTC), top 25
  wikipedia_zh   same, Chinese Wikipedia
"""

import argparse
import json
import re
import sys
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone

UA = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"
    )
}
HT_NS = {"ht": "http://schemas.google.com/trends/2024"}


def fetch(url, timeout=20):
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def get_json(url, timeout=20):
    return json.loads(fetch(url, timeout).decode("utf-8", "replace"))


def get_text(url, timeout=20):
    return fetch(url, timeout).decode("utf-8", "replace")


def wan(n):
    """Format a raw heat number the way Chinese platforms display it."""
    try:
        n = float(n)
    except (TypeError, ValueError):
        return None
    if n >= 100_000_000:
        s = f"{n / 100_000_000:.1f}".rstrip("0").rstrip(".")
        return s + "亿"
    if n >= 10_000:
        s = f"{n / 10_000:.1f}".rstrip("0").rstrip(".")
        return s + "万"
    return str(int(n))


def heat_label(v):
    if isinstance(v, (int, float)) and v > 0:
        return wan(v)
    if isinstance(v, str) and v.strip():
        return v.strip()
    return None


def item(rank, title, url=None, heat=None, extra=None):
    return {"rank": rank, "title": title, "url": url, "heatLabel": heat, "extra": extra}


# ---------- domestic via DailyHot aggregator ----------

DOMESTIC = ["weibo", "baidu", "zhihu", "douyin", "bilibili", "toutiao"]


def f_aggregator(platform):
    d = get_json(f"https://hot.baiwumm.com/api/{platform}")
    data = d.get("data")
    if not isinstance(data, list):
        raise ValueError("bad response shape")
    out = []
    for i, raw in enumerate(data[:50]):
        if not isinstance(raw, dict) or not str(raw.get("title") or "").strip():
            continue
        url = raw.get("url") or raw.get("mobileUrl")
        out.append(item(i + 1, str(raw["title"]).strip(), url, heat_label(raw.get("hot"))))
    if not out:
        raise ValueError("empty list")
    return out


def f_baidu_official():
    d = get_json("https://top.baidu.com/api/board?platform=wise&tab=realtime")
    cards = (d.get("data") or {}).get("cards") or []
    if not cards:
        raise ValueError("no cards")
    out = []
    for raw in cards[0].get("content") or []:
        for entry in raw.get("content") or []:
            word = str(entry.get("word") or "").strip()
            if not word:
                continue
            out.append(item(len(out) + 1, word, entry.get("url"),
                            "置顶" if entry.get("isTop") is True else None))
    return out[:50]


# ---------- international ----------

GT_GEOS = [("US", "美国"), ("GB", "英国"), ("JP", "日本"),
           ("DE", "德国"), ("IN", "印度"), ("KR", "韩国")]


def parse_traffic(s):
    m = re.match(r"^([\d.]+)\s*([KM])?$", (s or "").replace("+", "").strip(), re.I)
    if not m:
        return 0
    n = float(m.group(1))
    unit = (m.group(2) or "").upper()
    return n * 1_000_000 if unit == "M" else n * 1_000 if unit == "K" else n


def f_google_trends():
    merged = {}
    for geo, label in GT_GEOS:
        try:
            xml = get_text(f"https://trends.google.com/trending/rss?geo={geo}")
            root = ET.fromstring(xml)
        except Exception:
            continue
        for it in root.iter("item"):
            title = (it.findtext("title") or "").strip()
            if not title:
                continue
            traffic_el = it.find("ht:approx_traffic", HT_NS)
            traffic_label = (traffic_el.text or "").strip() if traffic_el is not None else ""
            traffic = parse_traffic(traffic_label)
            key = title.lower()
            cur = merged.get(key)
            if cur is None:
                merged[key] = {"title": title, "traffic": traffic,
                               "trafficLabel": traffic_label, "countries": [label]}
            else:
                if traffic > cur["traffic"]:
                    cur["traffic"], cur["trafficLabel"] = traffic, traffic_label
                if label not in cur["countries"]:
                    cur["countries"].append(label)
    ranked = sorted(merged.values(), key=lambda v: -v["traffic"])[:50]
    if not ranked:
        raise ValueError("empty list")
    return [
        item(i + 1, v["title"], "https://trends.google.com/trending?geo=US",
             f"搜索量 {v['trafficLabel']}" if v["trafficLabel"] else None,
             " · ".join(v["countries"]))
        for i, v in enumerate(ranked)
    ]


def decode_entities(s):
    return (s.replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">")
             .replace("&quot;", '"').replace("&#39;", "'").replace("&nbsp;", " ").strip())


def f_twitter():
    html = get_text("https://trends24.in/")
    m = re.search(r'<ol[^>]*trend-card__list[^>]*>(.*?)</ol>', html, re.S)
    if not m:
        raise ValueError("trend list not found")
    out, seen = [], set()
    for url, raw_title in re.findall(
            r'<a href="(https://twitter\.com/search\?q=[^"]+)" class=trend-link>(.*?)</a>',
            m.group(1), re.S):
        title = decode_entities(re.sub(r"<[^>]+>", "", raw_title))
        if not title or title.lower() in seen:
            continue
        seen.add(title.lower())
        out.append(item(len(out) + 1, title, url))
        if len(out) >= 50:
            break
    if not out:
        raise ValueError("empty list")
    return out


def f_hackernews():
    ids = get_json("https://hacker-news.firebaseio.com/v0/topstories.json")
    if not isinstance(ids, list):
        raise ValueError("bad response shape")
    out = []
    for story_id in [i for i in ids[:30] if isinstance(i, int)]:
        try:
            v = get_json(f"https://hacker-news.firebaseio.com/v0/item/{story_id}.json", timeout=10)
        except Exception:
            continue
        if not isinstance(v, dict) or v.get("deleted"):
            continue
        title = str(v.get("title") or "").strip()
        if not title:
            continue
        url = v.get("url") or f"https://news.ycombinator.com/item?id={v.get('id')}"
        score = v.get("score")
        out.append(item(len(out) + 1, title, url,
                        f"{score} 分" if isinstance(score, (int, float)) else None))
    if not out:
        raise ValueError("empty list")
    return out


def f_wikipedia(lang):
    # Wikimedia publishes with a lag — "yesterday" may still 404 early in
    # the UTC day, so step back up to 3 days. The date is labelled per item.
    j = None
    y = m = day = None
    last_err = None
    for back in (1, 2, 3):
        d = datetime.now(timezone.utc) - timedelta(days=back)
        y, m, day = d.year, f"{d.month:02d}", f"{d.day:02d}"
        try:
            j = get_json(
                f"https://wikimedia.org/api/rest_v1/metrics/pageviews/top/"
                f"{lang}.wikipedia/all-access/{y}/{m}/{day}")
            break
        except Exception as e:  # noqa: BLE001
            last_err = e
    if j is None:
        raise last_err or ValueError("no pageviews data for the last 3 days")
    articles = ((j.get("items") or [{}])[0]).get("articles")
    if not isinstance(articles, list):
        raise ValueError("bad response shape")
    skip = re.compile(r"^(Main_Page|主页|首頁|Wikipedia:|Special:|Help:|File:|Category:|"
                      r"维基百科:|特殊:|帮助:|檔案:|档案:)")
    out = []
    for raw in articles:
        if len(out) >= 25:
            break
        article = raw.get("article")
        if not isinstance(article, str) or skip.match(article):
            continue
        views = raw.get("views")
        out.append(item(len(out) + 1, article.replace("_", " "),
                        f"https://{lang}.wikipedia.org/wiki/{article}",
                        f"{wan(views)} 次阅读" if isinstance(views, (int, float)) else None,
                        f"{y}-{m}-{day} 阅读量"))
    if not out:
        raise ValueError("empty list")
    return out


FETCHERS = {p: (lambda p=p: f_aggregator(p)) for p in DOMESTIC}
FETCHERS.update({
    "google_trends": f_google_trends,
    "twitter": f_twitter,
    "hackernews": f_hackernews,
    "wikipedia_en": lambda: f_wikipedia("en"),
    "wikipedia_zh": lambda: f_wikipedia("zh"),
})


def run_all():
    sources = []

    def one(platform):
        try:
            items = FETCHERS[platform]()
            return {"platform": platform, "ok": True, "items": items}
        except Exception as e:  # noqa: BLE001 - report per-source, keep going
            return {"platform": platform, "ok": False, "items": [], "error": str(e)}

    with ThreadPoolExecutor(max_workers=11) as ex:
        sources = list(ex.map(one, FETCHERS.keys()))

    # Baidu official fallback, same as the server.
    baidu = next(s for s in sources if s["platform"] == "baidu")
    if not baidu["ok"]:
        try:
            items = f_baidu_official()
            if items:
                baidu.update({"ok": True, "items": items, "error": None})
        except Exception:
            pass
    return {
        "fetchedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "sources": sources,
    }


def main():
    ap = argparse.ArgumentParser(description="Fetch all 11 hot-search sources into one snapshot round.")
    ap.add_argument("--out", default="snapshot.json",
                    help="snapshot file to write, or - for stdout (default: snapshot.json)")
    ap.add_argument("--post", default=None,
                    help="POST the snapshot to this import URL instead of/in addition to writing a file")
    args = ap.parse_args()

    snapshot = run_all()
    for s in snapshot["sources"]:
        status = f"ok {len(s['items'])}" if s["ok"] else f"FAILED {s.get('error')}"
        print(f"{s['platform']:<15} {status}", file=sys.stderr)

    payload = json.dumps(snapshot, ensure_ascii=False, indent=1)
    if args.out == "-":
        print(payload)
    elif args.out:
        with open(args.out, "w", encoding="utf-8") as f:
            f.write(payload)
        print(f"wrote {args.out}", file=sys.stderr)

    if args.post:
        req = urllib.request.Request(
            args.post,
            data=payload.encode("utf-8"),
            headers={"Content-Type": "application/json", **UA},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=30) as r:
            print(f"POST {args.post} -> HTTP {r.status}: {r.read().decode('utf-8', 'replace')[:500]}",
                  file=sys.stderr)


if __name__ == "__main__":
    main()
