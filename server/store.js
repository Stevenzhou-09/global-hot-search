// File-based snapshot store: data/board.json
//
// Why a JSON file instead of SQLite: the dataset is tiny (one snapshot of
// ~460 rows plus a bounded fetch log and a topic-detail cache), and a
// plain file keeps the project dependency-free, inspectable, and trivial
// to back up or reset (just delete the file). Writes are atomic
// (write to a temp file, then rename).
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const MAX_LOG = 200;
const MAX_TOPIC_CACHE = 200;

export class Store {
  constructor(file) {
    this.file = file;
    this.data = { platforms: {}, fetchLog: [], topicCache: {} };
    if (existsSync(file)) {
      try {
        const parsed = JSON.parse(readFileSync(file, "utf8"));
        if (parsed && typeof parsed === "object") {
          this.data = {
            platforms: parsed.platforms ?? {},
            fetchLog: Array.isArray(parsed.fetchLog) ? parsed.fetchLog : [],
            topicCache: parsed.topicCache ?? {},
          };
        }
      } catch {
        // Corrupt store: start fresh rather than crash.
        this.data = { platforms: {}, fetchLog: [], topicCache: {} };
      }
    }
  }

  save() {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 1), "utf8");
    renameSync(tmp, this.file);
  }

  // Replace one platform's snapshot and append a fetch-log row.
  applyFetchResult(result, fetchedAtIso, origin) {
    if (result.ok && result.items.length > 0) {
      this.data.platforms[result.platform] = {
        items: result.items,
        fetchedAt: fetchedAtIso,
        origin,
      };
    }
    this.data.fetchLog.unshift({
      source: result.platform,
      ok: result.ok === true,
      count: result.ok ? result.items.length : 0,
      error: result.error ?? null,
      origin,
      fetchedAt: fetchedAtIso,
    });
    this.data.fetchLog = this.data.fetchLog.slice(0, MAX_LOG);
  }

  logOnly(entry) {
    this.data.fetchLog.unshift(entry);
    this.data.fetchLog = this.data.fetchLog.slice(0, MAX_LOG);
  }

  newestFetchedAt() {
    const times = Object.values(this.data.platforms)
      .map((p) => p?.fetchedAt)
      .filter(Boolean)
      .map((s) => new Date(s).getTime());
    return times.length ? new Date(Math.max(...times)) : null;
  }

  getTopic(key) {
    return this.data.topicCache[key] ?? null;
  }

  putTopic(key, value) {
    this.data.topicCache[key] = value;
    const keys = Object.keys(this.data.topicCache);
    if (keys.length > MAX_TOPIC_CACHE) {
      // Evict oldest by generatedAt.
      keys
        .sort((a, b) => new Date(this.data.topicCache[a].generatedAt) - new Date(this.data.topicCache[b].generatedAt))
        .slice(0, keys.length - MAX_TOPIC_CACHE)
        .forEach((k) => delete this.data.topicCache[k]);
    }
  }
}
