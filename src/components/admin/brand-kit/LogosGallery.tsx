"use client";

import { useRef, useState } from "react";
import {
  LayoutGrid,
  LayoutList,
  MoreHorizontal,
  ImageOff,
  ImagePlus,
  Star,
} from "lucide-react";
import type { BrandLogo } from "@/lib/types/brandLogo";
import { brandLogoPublicUrl } from "@/lib/content/brandKit";
import { Modal } from "@/components/admin/email/Modal";

type View = "grid" | "list";

/** Subtle checkerboard so transparent (PNG) logos read as transparent, not white/black. */
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

export function LogosGallery({
  initialLogos,
  tenantId,
}: {
  initialLogos: BrandLogo[];
  tenantId: string;
}) {
  const [rows, setRows] = useState<BrandLogo[]>(initialLogos);
  const [view, setView] = useState<View>("grid");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const [renameFor, setRenameFor] = useState<BrandLogo | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const pick = () => inputRef.current?.click();

  async function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []).slice(0, 5);
    e.target.value = ""; // allow re-picking the same file after a failure
    if (files.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      for (const file of files) {
        const fd = new FormData();
        fd.append("file", file);
        const res = await fetch("/api/admin/brand-kit/logos/upload", { method: "POST", body: fd });
        const data = (await res.json().catch(() => ({}))) as { logo?: BrandLogo; message?: string };
        if (!res.ok || !data.logo) {
          setError(data.message ?? "Upload failed — try again.");
          break;
        }
        // Server marks the first-ever logo primary; prepend so it shows newest-first.
        setRows((prev) => [data.logo as BrandLogo, ...prev]);
      }
    } catch {
      setError("Upload failed — check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  async function onSetPrimary(id: string) {
    setError(null);
    try {
      const res = await fetch(`/api/admin/brand-kit/logos/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ setPrimary: true }),
      });
      if (!res.ok) throw new Error();
      setRows((prev) => prev.map((l) => ({ ...l, isPrimary: l.id === id })));
    } catch {
      setError("Couldn't set the primary logo — try again.");
    }
  }

  async function onRename(id: string, title: string) {
    const next = title.trim();
    if (!next) return;
    setError(null);
    try {
      const res = await fetch(`/api/admin/brand-kit/logos/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: next }),
      });
      if (!res.ok) throw new Error();
      setRows((prev) => prev.map((l) => (l.id === id ? { ...l, title: next } : l)));
      setRenameFor(null);
    } catch {
      setError("Couldn't rename the logo — try again.");
    }
  }

  async function onDelete(logo: BrandLogo) {
    if (!window.confirm(`Delete "${logo.title}"? This can't be undone.`)) return;
    setError(null);
    try {
      const res = await fetch(`/api/admin/brand-kit/logos/${logo.id}`, { method: "DELETE" });
      if (!res.ok) throw new Error();
      // No manual promotion: the effective primary (primaryId) derives the newest logo when
      // none is flagged — matching the server's getPrimaryLogo — so it recomputes on its own.
      setRows((prev) => prev.filter((l) => l.id !== logo.id));
    } catch {
      setError("Couldn't delete the logo — try again.");
    }
  }

  // The EFFECTIVE primary: the explicitly-flagged logo, else the newest — mirrors the
  // server's getPrimaryLogo so the badge/menu never disagree with what emails actually use.
  const primaryId = rows.find((r) => r.isPrimary)?.id ?? rows[0]?.id ?? null;

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
          {busy ? "Uploading…" : "Add logo"}
        </button>
      </div>

      {error ? (
        <p className="text-xs text-red-600 dark:text-red-400">{error}</p>
      ) : null}

      {rows.length === 0 ? (
        <EmptyState onAdd={pick} busy={busy} />
      ) : view === "grid" ? (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {rows.map((logo) => (
            <LogoGridCard
              key={logo.id}
              logo={logo}
              tenantId={tenantId}
              isPrimary={logo.id === primaryId}
              menuOpen={openMenuId === logo.id}
              onToggleMenu={() => setOpenMenuId((cur) => (cur === logo.id ? null : logo.id))}
              onCloseMenu={() => setOpenMenuId(null)}
              onRename={() => setRenameFor(logo)}
              onSetPrimary={() => onSetPrimary(logo.id)}
              onDelete={() => onDelete(logo)}
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
              {rows.map((logo) => (
                <tr
                  key={logo.id}
                  className="border-b border-neutral-100 last:border-0 hover:bg-neutral-50 dark:border-neutral-900 dark:hover:bg-neutral-900/50"
                >
                  <td className="px-3 py-2">
                    <div className="flex items-center gap-2.5">
                      <LogoThumb
                        logo={logo}
                        tenantId={tenantId}
                        className="h-8 w-8 shrink-0 rounded"
                      />
                      <span className="truncate font-medium">{logo.title}</span>
                      {logo.id === primaryId ? <PrimaryBadge /> : null}
                    </div>
                  </td>
                  <td className="px-3 py-2 text-neutral-500">Image</td>
                  <td className="px-3 py-2 tabular-nums text-neutral-500">
                    {formatRelative(logo.createdAt)}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <LogoMenu
                      logo={logo}
                      tenantId={tenantId}
                      isPrimary={logo.id === primaryId}
                      open={openMenuId === logo.id}
                      onToggle={() =>
                        setOpenMenuId((cur) => (cur === logo.id ? null : logo.id))
                      }
                      onClose={() => setOpenMenuId(null)}
                      onRename={() => setRenameFor(logo)}
                      onSetPrimary={() => onSetPrimary(logo.id)}
                      onDelete={() => onDelete(logo)}
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
          logo={renameFor}
          onClose={() => setRenameFor(null)}
          onSave={(title) => onRename(renameFor.id, title)}
        />
      ) : null}
    </div>
  );
}

function LogoThumb({
  logo,
  tenantId,
  className,
}: {
  logo: BrandLogo;
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
          src={brandLogoPublicUrl(tenantId, logo.filename)}
          alt={logo.title}
          loading="lazy"
          onError={() => setBroken(true)}
          className="max-h-full max-w-full object-contain p-0.5"
        />
      )}
    </div>
  );
}

function LogoGridCard({
  logo,
  tenantId,
  isPrimary,
  menuOpen,
  onToggleMenu,
  onCloseMenu,
  onRename,
  onSetPrimary,
  onDelete,
}: {
  logo: BrandLogo;
  tenantId: string;
  isPrimary: boolean;
  menuOpen: boolean;
  onToggleMenu: () => void;
  onCloseMenu: () => void;
  onRename: () => void;
  onSetPrimary: () => void;
  onDelete: () => void;
}) {
  return (
    <div className="group relative overflow-hidden rounded-lg border border-neutral-200 dark:border-neutral-800">
      <div className="relative aspect-[4/3]">
        <LogoThumb logo={logo} tenantId={tenantId} className="h-full w-full" />
        {isPrimary ? (
          <div className="absolute left-2 top-2">
            <PrimaryBadge />
          </div>
        ) : null}
        <div className="absolute right-1.5 top-1.5">
          <LogoMenu
            logo={logo}
            tenantId={tenantId}
            isPrimary={isPrimary}
            open={menuOpen}
            onToggle={onToggleMenu}
            onClose={onCloseMenu}
            onRename={onRename}
            onSetPrimary={onSetPrimary}
            onDelete={onDelete}
          />
        </div>
      </div>
      <div className="border-t border-neutral-200 px-3 py-2 dark:border-neutral-800">
        <p className="truncate text-sm font-medium">{logo.title}</p>
        <p className="text-xs text-neutral-500 dark:text-neutral-400">
          Image • {formatBytes(logo.byteSize)}
        </p>
      </div>
    </div>
  );
}

function PrimaryBadge() {
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-medium text-amber-800 dark:bg-amber-900/40 dark:text-amber-300">
      <Star size={11} className="fill-current" />
      Primary
    </span>
  );
}

function LogoMenu({
  logo,
  tenantId,
  isPrimary,
  open,
  onToggle,
  onClose,
  onRename,
  onSetPrimary,
  onDelete,
}: {
  logo: BrandLogo;
  tenantId: string;
  isPrimary: boolean;
  open: boolean;
  onToggle: () => void;
  onClose: () => void;
  onRename: () => void;
  onSetPrimary: () => void;
  onDelete: () => void;
}) {
  const itemClass =
    "block w-full px-3 py-1.5 text-left text-sm hover:bg-neutral-50 dark:hover:bg-neutral-800";
  return (
    <div className="relative">
      <button
        type="button"
        onClick={onToggle}
        aria-label="Logo actions"
        aria-haspopup="menu"
        aria-expanded={open}
        className="grid h-7 w-7 place-items-center rounded-md bg-white/80 text-neutral-600 shadow-sm backdrop-blur hover:bg-white hover:text-neutral-900 dark:bg-neutral-900/80 dark:text-neutral-300 dark:hover:bg-neutral-900"
      >
        <MoreHorizontal size={16} />
      </button>
      {open ? (
        <>
          {/* Click-away backdrop. */}
          <button
            type="button"
            aria-hidden
            tabIndex={-1}
            onClick={onClose}
            className="fixed inset-0 z-10 cursor-default"
          />
          <div
            role="menu"
            className="absolute right-0 z-20 mt-1 w-40 overflow-hidden rounded-md border border-neutral-200 bg-white py-1 shadow-lg dark:border-neutral-800 dark:bg-neutral-900"
          >
            {!isPrimary ? (
              <button
                type="button"
                role="menuitem"
                className={itemClass}
                onClick={() => {
                  onClose();
                  onSetPrimary();
                }}
              >
                Set as primary
              </button>
            ) : null}
            <button
              type="button"
              role="menuitem"
              className={itemClass}
              onClick={() => {
                onClose();
                onRename();
              }}
            >
              Rename
            </button>
            {/* Download uses the original title as the filename. */}
            <a
              role="menuitem"
              href={brandLogoPublicUrl(tenantId, logo.filename)}
              download={logo.title}
              className={itemClass}
              onClick={onClose}
            >
              Download
            </a>
            <button
              type="button"
              role="menuitem"
              className="block w-full px-3 py-1.5 text-left text-sm text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950/30"
              onClick={() => {
                onClose();
                onDelete();
              }}
            >
              Delete
            </button>
          </div>
        </>
      ) : null}
    </div>
  );
}

function RenameModal({
  logo,
  onClose,
  onSave,
}: {
  logo: BrandLogo;
  onClose: () => void;
  onSave: (title: string) => void;
}) {
  const [value, setValue] = useState(logo.title);
  return (
    <Modal open onClose={onClose} title="Rename logo">
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
          onChange={(e) => setValue(e.target.value)}
          maxLength={200}
          className="w-full rounded-md border border-neutral-300 bg-transparent px-3 py-2 text-sm dark:border-neutral-700"
          placeholder="Logo name"
        />
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={!value.trim()}
            className="rounded-md bg-neutral-900 px-3 py-1.5 text-sm text-white hover:bg-neutral-800 disabled:opacity-60 dark:bg-white dark:text-neutral-900"
          >
            Save
          </button>
        </div>
      </form>
    </Modal>
  );
}

function EmptyState({ onAdd, busy }: { onAdd: () => void; busy: boolean }) {
  return (
    <div className="rounded-lg border border-dashed border-neutral-300 p-10 text-center dark:border-neutral-700">
      <div className="mx-auto mb-3 grid h-16 w-16 place-items-center rounded-xl bg-neutral-50 dark:bg-neutral-900">
        <ImagePlus size={26} className="text-neutral-400" />
      </div>
      <h3 className="text-sm font-semibold">Add logos to be instantly recognisable</h3>
      <p className="mx-auto mt-1 max-w-md text-sm text-neutral-500 dark:text-neutral-400">
        Represent your brand with the right logos, ready to be used across your emails and
        designs.
      </p>
      <button
        type="button"
        disabled={busy}
        onClick={onAdd}
        className="mt-4 rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-800 disabled:opacity-60 dark:bg-white dark:text-neutral-900"
      >
        {busy ? "Uploading…" : "Add brand assets"}
      </button>
    </div>
  );
}
