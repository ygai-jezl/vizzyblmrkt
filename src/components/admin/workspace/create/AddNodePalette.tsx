"use client";

import { useState } from "react";
import { CHANNELS, channelLabel } from "@/lib/content/channels";
import { CORE_ANGLES, frameworkLabel } from "@/lib/content/frameworks";
import type { ContentNodeType } from "@/lib/types/contentPlan";
import type { TemplateOption } from "./types";

/**
 * Slim, collapsible node palette docked to the left edge of the canvas (rendered
 * inside a React Flow <Panel>). Collapsed = a thin "＋" rail; expanded = pickers to
 * add a node. You can add an ANGLE spoke (a content angle × channel), a node from a
 * saved (templatized) template, or a pre/post promo. Adding drops an empty node on the
 * canvas; wire it by dragging from a handle and configure it in the inspector.
 */
const SPOKE_CHANNELS = CHANNELS.filter((c) => !["newsletter", "blog", "standalone"].includes(c.id));
const MINI =
  "w-full rounded border border-neutral-300 px-2 py-1 text-[11px] dark:border-neutral-700 dark:bg-neutral-900";
const ADD_BTN =
  "w-full rounded border border-neutral-300 px-2 py-1 text-[11px] hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-800";

export function AddNodePalette({
  onAdd,
  templates,
}: {
  onAdd: (
    type: ContentNodeType,
    channel: string,
    opts?: { framework?: string | null; templateId?: string | null },
  ) => void;
  templates: TemplateOption[];
}) {
  const [open, setOpen] = useState(false);
  const [angle, setAngle] = useState<string>(CORE_ANGLES[0]);
  const [spokeCh, setSpokeCh] = useState<string>(SPOKE_CHANNELS[0]?.id ?? "linkedin");

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        title="Add node"
        className="flex h-10 w-9 items-center justify-center rounded-md border border-neutral-300 bg-white text-lg shadow-sm hover:bg-neutral-50 dark:border-neutral-700 dark:bg-neutral-900 dark:hover:bg-neutral-800"
      >
        ＋
      </button>
    );
  }

  return (
    <div className="w-56 rounded-md border border-neutral-300 bg-white p-3 shadow-md dark:border-neutral-700 dark:bg-neutral-900">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-xs font-semibold">Add node</span>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="rounded p-0.5 text-neutral-400 hover:text-neutral-700"
          aria-label="Close palette"
        >
          ✕
        </button>
      </div>

      <div className="mb-1 text-[10px] font-medium uppercase tracking-wide text-neutral-400">Angle spoke</div>
      <div className="mb-3 space-y-1">
        <select value={angle} onChange={(e) => setAngle(e.target.value)} className={MINI} aria-label="Content angle">
          {CORE_ANGLES.map((id) => (
            <option key={id} value={id}>
              {frameworkLabel(id)}
            </option>
          ))}
        </select>
        <select value={spokeCh} onChange={(e) => setSpokeCh(e.target.value)} className={MINI} aria-label="Channel">
          {SPOKE_CHANNELS.map((c) => (
            <option key={c.id} value={c.id}>
              {channelLabel(c.id)}
            </option>
          ))}
        </select>
        <button type="button" onClick={() => onAdd("spoke", spokeCh, { framework: angle })} className={ADD_BTN}>
          ＋ Add angle spoke
        </button>
      </div>

      {templates.length ? (
        <>
          <div className="mb-1 text-[10px] font-medium uppercase tracking-wide text-neutral-400">From template</div>
          <select
            value=""
            onChange={(e) => {
              const t = templates.find((x) => x.id === e.target.value);
              if (!t) return;
              // Added as a spoke that fills the chosen template's skeleton (its channel
              // must match for the generate route to honor the template).
              onAdd("spoke", t.channel ?? "standalone", { templateId: t.id });
            }}
            className={`mb-3 ${MINI}`}
            aria-label="Add from saved template"
          >
            <option value="">Choose a saved template…</option>
            {templates.map((t) => (
              <option key={t.id} value={t.id}>
                {t.title}
                {t.channel ? ` · ${channelLabel(t.channel)}` : ""}
              </option>
            ))}
          </select>
        </>
      ) : null}

      <div className="mb-1 text-[10px] font-medium uppercase tracking-wide text-neutral-400">Promo</div>
      <div className="flex flex-col gap-1">
        <button
          type="button"
          onClick={() => onAdd("promo_pre", "linkedin")}
          className="rounded border border-neutral-300 px-2 py-1 text-left text-[11px] hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-800"
        >
          ✦ Pre-hub teaser
        </button>
        <button
          type="button"
          onClick={() => onAdd("promo_post", "linkedin")}
          className="rounded border border-neutral-300 px-2 py-1 text-left text-[11px] hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-800"
        >
          ✦ Post-hub promo
        </button>
      </div>

      <p className="mt-3 text-[10px] leading-snug text-neutral-400">
        Drag from a node&apos;s dots to connect it. Click a node to tune its angle / template.
      </p>
    </div>
  );
}
