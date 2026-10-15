"use client";

import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { ChevronRight } from "lucide-react";
import { Controls, ReactFlow, ViewportPortal, useStore, type Node, type NodeProps } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useAdminColorMode } from "@/components/admin/nav/AdminThemeRoot";
import type { BrandMapGroup, BrandMapSituation, BrandMapSubjectRecord, GroupTotals } from "@/lib/types/brandMapRecords";
import type { SituationRead } from "@/lib/brandMap/situations";
import type { SubjectListItem } from "@/lib/brandMap/records";
import type { Coverage, SubjectCoverage } from "@/lib/content/blog/coverage";
import type { ContentMapInput, MapPage } from "@/lib/brandMap/contentMapLayout";
import {
  LABEL_R,
  levelTotals,
  MAX_CIRCLES,
  packLevel,
  SCORE_R,
  situationItem,
  situationSubjectItems,
  subjectItem,
  topItems,
  UNGROUPED,
  type PackCircle,
  type PackItem,
} from "@/lib/brandMap/contentMapPack";
import { api, errorText } from "@/components/admin/connect/api";
import { Banner, inputClass } from "@/components/admin/connect/ui";
import { BrandMapContentMap } from "./BrandMapContentMap";
import { smallLabel } from "./BrandMapParts";
import { useMapMove } from "./brandMapMove";
import { matchSubjects, type SubjectName } from "./MapSubjectSearch";

/**
 * The content map of a map at any size (BRAND_MAP_SCALE_ENABLED), by levels: the brand's
 * groups, then one group's subjects, then one subject's own view (today's content map, of
 * that subject only). A level is read when it is opened. Circles are sized by the questions
 * they hold; what is one level down is drawn inside as dots by state, one shape under the
 * circles, from counts the circles already have. Names show when there's room, more as you
 * zoom. At most 400 circles a level can be clicked; the Subjects tab lists every subject.
 * With buying situations on, the map can be arranged by them instead: each situation, then
 * the subjects its questions sit on (a subject appears under each situation it serves).
 */

const MAP = "/api/admin/brand-kit/map";
const W = 880;
const H = 600;
const BIGGEST = 8;

type Step = { kind: "group" | "subject" | "situation"; id: string; name: string };
type Arrange = "subjects" | "situations";
type Pick = { id: string; label: string };

interface CirclesLevel {
  kind: "circles";
  noun: "groups" | "subjects" | "situations";
  items: PackItem[];
}
interface SubjectRead {
  subject: BrandMapSubjectRecord;
  coverage: SubjectCoverage | null;
  overlaps: Coverage["overlaps"];
  missingLinks: Coverage["missingLinks"];
  pages?: MapPage[];
}
type Level = CirclesLevel | { kind: "subject"; read: SubjectRead };
type Failed = { error: string };

const fmt = (n: number) => n.toLocaleString("en");
const pct = (answered: number, questions: number) => (questions ? Math.round((100 * answered) / questions) : 0);

async function readSubjects(group: string): Promise<CirclesLevel | Failed> {
  const r = await api<{ subjects?: SubjectListItem[]; error?: string }>(`${MAP}/subjects?group=${encodeURIComponent(group)}`);
  if (!r.ok || !r.data.subjects) return { error: errorText(r.data) };
  return { kind: "circles", noun: "subjects", items: r.data.subjects.filter((s) => s.status !== "dismissed").map(subjectItem) };
}

/** The top: the groups, or, before there are any, every subject. */
async function readTop(): Promise<{ level: CirclesLevel; groups: BrandMapGroup[] } | Failed> {
  const r = await api<{ groups?: BrandMapGroup[]; ungrouped?: Partial<GroupTotals> | null; error?: string }>(`${MAP}/groups`);
  if (!r.ok || !r.data.groups) return { error: errorText(r.data) };
  // A proposed group holds nothing until it's added (its subjects are only suggested for it).
  const groups = r.data.groups.filter((g) => g.status === "decided");
  if (groups.length) return { level: { kind: "circles", noun: "groups", items: topItems(groups, r.data.ungrouped ?? null) }, groups };
  const all = await readSubjects(UNGROUPED);
  return "error" in all ? all : { level: all, groups: [] };
}

/** Arranged by buying situation: the brand's situations. */
async function readSituations(): Promise<CirclesLevel | Failed> {
  const r = await api<{ situations?: BrandMapSituation[]; error?: string }>(`${MAP}/situations`);
  if (!r.ok || !r.data.situations) return { error: errorText(r.data) };
  return { kind: "circles", noun: "situations", items: r.data.situations.filter((s) => s.status === "decided").map(situationItem) };
}

