"use client";

import { useState } from "react";

/**
 * Agent 3 — Creative Director side-panel docked beside the email preview. Lets
 * the operator brief the agent, get performance-informed copy variants (click to
 * apply), generate a Vertex Imagen hero image, and see prior-send performance.
 */
export interface CopyVariant {
  subject: string;
  body: string;
}

/** Operator-facing messages keyed by the API's failure `reason`. */
const IMAGE_ERROR_DEFAULT = "Image generation is unavailable right now.";
const IMAGE_ERRORS: Record<string, string> = {
  no_asset_bucket: "Image storage isn't configured (EMAIL_ASSET_BUCKET).",
  store_failed: "The image was generated but couldn't be saved to storage. Try again.",
  image_model_unavailable: IMAGE_ERROR_DEFAULT,
};

export function CreativeDirectorPanel({
  campaignId,
  performanceHint,
  onApplyVariant,
  onApplyImage,
}: {
  campaignId: string;
  performanceHint?: string;
  onApplyVariant: (v: CopyVariant) => void;
  onApplyImage: (url: string) => void;
}) {
  const [brief, setBrief] = useState("");
  const [variants, setVariants] = useState<CopyVariant[]>([]);
  const [source, setSource] = useState<"agent3" | "fallback" | null>(null);
  const [loadingCopy, setLoadingCopy] = useState(false);
  const [loadingImage, setLoadingImage] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  async function draft() {
    if (!brief.trim()) {
      setNote("Add a short brief first.");
      return;
    }
    setLoadingCopy(true);
    setNote(null);
    try {
      const res = await fetch("/api/admin/email/assist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ campaignId, brief }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setNote("Couldn't draft copy. Try again.");
        return;
      }
      setVariants(Array.isArray(data.variants) ? data.variants : []);
      setSource(data.source ?? null);
      if (data.source === "fallback") {
        setNote("Model unavailable — showing a templated draft you can edit.");
      }
    } finally {
      setLoadingCopy(false);
    }
  }

  async function generateImage() {
    if (!brief.trim()) {
      setNote("Describe the image in the brief first.");
      return;
    }
    setLoadingImage(true);
    setNote(null);
    try {
      const res = await fetch("/api/admin/email/image", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ campaignId, brief }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.imageUrl) {
        onApplyImage(data.imageUrl as string);
        setNote("Hero image added.");
      } else {
        setNote(IMAGE_ERRORS[data.reason as string] ?? IMAGE_ERROR_DEFAULT);
      }
    } finally {
      setLoadingImage(false);
    }
  }

  return (
    <aside className="flex flex-col gap-3 rounded-lg border border-violet-200 bg-violet-50/40 p-3 dark:border-violet-900/50 dark:bg-violet-950/20">
      <div className="flex items-center gap-2">
        <span className="text-sm font-semibold text-violet-900 dark:text-violet-200">
          ✨ Agent 3 · Creative Director
        </span>
      </div>

      <label className="text-xs font-medium text-neutral-600 dark:text-neutral-300">
        Brief
        <textarea
          value={brief}
          onChange={(e) => setBrief(e.target.value)}
          rows={3}
          placeholder="e.g. tease the launch date, upbeat, nudge referrals"
          className="mt-1 w-full rounded-md border border-neutral-300 bg-white px-2 py-1.5 text-sm dark:border-neutral-700 dark:bg-neutral-900"
        />
      </label>

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={draft}
          disabled={loadingCopy}
          className="rounded-md bg-violet-600 px-3 py-1 text-sm font-medium text-white hover:bg-violet-700 disabled:opacity-60"
        >
          {loadingCopy ? "Drafting…" : "✨ Draft copy options"}
        </button>
        <button
          type="button"
          onClick={generateImage}
          disabled={loadingImage}
          className="rounded-md border border-violet-300 px-3 py-1 text-sm text-violet-800 hover:bg-violet-100 disabled:opacity-60 dark:border-violet-800 dark:text-violet-200 dark:hover:bg-violet-900/40"
        >
          {loadingImage ? "Generating…" : "🖼 Generate image"}
        </button>
      </div>

      {note ? (
        <p className="text-xs text-neutral-500 dark:text-neutral-400">{note}</p>
      ) : null}

      {variants.length > 0 ? (
        <div className="space-y-2">
          <p className="text-xs font-medium text-neutral-500">
            Variants {source === "agent3" ? "(Agent 3)" : "(templated)"} — click to
            apply
          </p>
          {variants.map((v, i) => (
            <button
              key={i}
              type="button"
              onClick={() => onApplyVariant(v)}
              className="block w-full rounded-md border border-neutral-200 bg-white p-2 text-left hover:border-violet-400 dark:border-neutral-800 dark:bg-neutral-900"
            >
              <span className="block truncate text-sm font-medium">
                {v.subject || "(no subject)"}
              </span>
              <span className="mt-0.5 block max-h-10 overflow-hidden text-xs text-neutral-500">
                {stripHtml(v.body).slice(0, 120)}
              </span>
            </button>
          ))}
        </div>
      ) : null}

      <div className="mt-1 rounded-md bg-white/60 p-2 text-xs text-neutral-500 dark:bg-neutral-900/40">
        📊 {performanceHint ?? "No prior sends yet — Agent 3 learns from each send."}
      </div>
    </aside>
  );
}

function stripHtml(s: string): string {
  return s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}
