// REST client for the standalone server (server/index.js).
// Response types are defined locally here — there is no codegen and no
// proprietary SDK. Method names intentionally mirror the original Muse
// Space actions (getBoard / refreshHotData / getTopicDetail) so App.tsx
// stays close to the original.

export type Region = "domestic" | "international";

export interface SourceStatus {
  platform: string;
  label: string;
  region: Region;
  ok: boolean;
  count: number;
  fetchedAt: string | null;
  // "import" = arrived via POST /api/import from an external fetcher,
  // "self" = fetched by this server itself, null = never fetched.
  origin: "import" | "self" | null;
}

export interface PlatformItem {
  rank: number;
  title: string;
  heatLabel: string | null;
  url: string | null;
  extra: string | null;
}

export interface PlatformList {
  platform: string;
  label: string;
  region: Region;
  note: string | null;
  items: PlatformItem[];
}

export interface Appearance {
  platform: string;
  label: string;
  region: Region;
  rank: number;
  heatLabel: string | null;
  url: string | null;
}

export interface CompositeEntry {
  title: string;
  score: number;
  platformCount: number;
  url: string | null;
  appearances: Appearance[];
}

export interface Board {
  fetchedAt: string | null;
  sources: SourceStatus[];
  platforms: PlatformList[];
  composite: {
    fused: CompositeEntry[];
    domestic: CompositeEntry[];
    international: CompositeEntry[];
  };
}

export interface TopicLink {
  title: string;
  source: string;
  url: string;
}

export interface TopicDetail {
  status: "ok" | "links_only";
  title: string;
  summary: string | null;
  links: TopicLink[];
  generatedAt: string;
  cached: boolean;
}

export interface RefreshResult {
  ok: true;
  mode: string;
  note: string | null;
  fetchedAt: string;
  sources: Array<{
    platform: string;
    label: string;
    ok: boolean;
    count: number;
    error: string | null;
  }>;
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as T;
}

async function postJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { method: "POST" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as T;
}

export const api = {
  getBoard: (_args: Record<string, never> = {}) => getJson<Board>("/api/board"),
  refreshHotData: (_args: Record<string, never> = {}) => postJson<RefreshResult>("/api/refresh"),
  getTopicDetail: (args: { title: string }) =>
    getJson<TopicDetail>(`/api/topic?title=${encodeURIComponent(args.title)}`),
};