/** One situation's subjects, by its questions on each. */
async function readSituationSubjects(id: string): Promise<CirclesLevel | Failed> {
  const r = await api<SituationRead & { error?: string }>(`${MAP}/situations/${encodeURIComponent(id)}`);
  if (!r.ok || !r.data.questions) return { error: errorText(r.data) };
  return { kind: "circles", noun: "subjects", items: situationSubjectItems(r.data.questions) };
}

async function readSubject(id: string): Promise<Level | Failed> {
  const r = await api<SubjectRead & { error?: string }>(`${MAP}/subjects/${encodeURIComponent(id)}?view=map`);
  if (!r.ok || !r.data.subject) return { error: errorText(r.data) };
  return { kind: "subject", read: r.data };
}

export function BrandMapContentMapLevels({
  brand,
  homes,
  programmes,
  situations = false,
}: {
  brand: ContentMapInput["brand"];
  /** The brand's site and its names' own pages (a subject's is added when it is open). */
  homes: ContentMapInput["homes"];
  programmes: Array<{ id: string; name: string }> | null;
  /** Buying situations are on: the map can be arranged by them. */
  situations?: boolean;
}) {
  const { moved, progress, round } = useMapMove();
  const [arrange, setArrange] = useState<Arrange>("subjects");
  const [path, setPath] = useState<Step[]>([]);
  const [levels, setLevels] = useState<Record<string, Level>>({});
  const [groups, setGroups] = useState<BrandMapGroup[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const last = path[path.length - 1] ?? null;
  const key = last ? `${last.kind}:${last.id}` : `top:${arrange}`;
  const level = levels[key];

  // Read again when the page's move (and its count) finishes.
  useEffect(() => setLevels({}), [round]);

  useEffect(() => {
    if (!moved || level) return;
    let gone = false;
    setError(null);
    void (async () => {
      const read = !last
        ? arrange === "situations"
          ? await readSituations()
          : await readTop()
        : last.kind === "group"
          ? await readSubjects(last.id)
          : last.kind === "situation"
            ? await readSituationSubjects(last.id)
            : await readSubject(last.id);
      if (gone) return;
      if ("error" in read) return setError(read.error);
      if ("groups" in read) setGroups(read.groups);
      setLevels((m) => ({ ...m, [key]: "level" in read ? read.level : read }));
    })();
    return () => {
      gone = true;
    };
  }, [moved, level, key, last, arrange]);

  const open = useCallback(
    (p: Pick) => {
      if (level?.kind !== "circles") return;
      const kind: Step["kind"] = level.noun === "groups" ? "group" : level.noun === "situations" ? "situation" : "subject";
      setPath((at) => [...at, { kind, id: p.id, name: p.label }]);
    },
    [level],
  );

  const jump = (s: { id: string; name: string; groupId: string | null }) => {
    const subject: Step = { kind: "subject", id: s.id, name: s.name };
    if (arrange === "situations" || !groups?.length) return setPath([subject]);
    const g = s.groupId ? groups.find((x) => x.id === s.groupId) : null;
    setPath([{ kind: "group", id: g?.id ?? UNGROUPED, name: g?.name ?? "Ungrouped" }, subject]);
  };

  if (!moved) return progress ? null : <Banner tone="info">Your map is drawn here once its subjects have moved into their records: the first time an admin opens this page.</Banner>;

  const top = brand.name || "Your brand";
  const drawn = level?.kind === "circles" ? Math.min(level.items.length, MAX_CIRCLES) : 0;
  const more = level?.kind === "circles" ? level.items.length - drawn : 0;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <nav aria-label="Where you are on the map" className="flex flex-wrap items-center gap-1 text-sm">
          <Crumb current={!path.length} onClick={() => setPath([])}>
            {top}
          </Crumb>
          {path.map((s, i) => (
            <Fragment key={`${s.kind}:${s.id}`}>
              <ChevronRight aria-hidden size={12} className="text-neutral-400" />
              <Crumb current={i === path.length - 1} onClick={() => setPath(path.slice(0, i + 1))}>
                {s.name}
              </Crumb>
            </Fragment>
          ))}
        </nav>
        {level?.kind === "circles" && level.items.length ? (
          <span className="rounded-full bg-neutral-100 px-2.5 py-0.5 text-xs text-neutral-600 dark:bg-neutral-900 dark:text-neutral-300">
            Drawn now: {fmt(drawn)} {level.noun}
            {more ? ` · ${fmt(more)} smaller not drawn` : ""}
          </span>
        ) : null}
      </div>
      <div className="flex flex-wrap items-end justify-between gap-2">
        <JumpToSubject onPick={jump} />
        {situations ? (
          <div role="group" aria-label="Arrange by" className="flex items-center gap-1 text-xs">
            <span className="text-neutral-500">Arrange by</span>
            {(["subjects", "situations"] as const).map((a) => (
              <button
                key={a}
                type="button"
                aria-pressed={arrange === a}
                onClick={() => {
                  setArrange(a);
                  setPath([]);
                }}
                className={`rounded-full border px-2.5 py-0.5 ${arrange === a ? "border-neutral-900 bg-neutral-900 text-white dark:border-white dark:bg-white dark:text-neutral-900" : "border-neutral-300 dark:border-neutral-700"}`}
              >
                {a === "subjects" ? "Subjects" : "Buying situations"}
              </button>
            ))}
          </div>
        ) : null}
      </div>
      <p className="text-xs text-neutral-500">Click a circle to zoom in. Names show when there&apos;s room.</p>
      {error ? <Banner tone="err">{error}</Banner> : null}
      {!level ? (
        error ? null : (
          <p role="status" className="text-sm text-neutral-500">
            Loading…
          </p>
        )
      ) : level.kind === "subject" ? (
        <SubjectLevel read={level.read} brand={brand} homes={homes} programmes={programmes} />
      ) : (
        <CirclesView
          key={key}
          level={level}
          onOpen={open}
          kicker={!last ? "Whole map" : last.kind === "situation" ? "Buying situation" : last.id === UNGROUPED ? "Not in a group yet" : "Group"}
          title={last ? last.name : top}
          atTop={!last}
          more={more}
        />
      )}
    </div>
  );
}

