"use client";

import { useMemo, useRef, useState } from "react";
import {
  Plus,
  MoreHorizontal,
  Type as TypeIcon,
  UploadCloud,
  AlignLeft,
  Trash2,
  Check,
  X,
  Bold,
  Italic,
} from "lucide-react";
import type { BrandFont } from "@/lib/types/brandFont";
import type { BrandTypography, TextStyle, TextStyleRole } from "@/lib/types/tenant";
import {
  CURATED_FONTS,
  TEXT_STYLE_ROLES,
  fontStackFor,
  sanitizeFontFamily,
  seededTextStyles,
} from "@/lib/content/fonts";
import { brandFontPublicUrl } from "@/lib/content/brandKit";

const SIZE_OPTIONS = [10, 12, 13, 14, 16, 18, 20, 24, 28, 32, 36, 42, 48, 56, 64, 72, 84, 96];
const SELECT =
  "rounded-md border border-neutral-300 bg-white px-2 py-1.5 text-sm dark:border-neutral-700 dark:bg-neutral-900";

/** src `format()` token for the @font-face rule (from the stored mime). */
function fontFormat(mime: string): string {
  if (mime.includes("woff2")) return "woff2";
  if (mime.includes("woff")) return "woff";
  if (mime.includes("otf")) return "opentype";
  return "truetype";
}

/**
 * Brand Kit → Fonts. The Canva-style typography manager: named text styles (Title / Subtitle / …)
 * each with a font family, role, size, and bold/italic; a custom font-file uploader; and free-text
 * guidelines. Self-saves the STYLE config to `tenant.brandTypography` (top-level, clobber-safe) and
 * uploads font FILES to the `brand_fonts` library. Everything here grounds AI generation globally.
 */
