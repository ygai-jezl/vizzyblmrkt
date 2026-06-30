"use client";

import { useState } from "react";
import type { Template } from "@/lib/types/template";
import { CHANNELS } from "@/lib/content/channels";

const TARGET_CHANNELS = CHANNELS.filter((c) => c.id !== "standalone");

/** Deconstruct a template into channel-native spokes (Transformation Matrix). */
export function DeconstructControl({
  workspaceId,
  template,
  onDeconstructed,
}: {
  workspaceId: string;
  template: Template;
  onDeconstructed: (spokes: Template[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [channels, setChannels] = useState<string[]>(["linkedin", "x", "newsletter"]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(false);

  function toggle(id: string) {
    setChannels((prev) =>
      prev.includes(id) ? prev.filter((c) => c !== id) : prev.length < 4 ? [...prev, id] : prev,
    );
  }

  async function run() {
    setBusy(true);
    setErr(false);
    try {
      const res = await fetch(
        `/api/admin/workspace/${workspaceId}/templates/${template.id}/deconstruct`,
        { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ channels }) },
      );
      const d = (await res.json().catch(() => ({}))) as { spokes?: Template[] };
      if (res.ok && Array.isArray(d.spokes)) {
        onDeconstructed(d.spokes);
        setOpen(false);
      } else {
        setErr(true);
      }
    } catch {
      setErr(true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-1 text-xs">
      <button
        onClick={() => setOpen((o) => !o)}
        className="rounded-md border border-neutral-300 px-2 py-0.5 text-xs text-neutral-600 dark:border-neutral-700 dark:text-neutral-300"
      >
        ⤳ Deconstruct into channels
      </button>
      {open ? (
        <div className="space-y-2 rounded border border-neutral-200 p-2 dark:border-neutral-700">
          <div className="flex flex-wrap gap-2">
            {TARGET_CHANNELS.map((c) => (
              <label key={c.id} className="flex items-center gap-1">
                <input
                  type="checkbox"
                  checked={channels.includes(c.id)}
                  onChange={() => toggle(c.id)}
                  disabled={!channels.includes(c.id) && channels.length >= 4}
                />
                {c.label}
              </label>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={run}
              disabled={busy || !channels.length}
              className="rounded-md border border-violet-600 bg-violet-600 px-2 py-0.5 text-xs text-white disabled:opacity-50"
            >
              {busy ? "Deconstructing…" : "Generate spokes"}
            </button>
            {err ? <span className="text-red-600 dark:text-red-400">failed</span> : null}
          </div>
          <p className="text-[11px] text-neutral-400">
            Up to 4 channels. Hubs are split into blocks first; this runs several Gemini calls.
          </p>
        </div>
      ) : null}
    </div>
  );
}