function Crumb({ current, onClick, children }: { current: boolean; onClick: () => void; children: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={current ? "page" : undefined}
      className={`rounded-md px-1.5 py-1 ${current ? "font-semibold text-neutral-900 dark:text-white" : "font-medium text-blue-600 hover:underline dark:text-blue-400"}`}
    >
      {children}
    </button>
  );
}

/** Find a subject by name and go straight to it. Every name is read once, the first time. */
function JumpToSubject({ onPick }: { onPick: (s: { id: string; name: string; groupId: string | null }) => void }) {
  const [names, setNames] = useState<Array<SubjectName & { groupId: string | null }> | null>(null);
  const [query, setQuery] = useState("");
  const load = () => {
    if (names) return;
    void api<{ subjects?: Array<SubjectName & { groupId: string | null }> }>(`${MAP}/subjects/names`).then((r) => setNames(r.data.subjects ?? []));
  };
  const found = useMemo(() => (names && query.trim() ? matchSubjects(names, query, BIGGEST) : []), [names, query]);
  return (
    <div className="space-y-1.5">
      <label className="block max-w-sm">
        <span className="sr-only">Jump to a subject</span>
        <input type="search" value={query} onFocus={load} onChange={(e) => setQuery(e.target.value)} placeholder="Jump to a subject" className={inputClass} />
      </label>
      {names && query.trim() ? (
        found.length ? (
          <ul aria-label="Matching subjects" className="flex flex-wrap gap-1.5">
            {found.map((s) => (
              <li key={s.id}>
                <button
                  type="button"
                  onClick={() => {
                    onPick(names.find((n) => n.id === s.id) ?? { ...s, groupId: null });
                    setQuery("");
                  }}
                  className="rounded border border-neutral-300 px-2 py-0.5 text-xs hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-800"
                >
                  {s.name}
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-xs text-neutral-500">No subject matches.</p>
        )
      ) : null}
    </div>
  );
}

type BubbleData = { c: PackCircle; onOpen: (p: Pick) => void };

function BubbleNode({ data }: NodeProps<Node<BubbleData>>) {
  const { c, onOpen } = data;
  // The zoom in eighths, so circles redraw only as a name comes or goes.
  const zoom = useStore((s) => Math.max(0.125, Math.round(s.transform[2] * 8) / 8));
  const onScreen = c.r * zoom;
  const said = `${c.label}${c.score ? `, ${c.score}` : ""}${c.proposed ? ", proposed and waiting for you" : ""}`;
  return (
    <button
      type="button"
      onClick={() => onOpen(c)}
      aria-label={said}
      title={said}
      style={{ width: 2 * c.r, height: 2 * c.r }}
      className={`nodrag nopan relative block rounded-full border hover:border-neutral-900 focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-600 dark:hover:border-white ${
        c.proposed ? "border-dashed border-neutral-500" : "border-slate-300 dark:border-slate-700"
      }`}
    >
      {onScreen >= LABEL_R ? (
        <span
          aria-hidden
          className="pointer-events-none absolute left-1/2 top-1/2 rounded-md bg-white/90 px-1.5 py-0.5 text-center leading-tight text-neutral-900 dark:bg-neutral-900/90 dark:text-neutral-100"
          // Kept the same size on screen whatever the zoom.
          style={{ width: Math.min(220, 1.6 * onScreen), fontSize: 11, transform: `translate(-50%, -50%) scale(${1 / zoom})` }}
        >
          <span className="line-clamp-2 break-words font-medium">{c.label}</span>
          {onScreen >= SCORE_R && c.score ? <span className="block text-[10px] text-neutral-500 dark:text-neutral-400">{c.score}</span> : null}
        </span>
      ) : null}
    </button>
  );
}

const NODE_TYPES = { bubble: BubbleNode };

function CirclesView({
  level,
  onOpen,
  kicker,
  title,
  atTop,
  more,
}: {
  level: CirclesLevel;
  onOpen: (p: Pick) => void;
  kicker: string;
  title: string;
  atTop: boolean;
  more: number;
}) {
  const colorMode = useAdminColorMode();
  const packed = useMemo(() => packLevel(level.items, { width: W, height: H }), [level.items]);
  const nodes = useMemo(
    () =>
      packed.circles.map(
        (c): Node<BubbleData> => ({
          id: c.id,
          type: "bubble",
          position: { x: c.x - c.r, y: c.y - c.r },
          data: { c, onOpen },
          width: 2 * c.r,
          height: 2 * c.r,
          zIndex: 2,
          selectable: false,
          draggable: false,
        }),
      ),
    [packed, onOpen],
  );
  const totals = levelTotals(level.items);
  const groups = level.items.filter((i) => i.id !== UNGROUPED).length;
  const biggest = [...level.items].sort((a, b) => b.value - a.value || a.label.localeCompare(b.label)).slice(0, BIGGEST);
  const line = [
    ...(level.noun === "groups" ? [`${fmt(groups)} ${groups === 1 ? "group" : "groups"}`] : []),
    level.noun === "situations"
      ? `${fmt(level.items.length)} buying ${level.items.length === 1 ? "situation" : "situations"}`
      : `${fmt(totals.subjects)} ${totals.subjects === 1 ? "subject" : "subjects"}`,
    `${fmt(totals.answered)} of ${fmt(totals.questions)} questions answered`,
    ...(totals.proposed ? [`${fmt(totals.proposed)} proposed, waiting for you`] : []),
  ].join(" · ");

  if (!level.items.length) {
    return (
      <Banner tone="info">
        {level.noun === "situations"
          ? "No buying situations yet. Find them on the Buying situations tab."
          : atTop
            ? "No subjects yet. Add them on the Subjects tab, or let research propose some."
            : "Nothing here yet. Add subjects to it on the Subjects tab."}
      </Banner>
    );
  }

  return (
    <div className="flex flex-wrap items-start gap-4">
      <div className="min-w-0 flex-[3_1_520px] space-y-2">
        <div className="h-[560px] overflow-hidden rounded-lg border border-neutral-200 bg-neutral-50 dark:border-neutral-800 dark:bg-neutral-950">
          <ReactFlow
            nodes={nodes}
            edges={[]}
            nodeTypes={NODE_TYPES}
            colorMode={colorMode}
            style={{ background: "transparent" }}
            nodesDraggable={false}
            nodesConnectable={false}
            nodesFocusable={false}
            edgesFocusable={false}
            elementsSelectable={false}
            minZoom={0.3}
            maxZoom={16}
            fitView
            fitViewOptions={{ padding: 0.04 }}
            proOptions={{ hideAttribution: true }}
          >
            <ViewportPortal>
              {/* Under the circles' buttons (and their names): every fill and every dot, one path each. */}
              <svg aria-hidden width={W} height={H} viewBox={`0 0 ${W} ${H}`} className="pointer-events-none absolute left-0 top-0 overflow-visible" style={{ zIndex: 1 }}>
                <path d={packed.rings.decided} className="fill-white dark:fill-neutral-900" />
                <path d={packed.rings.proposed} className="fill-neutral-100/70 dark:fill-neutral-900/50" />
                <path d={packed.dots.open} className="fill-neutral-300 dark:fill-neutral-600" />
                <path d={packed.dots.drafted} className="fill-blue-300 dark:fill-blue-800" />
                <path d={packed.dots.answered} className="fill-blue-600 dark:fill-blue-400" />
              </svg>
            </ViewportPortal>
            <Controls showInteractive={false} />
          </ReactFlow>
        </div>
        <Legend dotIs={level.noun === "groups" ? "subject" : "question"} />
      </div>
      <aside aria-label="Details" className="min-w-0 flex-[1_1_280px] space-y-2 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
        <div className="text-[11px] font-semibold uppercase tracking-wide text-neutral-500">{kicker}</div>
        <h2 className="text-base font-semibold">{title}</h2>
        <p className="text-sm text-neutral-600 dark:text-neutral-300">{line}</p>
        <div className="space-y-1 pt-1">
          <span className={smallLabel}>{level.noun === "groups" ? "Biggest groups" : level.noun === "situations" ? "Biggest buying situations" : "Biggest subjects"}</span>
          <ul className="space-y-1">
            {biggest.map((i) => (
              <li key={i.id}>
                <button
                  type="button"
                  onClick={() => onOpen(i)}
                  className={`flex w-full flex-wrap items-center gap-2 rounded-md border px-2 py-1.5 text-left text-sm hover:bg-neutral-50 dark:hover:bg-neutral-900 ${
                    i.proposed ? "border-dashed border-neutral-400" : "border-neutral-200 dark:border-neutral-800"
                  }`}
                >
                  <span className="min-w-0 flex-1 break-words">{i.label}</span>
                  <span className="flex items-center gap-1.5 text-[11px] text-neutral-500">
                    <span aria-hidden className="inline-block h-1.5 w-12 overflow-hidden rounded-full bg-neutral-200 dark:bg-neutral-800">
                      <span className="block h-1.5 rounded-full bg-blue-600" style={{ width: `${pct(i.answered, i.questions)}%` }} />
                    </span>
                    {i.score}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
        {more ? (
          <p className="rounded-md border border-neutral-200 bg-neutral-50 px-2.5 py-2 text-xs text-neutral-600 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-300">
            {fmt(more)} smaller {level.noun} aren&apos;t drawn, to keep the map readable. Jump to one by name, or see them all on the Subjects tab.
          </p>
        ) : null}
      </aside>
    </div>
  );
}

function Legend({ dotIs }: { dotIs: "subject" | "question" }) {
  const dot = (cls: string, label: string) => (
    <span className="inline-flex items-center gap-1.5">
      <span aria-hidden className={`inline-block h-2.5 w-2.5 rounded-full ${cls}`} />
      {label}
    </span>
  );
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-neutral-600 dark:text-neutral-400">
      {dot("bg-blue-600 dark:bg-blue-400", "Answered")}
      {dot("bg-blue-300 dark:bg-blue-800", "Drafted or planned")}
      {dot("bg-neutral-300 dark:bg-neutral-600", "Not written yet")}
      <span className="inline-flex items-center gap-1.5">
        <span aria-hidden className="inline-block h-3.5 w-3.5 rounded-full border-[1.5px] border-dashed border-neutral-500" />
        Proposed, waiting for you
      </span>
      <span>{dotIs === "subject" ? "Each dot is a subject, by its furthest-along question." : "Each dot is a question."}</span>
    </div>
  );
}

/** One subject: today's content map, of that subject only. */
function SubjectLevel({
  read,
  brand,
  homes,
  programmes,
}: {
  read: SubjectRead;
  brand: ContentMapInput["brand"];
  homes: ContentMapInput["homes"];
  programmes: Array<{ id: string; name: string }> | null;
}) {
  const input = useMemo((): ContentMapInput | null => {
    if (!read.coverage) return null;
    const s = read.subject;
    return {
      brand,
      coverage: { subjects: [read.coverage], overlaps: read.overlaps, missingLinks: read.missingLinks, answered: {}, siblings: [] },
      pages: read.pages ?? [],
      homes: [...homes, ...(s.home ? [{ url: s.home, label: `${s.name} (a subject)` }] : [])],
    };
  }, [read, brand, homes]);
  if (!input) return <Banner tone="info">Couldn&apos;t work out what your pages answer on this subject just now. Try again in a moment.</Banner>;
  return <BrandMapContentMap key={read.subject.id} input={input} programmes={programmes} subjectId={read.subject.id} />;
}
