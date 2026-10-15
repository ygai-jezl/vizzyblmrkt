"use client";

import { useMemo, useState, type ReactNode } from "react";
import Link from "next/link";
import { Background, Controls, Handle, Position, ReactFlow, type Edge, type Node, type NodeProps } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useAdminColorMode } from "@/components/admin/nav/AdminThemeRoot";
import { layoutContentMap, UNPLACED, type ContentMapInput, type MapPoint, type PointState } from "@/lib/brandMap/contentMapLayout";
import { POINT_LABEL, pointDetails } from "@/lib/brandMap/contentMapDetails";
import { WriteNext } from "./BrandMapCoverage";
import { smallLabel } from "./BrandMapParts";

/**
 * The content map (Brand › Brand map › Content map): the brand's content as a map. Subjects
 * are areas; live articles, drafts, open questions and pages already on the site are points;
 * lines are the links found in the pages, the links they should have, and two pages with the
 * same main question. Click a point to see what it is. The "Names and subjects" tab holds the
 * same facts as a list.
 */

const MARK: Record<PointState | "site", string> = {
  live: "rounded-full border-2 border-white bg-blue-600 ring-1 ring-blue-600 dark:border-neutral-900",
  approved: "rounded-full border-2 border-blue-600 bg-blue-100 dark:bg-blue-900",
  draft: "rounded-full border-2 border-blue-600 bg-blue-100 dark:bg-blue-900",
  planned: "rounded-full border-2 border-dashed border-blue-600 bg-white dark:bg-neutral-900",
  open: "rounded-full border-2 border-dashed border-neutral-500 bg-white dark:bg-neutral-900",
  site: "rounded-[3px] border-2 border-neutral-500 bg-neutral-200 dark:bg-neutral-700",
};
const LINE: Record<"link" | "suggested" | "overlap", { stroke: string; strokeDasharray?: string }> = {
  link: { stroke: "#94a3b8" },
  suggested: { stroke: "#2563eb", strokeDasharray: "5 4" },
  overlap: { stroke: "#d97706", strokeDasharray: "5 4" },
};
const HIDDEN_HANDLE = { left: "50%", top: "50%", transform: "translate(-50%, -50%)", width: 1, height: 1, minWidth: 0, minHeight: 0, border: 0, opacity: 0 };
const SIZE = { point: 16, brand: 52 };

type PointData = { point: MapPoint; selected: boolean; onSelect: (id: string) => void };
const ring = (on: boolean) => (on ? "ring-2 ring-neutral-900 ring-offset-2 dark:ring-white dark:ring-offset-neutral-950" : "");

function PointNode({ data }: NodeProps<Node<PointData>>) {
  const { point, selected, onSelect } = data;
  const mark = point.kind === "site" ? MARK.site : MARK[point.state ?? "open"];
  return (
    <>
      <Handle type="target" position={Position.Top} style={HIDDEN_HANDLE} isConnectable={false} />
      <button
        type="button"
        aria-label={`${point.kind === "site" ? "Page on your site" : POINT_LABEL[point.state ?? "open"]}: ${point.title}`}
        title={point.title}
        aria-pressed={selected}
        onClick={() => onSelect(point.id)}
        className={`nodrag nopan block h-4 w-4 cursor-pointer ${mark} ${ring(selected)}`}
      />
      <Handle type="source" position={Position.Bottom} style={HIDDEN_HANDLE} isConnectable={false} />
    </>
  );
}

function BrandNode({ data }: NodeProps<Node<PointData>>) {
  return (
    <button
      type="button"
      onClick={() => data.onSelect(data.point.id)}
      aria-pressed={data.selected}
      className={`nodrag nopan grid h-[52px] w-[52px] place-items-center rounded-full bg-neutral-900 px-1 text-center text-[10px] font-semibold leading-tight text-white dark:bg-white dark:text-neutral-900 ${ring(data.selected)}`}
    >
      <span className="line-clamp-2 break-words">{data.point.title}</span>
    </button>
  );
}

function AreaNode({ data }: NodeProps<Node<PointData>>) {
  const { point, selected, onSelect } = data;
  const unplaced = point.areaId === UNPLACED;
  return (
    <div
      className={`pointer-events-none h-full w-full rounded-full border border-dashed ${
        unplaced ? "border-neutral-300 bg-neutral-100/40 dark:border-neutral-700 dark:bg-neutral-800/30" : "border-blue-300 bg-blue-50/50 dark:border-blue-900 dark:bg-blue-950/30"
      }`}
    >
      <div className="flex justify-center pt-2">
        <button
          type="button"
          onClick={() => onSelect(point.id)}
          aria-pressed={selected}
          className={`nodrag nopan pointer-events-auto max-w-[80%] truncate rounded-full bg-white px-2 py-0.5 text-[11px] font-medium shadow-sm dark:bg-neutral-900 ${ring(selected)}`}
        >
          {point.title}
          {point.score ? <span className="text-neutral-500"> · {point.score}</span> : null}
        </button>
      </div>
    </div>
  );
}

