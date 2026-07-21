"use client";

import { useCallback, useDeferredValue, useMemo, useRef, useState } from "react";
import { ImageOff, ThumbsUp, ThumbsDown, ImagePlus } from "lucide-react";
import type { ImageAsset } from "@/lib/types/imageAsset";
import { imageAssetProxyUrl } from "@/lib/content/brandKit";
import { ImageDetailModal } from "./ImageDetailModal";

/** The fields a free-text query matches against (client-side, over the loaded set). */
function haystack(a: ImageAsset): string {
  return [a.title, a.prompt, a.brief, a.kind, a.style, a.channel]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

const KIND_LABEL: Record<string, string> = {
  social: "Social",
  ebook: "eBook",
  customized: "Customised",
  upload: "Upload",
};

export function ImagesGallery({
  initialImages,
  initialCursor,
}: {
  initialImages: ImageAsset[];
  initialCursor: string | null;
}) {
  const [rows, setRows] = useState<ImageAsset[]>(initialImages);
  const [cursor, setCursor] = useState<string | null>(initialCursor);
  const [q, setQ] = useState("");
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selected, setSelected] = useState<ImageAsset | null>(null);

  const deferredQ = useDeferredValue(q);
  const visible = useMemo(() => {
    const needle = deferredQ.trim().toLowerCase();
    if (!needle) return rows;
    return rows.filter((r) => haystack(r).includes(needle));
  }, [rows, deferredQ]);

  const loadMore = useCallback(async () => {
    if (!cursor) return;
    setLoading(true);
    setLoadError(null);
    try {
      const p = new URLSearchParams({ cursor });
      const res = await fetch(`/api/admin/brand-kit/images?${p.toString()}`);
      const data = (await res.json().catch(() => ({}))) as {
        images?: ImageAsset[];
        nextCursor?: string | null;
      };
      setRows((prev) => [...prev, ...(data.images ?? [])]);
      setCursor(data.nextCursor ?? null);
    } catch {
      // Network-level failure — fetch rejects (vs. an error status). Surface it so the
      // click isn't a silent no-op; the cursor is preserved so the user can retry.
      setLoadError("Couldn't load more images — check your connection and try again.");
    } finally {
      setLoading(false);
    }
  }, [cursor]);

  // Prepend a freshly-customised or seed-uploaded image so it shows immediately.
  const prepend = useCallback((asset: ImageAsset) => {
    setRows((prev) => [asset, ...prev]);
  }, []);

  // Replace a row in place after a brand-fit vote so its badge refreshes, and keep
  // `selected` in sync so the modal reflects the new vote/rating.
  const onFeedback = useCallback((asset: ImageAsset) => {
    setRows((prev) => prev.map((r) => (r.id === asset.id ? asset : r)));
    setSelected((cur) => (cur && cur.id === asset.id ? asset : cur));
  }, []);

  return (
    <div className="space-y-3">
      <div className="flex gap-2">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search images by prompt, kind, style, or channel…"
          className="w-full rounded-md border border-neutral-300 bg-transparent px-3 py-1.5 text-sm dark:border-neutral-700"
        />
        <SeedUpload onUploaded={prepend} />
      </div>

      {visible.length === 0 ? (
        <p className="rounded-md border border-dashed border-neutral-300 p-8 text-center text-sm text-neutral-500 dark:border-neutral-700">
          {rows.length === 0
            ? "No images yet — generate a social or eBook image, or upload a few that nail your brand to teach the style engine."
            : "No images match your search."}
        </p>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {visible.map((a) => (
            <ImageCard key={a.id} asset={a} onOpen={() => setSelected(a)} />
          ))}
        </div>
      )}

      {loadError ? (
        <p className="text-center text-xs text-red-600 dark:text-red-400">{loadError}</p>
      ) : null}

      {cursor ? (
        <button
          disabled={loading}
          onClick={loadMore}
          className="w-full rounded-md border border-neutral-300 py-2 text-sm hover:bg-neutral-50 disabled:opacity-60 dark:border-neutral-700 dark:hover:bg-neutral-900"
        >
          {loading ? "Loading…" : "Load more"}
        </button>
      ) : null}

      {selected ? (
        <ImageDetailModal
          asset={selected}
          onClose={() => setSelected(null)}
          onCustomized={prepend}
          onFeedback={onFeedback}
        />
      ) : null}
    </div>
  );
}

