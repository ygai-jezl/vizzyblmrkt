"use client";

import { useRef, useState } from "react";
import {
  LayoutGrid,
  LayoutList,
  MoreHorizontal,
  ImageOff,
  ImagePlus,
  Pencil,
  Trash2,
  Sparkles,
} from "lucide-react";
import type { BrandAsset, BrandAssetCategory } from "@/lib/types/brandAsset";
import { brandAssetPublicUrl } from "@/lib/content/brandKit";
import { Modal } from "@/components/admin/email/Modal";

type View = "grid" | "list";

/** Subtle checkerboard so transparent (PNG) assets read as transparent, not white/black. */
const CHECKER: React.CSSProperties = {
  backgroundImage:
    "linear-gradient(45deg,#00000010 25%,transparent 25%,transparent 75%,#00000010 75%,#00000010)," +
    "linear-gradient(45deg,#00000010 25%,transparent 25%,transparent 75%,#00000010 75%,#00000010)",
  backgroundSize: "16px 16px",
  backgroundPosition: "0 0,8px 8px",
};

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} kB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function formatRelative(iso: string): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return "—";
  const s = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d}d ago`;
  return iso.slice(0, 10);
}

const NOUN: Record<BrandAssetCategory, string> = { icon: "icon", graphic: "graphic" };

/**
 * The Brand Kit → Icons / Graphics gallery. Tenant-global upload library (raster PNG/JPG/WebP),
 * grid/list views, rename + delete. Parameterised by `category` (icons + graphics share this
 * component and the `brand_assets` collection). Modelled on LogosGallery, minus the primary-logo
 * machinery. Anything uploaded here is fed to image generation as a visual reference (server-side).
 */
export function BrandAssetLibrary({
  category,
  initialAssets,
  tenantId,
}: {
  category: BrandAssetCategory;
  initialAssets: BrandAsset[];
  tenantId: string;
}) {
  const [rows, setRows] = useState<BrandAsset[]>(initialAssets);
  const [view, setView] = useState<View>("grid");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const [renameFor, setRenameFor] = useState<BrandAsset | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const noun = NOUN[category];

  const pick = () => inputRef.current?.click();

  async function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []).slice(0, 10);
    e.target.value = ""; // allow re-picking the same file after a failure
    if (files.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      for (const file of files) {
        const fd = new FormData();
        fd.append("file", file);
        fd.append("category", category);
        const res = await fetch("/api/admin/brand-kit/assets/upload", { method: "POST", body: fd });
        const data = (await res.json().catch(() => ({}))) as { asset?: BrandAsset; message?: string };
        if (!res.ok || !data.asset) {
          setError(data.message ?? "Upload failed — try again.");
          break;
        }
        setRows((prev) => [data.asset as BrandAsset, ...prev]);
      }
    } catch {
      setError("Upload failed — check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  async function onRename(id: string, title: string) {
    const next = title.trim();
    if (!next) return;
    setError(null);
    try {
      const res = await fetch(`/api/admin/brand-kit/assets/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: next }),
      });
      if (!res.ok) throw new Error();
      setRows((prev) => prev.map((a) => (a.id === id ? { ...a, title: next } : a)));
      setRenameFor(null);
    } catch {
      setError(`Couldn't rename the ${noun} — try again.`);
    }
  }

  async function onDelete(asset: BrandAsset) {
    if (!window.confirm(`Delete "${asset.title}"? This can't be undone.`)) return;
    setError(null);
    try {
      const res = await fetch(`/api/admin/brand-kit/assets/${asset.id}`, { method: "DELETE" });
      if (!res.ok) throw new Error();
      setRows((prev) => prev.filter((a) => a.id !== asset.id));
    } catch {
      setError(`Couldn't delete the ${noun} — try again.`);
    }
  }

  return (
    <div className="space-y-3">
      {/* Toolbar: view toggle + upload */}
      <div className="flex items-center justify-end gap-2">
        <div className="flex gap-1 rounded-md border border-neutral-300 p-0.5 dark:border-neutral-700">
          {(
            [
              ["grid", LayoutGrid, "Grid view"],
              ["list", LayoutList, "List view"],
            ] as const
          ).map(([v, Icon, label]) => (
            <button
              key={v}
              type="button"
              onClick={() => setView(v)}
              aria-label={label}
              aria-pressed={view === v}
              className={`rounded p-1.5 ${
                view === v
                  ? "bg-neutral-900 text-white dark:bg-white dark:text-neutral-900"
                  : "text-neutral-500 hover:bg-neutral-50 dark:hover:bg-neutral-900"
              }`}
            >
              <Icon size={16} />
            </button>
          ))}
        </div>
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
          onClick={pick}
          className="flex items-center gap-1.5 whitespace-nowrap rounded-md border border-neutral-300 px-3 py-1.5 text-sm hover:bg-neutral-50 disabled:opacity-60 dark:border-neutral-700 dark:hover:bg-neutral-900"
        >
          <ImagePlus size={15} />
          {busy ? "Uploading…" : `Add ${noun}`}
        </button>
      </div>

      {error ? <p className="text-xs text-red-600 dark:text-red-400">{error}</p> : null}

      {rows.length === 0 ? (
        <EmptyState noun={noun} onAdd={pick} busy={busy} />
      ) : view === "grid" ? (
        <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {rows.map((asset) => (
            <AssetGridCard
              key={asset.id}
              asset={asset}
              tenantId={tenantId}
              menuOpen={openMenuId === asset.id}
              onToggleMenu={() => setOpenMenuId((cur) => (cur === asset.id ? null : asset.id))}
              onCloseMenu={() => setOpenMenuId(null)}
              onRename={() => setRenameFor(asset)}
              onDelete={() => onDelete(asset)}
            />
          ))}
        </div>
      ) : (
        <div className="overflow-x-auto rounded-md border border-neutral-200 dark:border-neutral-800">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-neutral-200 text-neutral-500 dark:border-neutral-800">
              <tr>
                <th className="px-3 py-2 font-medium">Name</th>
                <th className="px-3 py-2 font-medium">Type</th>
                <th className="px-3 py-2 font-medium">Added</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {rows.map((asset) => (
                <tr
                  key={asset.id}
                  className="border-b border-neutral-100 last:border-0 hover:bg-neutral-50 dark:border-neutral-900 dark:hover:bg-neutral-900/50"
                >
                  <td className="px-3 py-2">
                    <div className="flex items-center gap-2.5">
                      <AssetThumb asset={asset} tenantId={tenantId} className="h-8 w-8 shrink-0 rounded" />
                      <span className="truncate font-medium">{asset.title}</span>
                    </div>
                  </td>
                  <td className="px-3 py-2 text-neutral-500">Image</td>
                  <td className="px-3 py-2 tabular-nums text-neutral-500">
                    {formatRelative(asset.createdAt)}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <AssetMenu
                      open={openMenuId === asset.id}
                      onToggle={() => setOpenMenuId((cur) => (cur === asset.id ? null : asset.id))}
                      onClose={() => setOpenMenuId(null)}
                      onRename={() => setRenameFor(asset)}
                      onDelete={() => onDelete(asset)}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {renameFor ? (
        <RenameModal
          asset={renameFor}
          onClose={() => setRenameFor(null)}
          onSave={(title) => onRename(renameFor.id, title)}
        />
      ) : null}
    </div>
  );
}

function AssetThumb({
  asset,
  tenantId,
  className,
}: {
  asset: BrandAsset;
  tenantId: string;
  className?: string;
}) {
  const [broken, setBroken] = useState(false);
  return (
    <div
      className={`grid place-items-center overflow-hidden bg-neutral-50 dark:bg-neutral-900 ${className ?? ""}`}
      style={CHECKER}
    >
      {broken ? (
        <ImageOff size={16} className="text-neutral-300 dark:text-neutral-600" />
      ) : (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={brandAssetPublicUrl(tenantId, asset.category, asset.filename)}
          alt={asset.title}
          loading="lazy"
          onError={() => setBroken(true)}
          className="max-h-full max-w-full object-contain p-0.5"
        />
      )}
    </div>
  );
}

function AssetGridCard({
  asset,
  tenantId,
  menuOpen,
  onToggleMenu,
  onCloseMenu,
  onRename,
  onDelete,
}: {
  asset: BrandAsset;
  tenantId: string;
  menuOpen: boolean;
  onToggleMenu: () => void;
  onCloseMenu: () => void;
  onRename: () => void;
  onDelete: () => void;
}) {
  return (
    <div className="group relative overflow-hidden rounded-lg border border-neutral-200 dark:border-neutral-800">
      <div className="relative aspect-square">
        <AssetThumb asset={asset} tenantId={tenantId} className="h-full w-full" />
        <div className="absolute right-1.5 top-1.5">
          <AssetMenu
            open={menuOpen}
            onToggle={onToggleMenu}
            onClose={onCloseMenu}
            onRename={onRename}
            onDelete={onDelete}
          />
        </div>
      </div>
      <div className="border-t border-neutral-200 px-3 py-2 dark:border-neutral-800">
        <p className="truncate text-sm font-medium">{asset.title}</p>
        <p className="text-xs text-neutral-500 dark:text-neutral-400">
          Image • {formatBytes(asset.byteSize)}
        </p>
      </div>
    </div>
  );
}

function AssetMenu({
  open,
  onToggle,
  onClose,
  onRename,
  onDelete,
}: {
  open: boolean;
  onToggle: () => void;
  onClose: () => void;
  onRename: () => void;
  onDelete: () => void;
}) {
  return (
    <div className="relative">
      <button
        type="button"
        onClick={onToggle}
        aria-label="Asset actions"
        aria-haspopup="menu"
        aria-expanded={open}
        className="rounded-md bg-white/90 p-1 text-neutral-600 shadow-sm ring-1 ring-neutral-200 hover:bg-white dark:bg-neutral-900/90 dark:text-neutral-300 dark:ring-neutral-700"
      >
        <MoreHorizontal size={16} />
      </button>
      {open ? (
        <>
          {/* Click-away backdrop */}
          <button
            type="button"
            aria-hidden
            tabIndex={-1}
            onClick={onClose}
            className="fixed inset-0 z-10 cursor-default"
          />
          <div
            role="menu"
            className="absolute right-0 z-20 mt-1 w-36 overflow-hidden rounded-md border border-neutral-200 bg-white text-sm shadow-lg dark:border-neutral-800 dark:bg-neutral-950"
          >
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                onClose();
                onRename();
              }}
              className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-neutral-50 dark:hover:bg-neutral-900"
            >
              <Pencil size={14} /> Rename
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                onClose();
                onDelete();
              }}
              className="flex w-full items-center gap-2 px-3 py-2 text-left text-red-600 hover:bg-red-50 dark:hover:bg-red-950/30"
            >
              <Trash2 size={14} /> Delete
            </button>
          </div>
        </>
      ) : null}
    </div>
  );
}

