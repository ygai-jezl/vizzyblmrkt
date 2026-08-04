"use client";

import { useEffect, useState } from "react";
import type { PaletteColor, PaletteGroup } from "@/lib/types/tenant";
import { BrandColours } from "@/components/admin/brand-kit/BrandColours";

/**
 * The dedicated Brand Kit → Colours page: a thin, self-saving wrapper around the existing
 * `BrandColours` card. Holds the palette + groups in local state and persists ONLY those zones via
 * `PUT /api/admin/brand-kit/colours` (a read-modify-write that preserves the rest of the brand kit).
 * The palette hexes it saves already flow into on-brand AI generation via assembleBrandContext.
 */
export function BrandColoursPage({
  initialPalette,
  initialPalettes,
  pdfPath,
}: {
  initialPalette: PaletteColor[];
  initialPalettes: PaletteGroup[];
  pdfPath: string | null;
}) {
  const [palette, setPalette] = useState<PaletteColor[]>(initialPalette);
  const [palettes, setPalettes] = useState<PaletteGroup[]>(initialPalettes);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);

  // Colours use an explicit "Save" (matching Account → Brand); warn before losing unsaved edits.
  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirty]);

  async function save() {
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      const res = await fetch("/api/admin/brand-kit/colours", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ palette, palettes }),
      });
      if (!res.ok) throw new Error();
      setStatus("Saved");
      setDirty(false);
      window.setTimeout(() => setStatus(null), 1500);
    } catch {
      setError("Couldn't save your colours — try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <BrandColours
        palette={palette}
        palettes={palettes}
        pdfPath={pdfPath}
        onChange={(next) => {
          setPalette(next.palette);
          setPalettes(next.palettes);
          setDirty(true);
        }}
      />
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={save}
          disabled={busy || !dirty}
          className="rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50 dark:bg-white dark:text-neutral-900"
        >
          {busy ? "Saving…" : "Save colours"}
        </button>
        {status ? <span className="text-xs text-neutral-500">{status}</span> : null}
        {error ? <span className="text-xs text-red-600 dark:text-red-400">{error}</span> : null}
      </div>
    </div>
  );
}
