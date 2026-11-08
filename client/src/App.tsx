import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type Appearance, type Board, type CompositeEntry, type PlatformList, type TopicDetail } from "./api";

interface SelectedTopic {
  title: string;
  appearances: Appearance[];
}

type View =
  | { kind: "composite"; scope: "fused" | "domestic" | "international" }
  | { kind: "platform"; platform: string };

function rankColor(rank: number): string {
  if (rank === 1) return "var(--accent)";
  if (rank === 2) return "#e86a1c";
  if (rank === 3) return "#d9a01f";
  return "var(--dim)";
}

function timeAgo(iso: string | null): string {
  if (!iso) return "尚未抓取";
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "刚刚更新";
  if (mins < 60) return `${mins} 分钟前更新`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs} 小时前更新`;
  return `${Math.floor(hrs / 24)} 天前更新`;
}

function fullTime(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function normalizeTitle(t: string): string {
  return t
    .toLowerCase()
    .replace(/#[^#]*#/g, "")
    .replace(/[\s\p{P}\p{S}]+/gu, "")
    .trim();
}

function CompositeRow({
  entry,
  rank,
  onOpen,
}: {
  entry: CompositeEntry;
  rank: number;
  onOpen: (t: SelectedTopic) => void;
}) {
  return (
    <li className="border-b border-[var(--border)]">
      <button
        type="button"
        aria-label={`查看话题详情：${entry.title}`}
        onClick={() => onOpen({ title: entry.title, appearances: entry.appearances })}
        className="flex w-full gap-3 py-3 text-left sm:gap-4"
      >
        <span
          className="font-display w-9 shrink-0 text-right text-3xl font-black italic leading-none sm:w-11 sm:text-4xl"
          style={{ color: rankColor(rank) }}
          aria-hidden="true"
        >
          {rank}
        </span>
        <span className="min-w-0 flex-1">
          <span className="text-base font-semibold leading-snug text-[var(--text)] sm:text-lg">
            {entry.title}
          </span>
          <span className="mt-1.5 flex flex-wrap items-center gap-1.5">
            {entry.platformCount >= 2 && (
              <span className="bg-[var(--accent)] px-1.5 py-0.5 text-[11px] font-bold leading-none text-white">
                {entry.platformCount} 个平台同时在热
              </span>
            )}
            {entry.appearances.map((a) => (
              <span
                key={a.platform}
                className="border px-1.5 py-0.5 text-[11px] leading-none"
                style={{
                  borderColor: a.region === "domestic" ? "var(--accent)" : "var(--accent-intl)",
                  color: a.region === "domestic" ? "var(--accent)" : "var(--accent-intl)",
                }}
              >
                {a.label} #{a.rank}
              </span>
            ))}
            <span className="text-[11px] font-medium leading-none text-[var(--dim)]">详情 ›</span>
          </span>
        </span>
        <span className="shrink-0 text-right">
          <span className="font-display block text-lg font-bold leading-none text-[var(--text)]">
            {entry.score}
          </span>
          <span className="mt-1 block text-[11px] leading-none text-[var(--dim)]">综合热度</span>
        </span>
      </button>
    </li>
  );
}

function PlatformRow({
  item,
  platform,
  onOpen,
}: {
  item: PlatformList["items"][number];
  platform: PlatformList;
  onOpen: (t: SelectedTopic) => void;
}) {
  return (
    <li className="border-b border-[var(--border)]">
      <button
        type="button"
        aria-label={`查看话题详情：${item.title}`}
        onClick={() =>
          onOpen({
            title: item.title,
            appearances: [
              {
                platform: platform.platform,
                label: platform.label,
                region: platform.region,
                rank: item.rank,
                heatLabel: item.heatLabel,
                url: item.url,
              },
            ],
          })
        }
        className="flex w-full items-center gap-3 py-2.5 text-left"
      >
        <span
          className="font-display w-8 shrink-0 text-right text-2xl font-black italic leading-none"
          style={{ color: rankColor(item.rank) }}
          aria-hidden="true"
        >
          {item.rank}
        </span>
        <span className="min-w-0 flex-1 text-[15px] font-medium leading-snug text-[var(--text)]">
          {item.title}
          {item.extra && <span className="ml-2 text-xs font-normal text-[var(--dim)]">{item.extra}</span>}
        </span>
        {item.heatLabel && (
          <span className="shrink-0 text-xs tabular-nums text-[var(--dim)]">{item.heatLabel}</span>
        )}
        <span className="shrink-0 text-xs text-[var(--dim)]" aria-hidden="true">
          ›
        </span>
      </button>
    </li>
  );
}

function TopicDrawer({
  topic,
  board,
  onClose,
}: {
  topic: SelectedTopic;
  board: Board | undefined;
  onClose: () => void;
}) {
  // Enrich a single-platform selection with the fused composite entry when
  // the same topic appears on other platforms too.
  const appearances = (() => {
    if (topic.appearances.length > 1 || !board) return topic.appearances;
    const norm = normalizeTitle(topic.title);
    const match = board.composite.fused.find((e) => normalizeTitle(e.title) === norm);
    return match ? match.appearances : topic.appearances;
  })();

  const detail = useQuery({
    queryKey: ["topic-detail", topic.title],
    queryFn: () => api.getTopicDetail({ title: topic.title }),
    staleTime: 10 * 60_000,
  });

  return (
    <div className="fixed inset-0 z-30" role="dialog" aria-modal="true" aria-label={`话题详情：${topic.title}`}>
      <button
        type="button"
        aria-label="关闭详情"
        className="absolute inset-0 h-full w-full bg-black/45"
        onClick={onClose}
      />
      <div className="absolute inset-x-0 bottom-0 max-h-[86vh] overflow-y-auto bg-[var(--bg)] px-4 pb-8 pt-4 sm:inset-x-auto sm:right-0 sm:top-0 sm:h-full sm:max-h-none sm:w-[430px] sm:border-l sm:border-[var(--border)] sm:pt-6">
        <div className="flex items-start justify-between gap-3">
          <h2 className="font-display text-xl font-black leading-snug">{topic.title}</h2>
          <button
            type="button"
            aria-label="关闭详情"
            onClick={onClose}
            className="shrink-0 border border-[var(--border)] px-2.5 py-1 text-sm font-semibold"
          >
            关闭
          </button>
        </div>

        <h3 className="mt-5 border-b-2 border-[var(--text)] pb-1 text-sm font-bold">各平台上榜情况</h3>
        <ul>
          {appearances.map((a) => (
            <li
              key={a.platform}
              className="flex items-baseline gap-2 border-b border-[var(--border)] py-2 text-sm"
            >
              <span
                className="font-semibold"
                style={{ color: a.region === "domestic" ? "var(--accent)" : "var(--accent-intl)" }}
              >
                {a.label}
              </span>
              <span>第 {a.rank} 名</span>
              {a.heatLabel && <span className="text-[var(--dim)]">热度 {a.heatLabel}</span>}
              {a.url && (
                <a
                  href={a.url}
                  target="_blank"
                  rel="noreferrer"
                  className="ml-auto shrink-0 font-medium text-[var(--accent-intl)]"
                >
                  原始页面 ›
                </a>
              )}
            </li>
          ))}
        </ul>

        <h3 className="mt-5 border-b-2 border-[var(--text)] pb-1 text-sm font-bold">话题汇总</h3>
        {detail.isPending ? (
          <p className="py-3 text-sm leading-relaxed text-[var(--dim)]">
            正在从多个网站汇总这个话题，稍等几秒…
          </p>
        ) : detail.error ? (
          <p className="py-3 text-sm leading-relaxed text-[var(--dim)]">
            汇总暂时生成失败，可以先看下方各平台的原始页面。
          </p>
        ) : detail.data ? (
          <DetailBody data={detail.data} />
        ) : null}
      </div>
    </div>
  );
}

function DetailBody({ data }: { data: TopicDetail }) {
  return (
    <>
      {data.status === "ok" && data.summary ? (
        <p className="py-3 text-[15px] leading-relaxed">{data.summary}</p>
      ) : (
        <p className="py-3 text-sm leading-relaxed text-[var(--dim)]">
          这个话题暂时汇总不到足够的公开报道，下面是它在各大平台的搜索页，可以直接去看讨论。
        </p>
      )}
      <h3 className="mt-2 border-b-2 border-[var(--text)] pb-1 text-sm font-bold">
        {data.status === "ok" ? "相关报道与讨论" : "去平台上看这个话题"}
      </h3>
      <ul>
        {data.links.map((l) => (
          <li key={l.url} className="border-b border-[var(--border)]">
            <a href={l.url} target="_blank" rel="noreferrer" className="block py-2.5">
              <span className="text-[11px] font-bold" style={{ color: "var(--accent)" }}>
                {l.source}
              </span>
              <span className="mt-0.5 block text-sm font-medium leading-snug">{l.title}</span>
            </a>
          </li>
        ))}
      </ul>
      <p className="mt-4 text-xs leading-relaxed text-[var(--dim)]">
        信息来源：以上汇总由系统在 {fullTime(data.generatedAt)}
        根据公开网络搜索结果（见上方链接）自动整理生成，只采用来源中出现的事实；上榜名次与热度来自本页各平台榜单抓取。
        {data.cached ? "（本次显示的是缓存版本）" : ""}
      </p>
    </>
  );
}

export function App() {
  const queryClient = useQueryClient();
  const [view, setView] = useState<View>({ kind: "composite", scope: "fused" });
  const [showAll, setShowAll] = useState(false);
  const [selected, setSelected] = useState<SelectedTopic | null>(null);
  const autoRefreshed = useRef(false);

  const board = useQuery({
    queryKey: ["board"],
    queryFn: () => api.getBoard({}),
    refetchInterval: 60_000,
  });

  const refresh = useMutation({
    mutationFn: () => api.refreshHotData({}),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["board"] }),
  });

  // First open on an empty database: fetch immediately.
  useEffect(() => {
    if (board.data && board.data.fetchedAt === null && !autoRefreshed.current && !refresh.isPending) {
      autoRefreshed.current = true;
      refresh.mutate();
    }
  }, [board.data, refresh]);

  useEffect(() => {
    setShowAll(false);
  }, [view]);

  const data = board.data;
  const activePlatform =
    view.kind === "platform" ? data?.platforms.find((p) => p.platform === view.platform) : undefined;

  const compositeList =
    view.kind === "composite" && data
      ? view.scope === "fused"
        ? data.composite.fused
        : view.scope === "domestic"
          ? data.composite.domestic
          : data.composite.international
      : [];

  const visibleComposite = showAll ? compositeList : compositeList.slice(0, 20);
  const visiblePlatformItems = activePlatform
    ? showAll
      ? activePlatform.items
      : activePlatform.items.slice(0, 30)
    : [];

  const tabBase =
    "px-3.5 py-2 text-sm font-semibold transition-colors border-b-2 -mb-px whitespace-nowrap";
  const tabStyle = (active: boolean) => ({
    borderColor: active ? "var(--accent)" : "transparent",
    color: active ? "var(--text)" : "var(--dim)",
  });

  return (
    <div className="min-h-screen bg-[var(--bg)] text-[var(--text)]">
      <header className="sticky top-0 z-10 border-b border-[var(--border)] bg-[var(--bg)] pt-safe">
        <div className="mx-auto flex max-w-3xl items-center justify-between gap-3 px-4 pt-3">
          <div>
            <h1 className="font-display text-[22px] font-black leading-tight tracking-tight">
              全球热搜榜
            </h1>
            <p className="text-xs text-[var(--dim)]">
              {data ? timeAgo(data.fetchedAt) : "正在加载"} · 每小时更新一轮
            </p>
          </div>
          <button
            type="button"
            aria-label="立即刷新榜单"
            disabled={refresh.isPending}
            onClick={() => refresh.mutate()}
            className="shrink-0 border border-[var(--text)] px-3 py-1.5 text-sm font-semibold disabled:opacity-40"
          >
            {refresh.isPending ? "抓取中…" : "刷新"}
          </button>
        </div>
        <nav aria-label="榜单视图" className="mx-auto flex max-w-3xl gap-1 overflow-x-auto px-4">
          <button
            type="button"
            className={tabBase}
            style={tabStyle(view.kind === "composite" && view.scope === "fused")}
            onClick={() => setView({ kind: "composite", scope: "fused" })}
          >
            综合榜
          </button>
          <button
            type="button"
            className={tabBase}
            style={tabStyle(view.kind === "composite" && view.scope === "domestic")}
            onClick={() => setView({ kind: "composite", scope: "domestic" })}
          >
            国内榜
          </button>
          <button
            type="button"
            className={tabBase}
            style={tabStyle(view.kind === "composite" && view.scope === "international")}
            onClick={() => setView({ kind: "composite", scope: "international" })}
          >
            国际榜
          </button>
          <span className="mx-1 my-2 w-px shrink-0 bg-[var(--border)]" aria-hidden="true" />
          {(data?.platforms ?? []).map((p) => (
            <button
              key={p.platform}
              type="button"
              className={tabBase}
              style={tabStyle(view.kind === "platform" && view.platform === p.platform)}
              onClick={() => setView({ kind: "platform", platform: p.platform })}
            >
              {p.label}
            </button>
          ))}
        </nav>
      </header>

      <main className="mx-auto max-w-3xl px-4 pb-10">
        {board.isPending || (refresh.isPending && !data?.fetchedAt) ? (
          <p className="py-16 text-center text-sm text-[var(--dim)]">
            正在抓取各平台热榜，稍等几秒…
          </p>
        ) : board.error ? (
          <div className="py-16 text-center">
            <p className="text-sm text-[var(--dim)]">榜单加载失败</p>
            <button
              type="button"
              className="mt-3 border border-[var(--text)] px-3 py-1.5 text-sm font-semibold"
              onClick={() => board.refetch()}
            >
              重试
            </button>
          </div>
        ) : !data || data.platforms.length === 0 ? (
          <div className="py-16 text-center">
            <p className="text-sm text-[var(--dim)]">暂时没有抓到任何平台的榜单。</p>
            <button
              type="button"
              disabled={refresh.isPending}
              className="mt-3 border border-[var(--text)] px-3 py-1.5 text-sm font-semibold disabled:opacity-40"
              onClick={() => refresh.mutate()}
            >
              {refresh.isPending ? "抓取中…" : "立即抓取"}
            </button>
          </div>
        ) : view.kind === "composite" ? (
          <>
            <p className="pt-4 text-[13px] leading-relaxed text-[var(--dim)]">
              {view.scope === "fused"
                ? "国内六大平台与国际来源合并计算：一个话题在越多独立平台上榜、排名越靠前，综合热度越高。"
                : view.scope === "domestic"
                  ? "微博、百度、知乎、抖音、哔哩哔哩、今日头条六个平台交叉计算，单个平台说了不算。"
                  : "X（推特）全球趋势、谷歌趋势（六国）、Hacker News、维基百科英/中文版交叉计算。"}
            </p>
            <ol>
              {visibleComposite.map((entry, i) => (
                <CompositeRow key={`${entry.title}-${i}`} entry={entry} rank={i + 1} onOpen={setSelected} />
              ))}
            </ol>
            {!showAll && compositeList.length > 20 && (
              <button
                type="button"
                className="mt-4 w-full border border-[var(--border)] py-2.5 text-sm font-semibold"
                onClick={() => setShowAll(true)}
              >
                查看完整榜单（共 {compositeList.length} 条）
              </button>
            )}
          </>
        ) : activePlatform ? (
          <>
            <div className="flex flex-wrap items-baseline gap-x-3 pt-4">
              <h2 className="font-display text-lg font-bold">{activePlatform.label}热榜</h2>
              <span
                className="text-xs font-semibold"
                style={{
                  color:
                    activePlatform.region === "domestic" ? "var(--accent)" : "var(--accent-intl)",
                }}
              >
                {activePlatform.region === "domestic" ? "国内" : "国际"}
              </span>
              {activePlatform.note && (
                <span className="text-xs text-[var(--dim)]">{activePlatform.note}</span>
              )}
            </div>
            <ol>
              {visiblePlatformItems.map((item) => (
                <PlatformRow
                  key={`${activePlatform.platform}-${item.rank}`}
                  item={item}
                  platform={activePlatform}
                  onOpen={setSelected}
                />
              ))}
            </ol>
            {!showAll && activePlatform.items.length > 30 && (
              <button
                type="button"
                className="mt-4 w-full border border-[var(--border)] py-2.5 text-sm font-semibold"
                onClick={() => setShowAll(true)}
              >
                查看全部 {activePlatform.items.length} 条
              </button>
            )}
          </>
        ) : (
          <p className="py-16 text-center text-sm text-[var(--dim)]">该平台暂无数据</p>
        )}

        {data && data.sources.length > 0 && (
          <footer className="mt-10 border-t-2 border-[var(--text)] pt-4">
            <h2 className="font-display text-base font-bold">排名方法与数据来源</h2>
            <p className="mt-2 text-[13px] leading-relaxed text-[var(--dim)]">
              这里没有编辑推荐位，也没有单个平台的意志。每条话题的综合热度 = 它在每个上榜平台的名次分（第
              1 名 50 分、第 2 名 49 分……）之和；同时出现在多个平台的话题天然排在只红在一个平台的话题前面。
              点开任意一行，可以看这个话题的事件汇总、各平台名次和相关报道链接。
            </p>
            <ul className="mt-3 space-y-1.5">
              {data.sources.map((s) => (
                <li key={s.platform} className="flex flex-wrap items-baseline gap-x-2 text-[13px]">
                  <span
                    className="inline-block h-2 w-2 shrink-0 rounded-full"
                    style={{ background: s.ok ? "#2e9e4f" : "#d92c1f" }}
                    aria-hidden="true"
                  />
                  <span className="font-medium">{s.label}</span>
                  <span className="text-[var(--dim)]">
                    {s.ok
                      ? `${s.count} 条 · ${fullTime(s.fetchedAt)} 抓取`
                      : s.count > 0
                        ? `最近一次更新失败，显示此前 ${s.count} 条`
                        : "更新失败，暂无数据"}
                  </span>
                  {s.origin && (
                    <span className="text-[var(--dim)]">
                      · {s.origin === "import" ? "外部导入" : "本机自抓"}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </footer>
        )}
      </main>
      {selected && (
        <TopicDrawer topic={selected} board={data} onClose={() => setSelected(null)} />
      )}
    </div>
  );
}