function EmptyState({ noun, onAdd, busy }: { noun: string; onAdd: () => void; busy: boolean }) {
  return (
    <div className="grid place-items-center rounded-xl border border-dashed border-neutral-300 px-6 py-16 text-center dark:border-neutral-700">
      <div className="mb-4 grid h-16 w-16 place-items-center rounded-2xl bg-purple-100 text-purple-600 dark:bg-purple-950/40 dark:text-purple-300">
        <Sparkles size={26} />
      </div>
      <p className="text-base font-semibold">Stay on brand, your way</p>
      <p className="mt-1 max-w-md text-sm text-neutral-500 dark:text-neutral-400">
        Add brand {noun}s for consistency across your generated content. They&apos;re reused
        automatically as visual references when your brand images are created.
      </p>
      <button
        type="button"
        disabled={busy}
        onClick={onAdd}
        className="mt-5 rounded-md bg-purple-600 px-4 py-2 text-sm font-medium text-white hover:bg-purple-700 disabled:opacity-60"
      >
        {busy ? "Uploading…" : `Add brand ${noun}s`}
      </button>
    </div>
  );
}

function RenameModal({
  asset,
  onClose,
  onSave,
}: {
  asset: BrandAsset;
  onClose: () => void;
  onSave: (title: string) => void;
}) {
  const [value, setValue] = useState(asset.title);
  return (
    <Modal open onClose={onClose} title="Rename asset">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          onSave(value);
        }}
        className="space-y-4"
      >
        <input
          autoFocus
          value={value}
          onChange={(e) => setValue(e.target.value.slice(0, 200))}
          className="w-full rounded-md border border-neutral-300 px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
          placeholder="Asset name"
        />
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm dark:border-neutral-700"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={!value.trim()}
            className="rounded-md bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50 dark:bg-white dark:text-neutral-900"
          >
            Save
          </button>
        </div>
      </form>
    </Modal>
  );
}