function MoreNode({ data }: NodeProps<Node<PointData>>) {
  return (
    <button
      type="button"
      onClick={() => data.onSelect(data.point.id)}
      className={`nodrag nopan whitespace-nowrap rounded-full border border-neutral-300 bg-white px-2 py-0.5 text-[11px] text-neutral-600 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-300 ${ring(data.selected)}`}
    >
      {data.point.title}
    </button>
  );
}

const NODE_TYPES = { point: PointNode, brand: BrandNode, area: AreaNode, more: MoreNode };

/** A node's top-left from its point's centre. */
function toNode(p: MapPoint, selected: boolean, onSelect: (id: string) => void): Node<PointData> {
  const data = { point: p, selected, onSelect };
  if (p.kind === "area") {
    const d = (p.radius ?? 120) * 2;
    return { id: p.id, type: "area", position: { x: p.x - d / 2, y: p.y - d / 2 }, data, width: d, height: d, zIndex: 0, selectable: false };
  }
  if (p.kind === "brand") return { id: p.id, type: "brand", position: { x: p.x - SIZE.brand / 2, y: p.y - SIZE.brand / 2 }, data, zIndex: 2, selectable: false };
  if (p.kind === "more") return { id: p.id, type: "more", position: { x: p.x - 32, y: p.y - 10 }, data, zIndex: 2, selectable: false };
  return { id: p.id, type: "point", position: { x: p.x - SIZE.point / 2, y: p.y - SIZE.point / 2 }, data, zIndex: 3, selectable: false };
}

export function BrandMapContentMap({ input, programmes }: { input: ContentMapInput; programmes: Array<{ id: string; name: string }> | null }) {
  const colorMode = useAdminColorMode();
  const [subjectId, setSubjectId] = useState<string>("");
  const [showOpen, setShowOpen] = useState(true);
  const [showSuggested, setShowSuggested] = useState(true);
  const [selected, setSelected] = useState<string>("brand");

  const layout = useMemo(
    () => layoutContentMap(input, { subjectId: subjectId || null, showOpen, showSuggested }),
    [input, subjectId, showOpen, showSuggested],
  );
  const nodes = useMemo(() => layout.points.map((p) => toNode(p, p.id === selected, setSelected)), [layout, selected]);
  const edges = useMemo<Edge[]>(
    () =>
      layout.lines.map((l) => ({
        id: l.id,
        source: l.from,
        target: l.to,
        type: "straight",
        style: { ...LINE[l.kind], strokeWidth: 1.5 },
        focusable: false,
        selectable: false,
      })),
    [layout],
  );
  const point = layout.points.find((p) => p.id === selected) ?? layout.points[0]!;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <label className="flex items-center gap-2">
          <span className="text-neutral-600 dark:text-neutral-400">Show</span>
          <select
            value={subjectId}
            onChange={(e) => {
              setSubjectId(e.target.value);
              setSelected("brand");
            }}
            className="rounded-md border border-neutral-300 bg-white px-2 py-1 text-sm dark:border-neutral-700 dark:bg-neutral-950"
          >
            <option value="">All subjects</option>
            {input.coverage.subjects.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-1.5">
          <input type="checkbox" checked={showSuggested} onChange={(e) => setShowSuggested(e.target.checked)} />
          Suggested links
        </label>
        <label className="flex items-center gap-1.5">
          <input type="checkbox" checked={showOpen} onChange={(e) => setShowOpen(e.target.checked)} />
          Questions not written yet
        </label>
      </div>

      <div className="flex flex-wrap items-start gap-4">
        <div className="min-w-0 flex-[3_1_520px] space-y-2">
          <div className="h-[560px] overflow-hidden rounded-lg border border-neutral-200 dark:border-neutral-800">
            <ReactFlow
              key={`${subjectId}|${showOpen}|${showSuggested}`}
              nodes={nodes}
              edges={edges}
              nodeTypes={NODE_TYPES}
              colorMode={colorMode}
              nodesDraggable={false}
              nodesConnectable={false}
              nodesFocusable={false}
              edgesFocusable={false}
              elementsSelectable={false}
              minZoom={0.15}
              fitView
              fitViewOptions={{ padding: 0.12 }}
            >
              <Background />
              <Controls showInteractive={false} />
            </ReactFlow>
          </div>
          <Legend />
        </div>
        <aside aria-label="Details" className="min-w-0 flex-[1_1_280px] space-y-2 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
          <Details
            point={point}
            input={input}
            programmes={programmes}
            onShowSubject={(id) => {
              setSubjectId(id);
              setSelected(`area:${id}`);
            }}
          />
        </aside>
      </div>
    </div>
  );
}