export function FontsManager({
  initialTypography,
  initialFonts,
  tenantId,
}: {
  initialTypography: BrandTypography | null;
  initialFonts: BrandFont[];
  tenantId: string;
}) {
  // Lazy initializer — seededTextStyles() (8× randomUUID) must run once, not on every render.
  const [styles, setStyles] = useState<TextStyle[]>(() =>
    initialTypography?.styles?.length ? initialTypography.styles : seededTextStyles(),
  );
  const [guidelines, setGuidelines] = useState(initialTypography?.guidelines ?? "");
  const [showGuidelines, setShowGuidelines] = useState(Boolean(initialTypography?.guidelines));
  const [fonts, setFonts] = useState<BrandFont[]>(initialFonts);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<TextStyle | null>(null);
  // A draft that isn't in `styles` yet (a brand-new style) — so cancelling never leaves a phantom
  // row, and it's appended only on commit.
  const [isNewDraft, setIsNewDraft] = useState(false);
  const [addMenu, setAddMenu] = useState(false);
  const [moreMenu, setMoreMenu] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const uploadRef = useRef<HTMLInputElement>(null);
  // Serialize typography saves so an earlier PUT that completes late can't clobber a newer one:
  // each write awaits the previous, so the server always converges to the last-dispatched state.
  const saveChain = useRef<Promise<void>>(Promise.resolve());
  const inflight = useRef(0);

  // Families offered in the picker: uploaded custom fonts first, then the curated list.
  const families = useMemo(() => {
    const custom = fonts.map((f) => f.family);
    const seen = new Set(custom.map((c) => c.toLowerCase()));
    const curated = CURATED_FONTS.map((f) => f.family).filter((f) => !seen.has(f.toLowerCase()));
    return { custom, curated };
  }, [fonts]);

  // @font-face for every uploaded font, so previews render in the real typeface. The family is
  // safe-charset sanitized here too (defence-in-depth) before it enters the dangerouslySetInnerHTML
  // <style> sink — the write path already sanitizes, so for current fonts this is a no-op.
  const fontFaceCss = useMemo(
    () =>
      fonts
        .map((f) => {
          const family = sanitizeFontFamily(f.family);
          if (!family) return "";
          return (
            `@font-face{font-family:'${family}';` +
            `src:url('${brandFontPublicUrl(tenantId, f.filename)}') format('${fontFormat(f.mimeType)}');` +
            `font-display:swap;}`
          );
        })
        .filter(Boolean)
        .join("\n"),
    [fonts, tenantId],
  );

  function persist(nextStyles: TextStyle[], nextGuidelines: string) {
    setError(null);
    inflight.current += 1;
    setBusy(true);
    const run = saveChain.current.then(async () => {
      try {
        const res = await fetch("/api/admin/brand-kit/fonts", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ styles: nextStyles, guidelines: nextGuidelines || null }),
        });
        if (!res.ok) throw new Error();
        setStatus("Saved");
        window.setTimeout(() => setStatus(null), 1500);
      } catch {
        setError("Couldn't save — try again.");
      }
    });
    // Keep the chain alive even if this write throws; clear busy only when ALL settle.
    saveChain.current = run.then(
      () => {},
      () => {},
    );
    void saveChain.current.finally(() => {
      inflight.current -= 1;
      if (inflight.current === 0) setBusy(false);
    });
  }

  function beginEdit(style: TextStyle) {
    setEditingId(style.id);
    setDraft({ ...style });
    setIsNewDraft(false);
    setAddMenu(false);
    setMoreMenu(false);
  }

  function commitDraft() {
    if (!draft) return;
    const name = draft.name.trim().slice(0, 60) || "Untitled style";
    const clean = { ...draft, name };
    // A new style is appended only now (it never lived in `styles`); an existing one is replaced.
    const next = isNewDraft
      ? [...styles, clean]
      : styles.map((s) => (s.id === clean.id ? clean : s));
    setStyles(next);
    setEditingId(null);
    setDraft(null);
    setIsNewDraft(false);
    persist(next, guidelines);
  }

  function cancelEdit() {
    // A cancelled new style simply vanishes — it was never added to `styles` (no phantom row).
    setEditingId(null);
    setDraft(null);
    setIsNewDraft(false);
  }

  function addStyle() {
    const style: TextStyle = {
      id: crypto.randomUUID(),
      name: "New text style",
      role: "body",
      fontFamily: null,
      size: 16,
      bold: false,
      italic: false,
    };
    // Held in `draft` only until committed — cancelling leaves `styles` untouched.
    setDraft(style);
    setEditingId(style.id);
    setIsNewDraft(true);
    setAddMenu(false);
    setMoreMenu(false);
  }

  function removeStyle(id: string) {
    const next = styles.filter((s) => s.id !== id);
    setStyles(next);
    if (editingId === id) cancelEdit();
    persist(next, guidelines);
  }

  function saveGuidelines() {
    persist(styles, guidelines);
  }

  async function onUploadFont(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []).slice(0, 5);
    e.target.value = "";
    if (!files.length) return;
    setBusy(true);
    setError(null);
    try {
      for (const file of files) {
        const fd = new FormData();
        fd.append("file", file);
        const res = await fetch("/api/admin/brand-kit/fonts/upload", { method: "POST", body: fd });
        const data = (await res.json().catch(() => ({}))) as { font?: BrandFont; message?: string };
        if (!res.ok || !data.font) {
          setError(data.message ?? "Font upload failed — try again.");
          break;
        }
        setFonts((prev) => [data.font as BrandFont, ...prev]);
      }
    } catch {
      setError("Font upload failed — check your connection and try again.");
    } finally {
      setBusy(false);
      setAddMenu(false);
    }
  }

  async function deleteFont(font: BrandFont) {
    if (!window.confirm(`Delete font "${font.title}"?`)) return;
    try {
      const res = await fetch(`/api/admin/brand-kit/fonts/${font.id}`, { method: "DELETE" });
      if (!res.ok) throw new Error();
      setFonts((prev) => prev.filter((f) => f.id !== font.id));
    } catch {
      setError("Couldn't delete the font — try again.");
    }
  }

  return (
    <div className="space-y-4">
      {fontFaceCss ? <style dangerouslySetInnerHTML={{ __html: fontFaceCss }} /> : null}

      {/* Header */}
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-bold tracking-tight">Fonts</h2>
        <div className="flex items-center gap-2">
          {status ? <span className="text-xs text-neutral-400">{status}</span> : null}
          {/* Add menu */}
          <div className="relative">
            <button
              type="button"
              onClick={() => {
                setAddMenu((v) => !v);
                setMoreMenu(false);
              }}
              aria-label="Add to Fonts"
              aria-haspopup="menu"
              aria-expanded={addMenu}
              className="grid h-9 w-9 place-items-center rounded-full border border-neutral-300 hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
            >
              <Plus size={18} />
            </button>
            {addMenu ? (
              <>
                <button
                  type="button"
                  aria-hidden
                  tabIndex={-1}
                  onClick={() => setAddMenu(false)}
                  className="fixed inset-0 z-10 cursor-default"
                />
                <div
                  role="menu"
                  className="absolute right-0 z-20 mt-1 w-56 overflow-hidden rounded-lg border border-neutral-200 bg-white p-1 text-sm shadow-lg dark:border-neutral-800 dark:bg-neutral-950"
                >
                  <MenuItem icon={<TypeIcon size={16} />} label="Add a text style" onClick={addStyle} />
                  <MenuItem
                    icon={<UploadCloud size={16} />}
                    label="Upload a font"
                    onClick={() => {
                      setAddMenu(false);
                      uploadRef.current?.click();
                    }}
                  />
                  <MenuItem
                    icon={<AlignLeft size={16} />}
                    label="Guidelines"
                    onClick={() => {
                      setShowGuidelines(true);
                      setAddMenu(false);
                    }}
                  />
                </div>
              </>
            ) : null}
          </div>
          {/* Overflow menu */}
          <div className="relative">
            <button
              type="button"
              onClick={() => {
                setMoreMenu((v) => !v);
                setAddMenu(false);
              }}
              aria-label="Fonts options"
              aria-haspopup="menu"
              aria-expanded={moreMenu}
              className="grid h-9 w-9 place-items-center rounded-full hover:bg-neutral-100 dark:hover:bg-neutral-900"
            >
              <MoreHorizontal size={18} />
            </button>
            {moreMenu ? (
              <>
                <button
                  type="button"
                  aria-hidden
                  tabIndex={-1}
                  onClick={() => setMoreMenu(false)}
                  className="fixed inset-0 z-10 cursor-default"
                />
                <div
                  role="menu"
                  className="absolute right-0 z-20 mt-1 w-48 overflow-hidden rounded-lg border border-neutral-200 bg-white p-1 text-sm shadow-lg dark:border-neutral-800 dark:bg-neutral-950"
                >
                  <MenuItem
                    icon={<TypeIcon size={16} />}
                    label="Reset to defaults"
                    onClick={() => {
                      const next = seededTextStyles();
                      setStyles(next);
                      setMoreMenu(false);
                      cancelEdit();
                      persist(next, guidelines);
                    }}
                  />
                </div>
              </>
            ) : null}
          </div>
        </div>
      </div>

      {error ? <p className="text-xs text-red-600 dark:text-red-400">{error}</p> : null}

      {/* Text-style rows */}
      <div className="space-y-2">
        {styles.map((style) =>
          editingId === style.id && draft ? (
            <StyleEditor
              key={style.id}
              draft={draft}
              families={families}
              onChange={setDraft}
              onCommit={commitDraft}
              onCancel={cancelEdit}
            />
          ) : (
            <StyleRow
              key={style.id}
              style={style}
              onEdit={() => beginEdit(style)}
              onDelete={() => removeStyle(style.id)}
            />
          ),
        )}
        {/* A brand-new style edits in its own editor and joins `styles` only on commit. */}
        {isNewDraft && draft ? (
          <StyleEditor
            draft={draft}
            families={families}
            onChange={setDraft}
            onCommit={commitDraft}
            onCancel={cancelEdit}
          />
        ) : null}
        {styles.length === 0 && !isNewDraft ? (
          <button
            type="button"
            onClick={addStyle}
            className="w-full rounded-xl border border-dashed border-neutral-300 px-4 py-6 text-sm text-neutral-500 hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
          >
            + Add a text style
          </button>
        ) : null}
      </div>

      {/* Uploaded custom fonts */}
      {fonts.length ? (
        <div className="rounded-xl border border-neutral-200 p-3 dark:border-neutral-800">
          <div className="mb-2 text-sm font-medium">Uploaded fonts</div>
          <ul className="space-y-1.5">
            {fonts.map((f) => (
              <li key={f.id} className="flex items-center justify-between gap-2">
                <span
                  className="truncate text-base"
                  style={{ fontFamily: fontStackFor(f.family) }}
                  title={f.title}
                >
                  {f.family}
                </span>
                <button
                  type="button"
                  onClick={() => deleteFont(f)}
                  aria-label={`Delete ${f.family}`}
                  className="rounded p-1 text-neutral-400 hover:bg-neutral-100 hover:text-red-600 dark:hover:bg-neutral-900"
                >
                  <Trash2 size={15} />
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {/* Guidelines */}
      {showGuidelines ? (
        <div className="rounded-xl border border-neutral-200 p-3 dark:border-neutral-800">
          <label className="mb-1 block text-sm font-medium">Typography guidelines</label>
          <textarea
            rows={3}
            value={guidelines}
            maxLength={2000}
            onChange={(e) => setGuidelines(e.target.value)}
            onBlur={saveGuidelines}
            placeholder="e.g. Use Title for hero headlines only; never set body copy below 14px; pair Montserrat headings with Inter body."
            className="w-full rounded-md border border-neutral-300 px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
          />
        </div>
      ) : null}

      <input
        ref={uploadRef}
        type="file"
        accept=".woff2,.woff,.ttf,.otf,font/woff2,font/woff,font/ttf,font/otf"
        multiple
        onChange={onUploadFont}
        className="hidden"
      />
      {busy ? <p className="text-xs text-neutral-400">Working…</p> : null}
    </div>
  );
}

function MenuItem({
  icon,
  label,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className="flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-left hover:bg-neutral-50 dark:hover:bg-neutral-900"
    >
      <span className="text-neutral-500">{icon}</span>
      {label}
    </button>
  );
}

/** A collapsed style row — the name rendered in its own typeface, with a trash affordance. */
function StyleRow({
  style,
  onEdit,
  onDelete,
}: {
  style: TextStyle;
  onEdit: () => void;
  onDelete: () => void;
}) {
  return (
    <div className="group flex items-center justify-between gap-3 rounded-xl border border-neutral-200 px-4 py-3 hover:border-neutral-300 dark:border-neutral-800 dark:hover:border-neutral-700">
      <button
        type="button"
        onClick={onEdit}
        className="min-w-0 flex-1 truncate text-left text-neutral-800 dark:text-neutral-100"
        style={{
          fontFamily: fontStackFor(style.fontFamily),
          fontWeight: style.bold ? 700 : 400,
          fontStyle: style.italic ? "italic" : "normal",
          fontSize: `${Math.min(Math.max(style.size ?? 16, 12), 40)}px`,
          lineHeight: 1.2,
        }}
        title="Edit text style"
      >
        {style.name}
      </button>
      <button
        type="button"
        onClick={onDelete}
        aria-label={`Delete ${style.name}`}
        className="shrink-0 rounded p-1.5 text-neutral-300 opacity-0 transition-opacity hover:text-red-600 group-hover:opacity-100 dark:text-neutral-600"
      >
        <Trash2 size={18} />
      </button>
    </div>
  );
}

/** The expanded editor row — Font / Type / Size / B / I toolbar + the editable name + ✓ / ✕. */
function StyleEditor({
  draft,
  families,
  onChange,
  onCommit,
  onCancel,
}: {
  draft: TextStyle;
  families: { custom: string[]; curated: string[] };
  onChange: (next: TextStyle) => void;
  onCommit: () => void;
  onCancel: () => void;
}) {
  const sizes = SIZE_OPTIONS.includes(draft.size ?? 16)
    ? SIZE_OPTIONS
    : [...SIZE_OPTIONS, draft.size ?? 16].sort((a, b) => a - b);

  return (
    <div className="rounded-xl border-2 border-purple-400 p-3 dark:border-purple-500">
      {/* Toolbar */}
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-xs font-medium text-neutral-500">
          Font
          <select
            value={draft.fontFamily ?? ""}
            onChange={(e) => onChange({ ...draft, fontFamily: e.target.value || null })}
            className={SELECT}
          >
            <option value="">Choose a font</option>
            {families.custom.length ? (
              <optgroup label="Your fonts">
                {families.custom.map((f) => (
                  <option key={`c-${f}`} value={f}>
                    {f}
                  </option>
                ))}
              </optgroup>
            ) : null}
            <optgroup label="Fonts">
              {families.curated.map((f) => (
                <option key={f} value={f}>
                  {f}
                </option>
              ))}
            </optgroup>
          </select>
        </label>

        <label className="flex flex-col gap-1 text-xs font-medium text-neutral-500">
          Type
          <select
            value={draft.role}
            onChange={(e) => onChange({ ...draft, role: e.target.value as TextStyleRole })}
            className={SELECT}
          >
            {TEXT_STYLE_ROLES.map((r) => (
              <option key={r.role} value={r.role}>
                {r.label}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1 text-xs font-medium text-neutral-500">
          Size
          <select
            value={draft.size ?? 16}
            onChange={(e) => onChange({ ...draft, size: Number(e.target.value) })}
            className={SELECT}
          >
            {sizes.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>

        <div className="flex gap-1">
          <ToggleBtn
            active={Boolean(draft.bold)}
            label="Bold"
            onClick={() => onChange({ ...draft, bold: !draft.bold })}
          >
            <Bold size={15} />
          </ToggleBtn>
          <ToggleBtn
            active={Boolean(draft.italic)}
            label="Italic"
            onClick={() => onChange({ ...draft, italic: !draft.italic })}
          >
            <Italic size={15} />
          </ToggleBtn>
        </div>
      </div>

      {/* Name (rendered in-style) + confirm/cancel */}
      <div className="mt-3 flex items-center gap-2 border-t border-neutral-200 pt-3 dark:border-neutral-800">
        <input
          autoFocus
          value={draft.name}
          onChange={(e) => onChange({ ...draft, name: e.target.value.slice(0, 60) })}
          onKeyDown={(e) => {
            if (e.key === "Enter") onCommit();
            if (e.key === "Escape") onCancel();
          }}
          className="min-w-0 flex-1 bg-transparent text-neutral-800 outline-none dark:text-neutral-100"
          style={{
            fontFamily: fontStackFor(draft.fontFamily),
            fontWeight: draft.bold ? 700 : 400,
            fontStyle: draft.italic ? "italic" : "normal",
            fontSize: `${Math.min(Math.max(draft.size ?? 16, 12), 40)}px`,
          }}
          placeholder="Style name"
        />
        <button
          type="button"
          onClick={onCommit}
          aria-label="Confirm"
          className="rounded p-1.5 text-neutral-500 hover:bg-neutral-100 hover:text-green-600 dark:hover:bg-neutral-900"
        >
          <Check size={18} />
        </button>
        <button
          type="button"
          onClick={onCancel}
          aria-label="Cancel"
          className="rounded p-1.5 text-neutral-500 hover:bg-neutral-100 hover:text-red-600 dark:hover:bg-neutral-900"
        >
          <X size={18} />
        </button>
      </div>
    </div>
  );
}

function ToggleBtn({
  active,
  label,
  onClick,
  children,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      aria-pressed={active}
      className={`grid h-9 w-9 place-items-center rounded-md border ${
        active
          ? "border-neutral-900 bg-neutral-900 text-white dark:border-white dark:bg-white dark:text-neutral-900"
          : "border-neutral-300 text-neutral-500 hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
      }`}
    >
      {children}
    </button>
  );
}
