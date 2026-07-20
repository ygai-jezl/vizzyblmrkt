"use client";

import { useCallback, useDeferredValue, useMemo, useState } from "react";
import { ImageOff } from "lucide-react";
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

  // Prepend a freshly-customised image so the operator sees the result immediately.
  const onCustomized = useCallback((asset: ImageAsset) => {
    setRows((prev) => [asset, ...prev]);
  }, []);

  return (
    <div className="space-y-3">
      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Search images by prompt, kind, style, or channel…"
        className="w-full rounded-md border border-neutral-300 bg-transparent px-3 py-1.5 text-sm dark:border-neutral-700"
      />

      {visible.length === 0 ? (
        <p className="rounded-md border border-dashed border-neutral-300 p-8 text-center text-sm text-neutral-500 dark:border-neutral-700">
          {rows.length === 0
            ? "No images yet — generate a social or eBook image and it will appear here."
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
          onCustomized={onCustomized}
        />
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
      </div>
      <div className="px-2.5 py-2">
        <p className="truncate text-xs text-neutral-600 dark:text-neutral-400">
          {asset.prompt || asset.brief || "Untitled image"}
        </p>
      </div>
    </button>
  );
}