/**
 * COLD START: upload existing on-brand images as seed exemplars (marked 👍, rating 9) so
 * the style engine has something to learn from before anything's generated. Uploads each
 * picked file sequentially and prepends the recorded rows.
 */
function SeedUpload({ onUploaded }: { onUploaded: (asset: ImageAsset) => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []).slice(0, 3); // up to 3 at a time
    e.target.value = ""; // allow re-picking the same file after a failure
    if (files.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      for (const file of files) {
        const fd = new FormData();
        fd.append("file", file);
        fd.append("rating", "9");
        const res = await fetch("/api/admin/brand-kit/images/upload", { method: "POST", body: fd });
        const data = (await res.json().catch(() => ({}))) as { image?: ImageAsset; message?: string };
        if (!res.ok || !data.image) {
          setError(data.message ?? "Upload failed — try again.");
          break;
        }
        onUploaded(data.image);
      }
    } catch {
      setError("Upload failed — check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="relative shrink-0">
      <input
        ref={inputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        multiple
        onChange={onPick}
        className="hidden"
      />
      <button
        type="button"
        disabled={busy}
        onClick={() => inputRef.current?.click()}
        title="Upload existing on-brand images to teach the style engine"
        className="flex items-center gap-1.5 whitespace-nowrap rounded-md border border-neutral-300 px-3 py-1.5 text-sm hover:bg-neutral-50 disabled:opacity-60 dark:border-neutral-700 dark:hover:bg-neutral-900"
      >
        <ImagePlus size={15} />
        {busy ? "Uploading…" : "Add brand images"}
      </button>
      {error ? (
        <p className="absolute right-0 top-full mt-1 whitespace-nowrap text-xs text-red-600 dark:text-red-400">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function ImageCard({ asset, onOpen }: { asset: ImageAsset; onOpen: () => void }) {
  const [broken, setBroken] = useState(false);
  return (
    <button
      type="button"
      onClick={onOpen}
      className="group overflow-hidden rounded-md border border-neutral-200 text-left transition-colors hover:border-neutral-300 dark:border-neutral-800 dark:hover:border-neutral-700"
    >
      <div className="relative aspect-square overflow-hidden bg-neutral-50 dark:bg-neutral-900">
        {broken ? (
          <div className="grid h-full w-full place-items-center text-neutral-300 dark:text-neutral-600">
            <ImageOff size={28} />
          </div>
        ) : (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={imageAssetProxyUrl(asset)}
            alt={asset.title || asset.prompt || "Generated image"}
            loading="lazy"
            onError={() => setBroken(true)}
            className="h-full w-full object-cover transition-transform duration-200 group-hover:scale-[1.02]"
          />
        )}
        <span className="absolute left-2 top-2 rounded-full bg-black/55 px-2 py-0.5 text-[11px] font-medium text-white">
          {KIND_LABEL[asset.kind] ?? asset.kind}
        </span>
        {asset.brandVote === "up" ? (
          <span className="absolute right-2 top-2 flex items-center gap-1 rounded-full bg-green-600/90 px-2 py-0.5 text-[11px] font-medium text-white">
            <ThumbsUp size={11} />
            {asset.brandRating ?? ""}
          </span>
        ) : asset.brandVote === "down" ? (
          <span className="absolute right-2 top-2 flex items-center rounded-full bg-red-600/90 px-2 py-0.5 text-white">
            <ThumbsDown size={11} />
          </span>
        ) : null}
      </div>
      <div className="px-2.5 py-2">
        <p className="truncate text-xs text-neutral-600 dark:text-neutral-400">
          {asset.prompt || asset.brief || "Untitled image"}
        </p>
      </div>
    </button>
  );
}