function Legend() {
  const item = (mark: string, label: string) => (
    <span className="inline-flex items-center gap-1.5">
      <span aria-hidden className={`inline-block h-3 w-3 ${mark}`} />
      {label}
    </span>
  );
  const line = (style: { stroke: string; strokeDasharray?: string }, label: string) => (
    <span className="inline-flex items-center gap-1.5">
      <svg aria-hidden width="22" height="4">
        <line x1="0" y1="2" x2="22" y2="2" stroke={style.stroke} strokeWidth="2" strokeDasharray={style.strokeDasharray} />
      </svg>
      {label}
    </span>
  );
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-neutral-600 dark:text-neutral-400">
      {item(MARK.live, "Live article")}
      {item(MARK.draft, "Draft")}
      {item(MARK.planned, "Planned")}
      {item(MARK.open, "Question not written yet")}
      {item(MARK.site, "Page on your site")}
      {line(LINE.link, "Link")}
      {line(LINE.suggested, "Suggested link")}
      {line(LINE.overlap, "Same question twice")}
    </div>
  );
}

const ACTION_PRIMARY =
  "inline-flex items-center rounded-md bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-neutral-700 dark:bg-white dark:text-neutral-900";
const ACTION_SECONDARY =
  "inline-flex items-center rounded-md border border-neutral-300 px-3 py-1.5 text-sm font-medium hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900";

/** What a point is, and what to do with it. */
function Details({
  point,
  input,
  programmes,
  onShowSubject,
}: {
  point: MapPoint;
  input: ContentMapInput;
  programmes: Array<{ id: string; name: string }> | null;
  onShowSubject: (subjectId: string) => void;
}) {
  const view = useMemo(() => pointDetails(point, input), [point, input]);
  const { actions } = view;
  const buttons: ReactNode[] = [];
  if (actions.open) {
    buttons.push(
      <Link key="open" href={actions.open} className={ACTION_PRIMARY}>
        Open article
      </Link>,
    );
  }
  if (actions.view) {
    buttons.push(
      <a key="view" href={actions.view} target="_blank" rel="noopener noreferrer" className={actions.open ? ACTION_SECONDARY : ACTION_PRIMARY}>
        View page
      </a>,
    );
  }
  if (actions.writeNext && programmes?.length) buttons.push(<WriteNext key="write" questionId={actions.writeNext} programmes={programmes} />);
  if (actions.showSubject) {
    buttons.push(
      <button key="subject" type="button" className={ACTION_SECONDARY} onClick={() => onShowSubject(actions.showSubject!)}>
        Show only this subject
      </button>,
    );
  }
  return (
    <>
      {view.kicker ? <div className="text-[11px] font-semibold uppercase tracking-wide text-neutral-500">{view.kicker}</div> : null}
      <h2 className="text-base font-semibold">{view.title}</h2>
      {view.text ? <p className="text-sm text-neutral-600 dark:text-neutral-300">{view.text}</p> : null}
      {view.badge ? (
        <span className="inline-block rounded bg-blue-50 px-1.5 py-0.5 text-xs font-medium text-blue-700 dark:bg-blue-950 dark:text-blue-300">{view.badge}</span>
      ) : null}
      {view.lists.map((l) =>
        l.items.length || l.empty ? (
          <div key={l.head} className="space-y-1 pt-1">
            <span className={smallLabel}>{l.head}</span>
            {l.items.length ? (
              <ul className="space-y-0.5 text-sm">
                {l.items.map((t, i) => (
                  <li key={`${i}-${t}`} className="break-words">
                    {t}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-neutral-500">{l.empty}</p>
            )}
          </div>
        ) : null,
      )}
      {view.notes.map((n) => (
        <p
          key={n.text}
          className={`rounded-md border px-2.5 py-2 text-xs ${
            n.tone === "warn"
              ? "border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300"
              : "border-neutral-200 bg-neutral-50 text-neutral-600 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-300"
          }`}
        >
          {n.text}
        </p>
      ))}
      {buttons.length ? <div className="flex flex-wrap gap-2 pt-2">{buttons}</div> : null}
    </>
  );
}
