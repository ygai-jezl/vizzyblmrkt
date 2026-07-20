"use client";

import { useState } from "react";
import { ImageOff } from "lucide-react";
import { Modal } from "@/components/admin/email/Modal";
import type { ImageAsset } from "@/lib/types/imageAsset";
import { imageAssetProxyUrl } from "@/lib/content/brandKit";

function Field({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div className="rounded-md border border-neutral-200 p-3 dark:border-neutral-800">
      <div className="text-xs uppercase tracking-wide text-neutral-400">{label}</div>
      <div className="mt-0.5 break-words text-sm">{value || "—"}</div>
    </div>
  );
}

const KIND_LABEL: Record<string, string> = {
  social: "Social",
  ebook: "eBook",
  customized: "Customised",
  upload: "Upload",
};

function formatDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

/**
 * Image detail + Customise. Shows the asset's metadata and lets the operator generate a
 * NEW image from it via Nano Banana 2 (image-to-image edit). Non-destructive: the source
 * shown here is never mutated; on success the new asset is handed to `onCustomized` (the
 * gallery prepends it) and a confirmation is shown inline.
 */
export function ImageDetailModal({
  asset,
  onClose,
  onCustomized,
}: {
  asset: ImageAsset;
  onClose: () => void;
  onCustomized: (asset: ImageAsset) => void;
}) {
  const [broken, setBroken] = useState(false);
  const [instruction, setInstruction] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function customise() {
    if (!instruction.trim() || busy) return;
    setBusy(true);
    setError(null);
    setDone(false);
    try {
      const res = await fetch(`/api/admin/brand-kit/images/${asset.id}/customize`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ instruction: instruction.trim() }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        image?: ImageAsset;
        message?: string;
      };
      if (!res.ok || !data.image) {
        setError(data.message ?? "Customise failed — try again.");
        return;
      }
      onCustomized(data.image);
      setInstruction("");
      setDone(true);
    } catch {
      // Network-level failure (offline / dropped connection) — fetch rejects rather than
      // returning a non-ok response, so surface it instead of silently resetting.
      setError("Customise failed — check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open onClose={onClose} title={asset.title || "Image details"} wide>
      <div className="grid gap-5 md:grid-cols-2">
        {/* Image */}
        <div className="grid max-h-[70vh] place-items-center overflow-hidden rounded-md border border-neutral-200 bg-neutral-50 p-2 dark:border-neutral-800 dark:bg-neutral-900">
          {broken ? (
            <div className="grid place-items-center gap-2 p-10 text-neutral-300 dark:text-neutral-600">
              <ImageOff size={32} />
              <span className="text-xs">Image unavailable</span>
            </div>
          ) : (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={imageAssetProxyUrl(asset)}
              alt={asset.title || asset.prompt || "Generated image"}
              onError={() => setBroken(true)}
              className="max-h-[66vh] w-full object-contain"
            />
          )}
        </div>

        {/* Metadata + Customise */}
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-2">
            <Field label="Kind" value={KIND_LABEL[asset.kind] ?? asset.kind} />
            <Field label="Created" value={formatDate(asset.createdAt)} />
            <Field label="Aspect" value={asset.aspect} />
            <Field label="Style" value={asset.style} />
            <Field label="Channel" value={asset.channel} />
            <Field label="Workspace" value={asset.workspaceId} />
          </div>
          <Field label="Prompt" value={asset.prompt} />
          {asset.brief && asset.brief !== asset.prompt ? (
            <Field label="Brief" value={asset.brief} />
          ) : null}
          {asset.parentAssetId ? (
            <Field label="Lineage" value={`Customised from ${asset.parentAssetId}`} />
          ) : null}

          <div className="space-y-2 rounded-md border border-neutral-200 p-3 dark:border-neutral-800">
            <div className="text-xs uppercase tracking-wide text-neutral-400">Customise</div>
            <p className="text-xs text-neutral-500 dark:text-neutral-400">
              Describe a change — a new image is generated (the original is kept).
            </p>
            <textarea
              value={instruction}
              onChange={(e) => setInstruction(e.target.value)}
              rows={3}
              maxLength={1000}
              placeholder="e.g. make the background navy blue and add soft studio lighting"
              className="w-full rounded-md border border-neutral-300 px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
            />
            {error ? <p className="text-xs text-red-600 dark:text-red-400">{error}</p> : null}
            {done ? (
              <p className="text-xs text-green-600 dark:text-green-400">
                Created — the new image was added to your library ✓
              </p>
            ) : null}
            <button
              type="button"
              disabled={busy || !instruction.trim()}
              onClick={customise}
              className="w-full rounded-md bg-neutral-900 py-2 text-sm font-medium text-white hover:bg-neutral-800 disabled:opacity-60 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-100"
            >
              {busy ? "Generating…" : "Customise image"}
            </button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
