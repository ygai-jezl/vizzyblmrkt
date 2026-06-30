"use client";

import { useState } from "react";
import type { Template } from "@/lib/types/template";
import { CONTENT_FRAMEWORKS } from "@/lib/content/frameworks";

/** Re-run templatize on a template's source content with a chosen style + granularity. */
export function ReframeControl({
  workspaceId,
  template,
  onReframed,
}: {
  workspaceId: string;
  template: Template;
  onReframed: (t: Template) => void;
}) {
  const [framework, setFramework] = useState(template.framework ?? "");
  const [granularity, setGranularity] = useState<"coarse" | "normal" | "fine">("normal");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(false);

  async function reframe() {
    setBusy(true);
    setErr(false);
    try {
      const body: Record<string, string> = {};
      if (framework) body.framework = framework;
      if (granularity !== "normal") body.granularity = granularity;
      const res = await fetch(
        `/api/admin/workspace/${workspaceId}/templates/${template.id}/retemplatize`,
        { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
      );
      const d = (await res.json().catch(() => ({}))) as { template?: Template };
      if (res.ok && d.template) onReframed(d.template);
      else setErr(true);
    } catch {
      setErr(true);
    } finally {
      setBusy(false);
    }
  }

  const sel = "rounded border border-neutral-300 px-1 py-0.5 text-xs dark:border-neutral-700 dark:bg-neutral-900";
  return (
    <div className="flex flex-wrap items-center gap-1 text-xs">
      <select value={framework} onChange={(e) => setFramework(e.target.value)} className={sel}>
        <option value="">Auto style</option>
        {CONTENT_FRAMEWORKS.map((f) => (
          <option key={f.id} value={f.id}>
            {f.label}
          </option>
        ))}
      </select>
      <select
        value={granularity}
        onChange={(e) => setGranularity(e.target.value as "coarse" | "normal" | "fine")}
        className={sel}
      >
        <option value="coarse">Coarse</option>
        <option value="normal">Normal</option>
        <option value="fine">Fine</option>
      </select>
      <button
        onClick={reframe}
        disabled={busy}
        className="rounded-md border border-violet-500 px-2 py-0.5 text-xs text-violet-700 disabled:opacity-50 dark:text-violet-300"
      >
        {busy ? "Reframing…" : "↻ Reframe"}
      </button>
      {err ? <span className="text-red-600 dark:text-red-400">failed</span> : null}
    </div>
  );
}
