"use client";

import { useState } from "react";
import type { PaletteColor, PaletteGroup, PaletteSource } from "@/lib/types/tenant";
import { isBrandColorsUiEnabled, isBrandKitLogosUiEnabled } from "@/lib/content/brandKit";
import { HEX6, mergeColors } from "@/lib/content/create/colorPalette";

/**
 * The Brand Kit "Colours" card (Account → Brand). Two persisted zones — the primary flat
 * "Colour palette" (kit.palette) and named source "Palettes" groups (kit.palettes) — plus an
 * ephemeral REVIEW TRAY. Source actions (PDF / website / AI theme / logo) post to the colours
 * routes and drop candidates into the tray; the operator refines, then Keeps a group (persists
 * into kit.palettes) or adds colours into the primary palette. Controlled: all persisted edits
 * flow up through onChange; the parent's existing "Save brand kit" button persists them.
 */

const PALETTE_MAX = 24; // BrandKitSchema.palette
const GROUPS_MAX = 20; // BrandKitSchema.palettes
const NAME_MAX = 60; // PaletteColorSchema.name

const INPUT =
  "w-full rounded-md border border-neutral-300 px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900";
const SWATCH = "h-8 w-12 shrink-0 rounded border border-neutral-300 dark:border-neutral-700";
const HINT = "text-xs text-neutral-500";
const BTN =
  "rounded-md border border-neutral-300 px-3 py-1.5 text-sm disabled:opacity-50 dark:border-neutral-700";

interface PendingGroup {
  source: PaletteSource;
  label: string;
  colors: PaletteColor[];
}

const SOURCE_LABEL: Record<PaletteSource, string> = {
  manual: "Manual",
  pdf: "PDF",
  website: "Website",
  ai: "AI theme",
  logo: "Logo",
};

interface BrandColoursProps {
  palette: PaletteColor[];
  palettes: PaletteGroup[];
  pdfPath: string | null;
  onChange: (next: { palette: PaletteColor[]; palettes: PaletteGroup[] }) => void;
}

export function BrandColours({ palette, palettes, pdfPath, onChange }: BrandColoursProps) {
  const colorsUi = isBrandColorsUiEnabled();
  const logosUi = isBrandKitLogosUiEnabled();
  const [tray, setTray] = useState<Partial<Record<PaletteSource, PendingGroup>>>({});
  const [busy, setBusy] = useState<PaletteSource | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const setPalette = (next: PaletteColor[]) => onChange({ palette: next, palettes });
  const setPalettes = (next: PaletteGroup[]) => onChange({ palette, palettes: next });

  function addToPalette(colors: PaletteColor[]) {
    const { merged, skipped } = mergeColors(palette, colors, PALETTE_MAX);
    setPalette(merged);
    setMsg(
      skipped > 0
        ? `Added colours — ${skipped} skipped (palette is full at ${PALETTE_MAX}).`
        : "Added to your Colour palette.",
    );
  }

  async function runSource(source: PaletteSource, url: string, body?: unknown) {
    setBusy(source);
    setMsg(null);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body ?? {}),
      });
      const data = (await res.json().catch(() => ({}))) as {
        candidates?: PaletteColor[];
        label?: string;
        error?: string;
      };
      if (res.ok && Array.isArray(data.candidates) && data.candidates.length) {
        setTray((t) => ({
          ...t,
          [source]: { source, label: data.label ?? SOURCE_LABEL[source], colors: data.candidates! },
        }));
      } else if (data.error === "no_primary_domain") {
        setMsg("Set your Primary Domain in Account → Domains, then try again.");
      } else if (data.error === "no_logo") {
        setMsg("Upload a logo in Brand Kit → Logos first.");
      } else {
        setMsg("Couldn’t find colours from that source — try another, or add them manually.");
      }
    } catch {
      setMsg("Something went wrong — please try again.");
    } finally {
      setBusy(null);
    }
  }

  function clearTray(source: PaletteSource) {
    setTray((t) => {
      const next = { ...t };
      delete next[source];
      return next;
    });
  }

  function keepGroup(p: PendingGroup) {
    if (palettes.length >= GROUPS_MAX) {
      setMsg(`You can keep up to ${GROUPS_MAX} palettes — remove one first, or add these colours to your Colour palette.`);
      return;
    }
    const group: PaletteGroup = {
      id: crypto.randomUUID(),
      name: p.label.slice(0, 80),
      source: p.source,
      colors: p.colors.slice(0, 48),
    };
    setPalettes([...palettes, group]);
    clearTray(p.source);
    setMsg(`Kept “${group.name}” as a palette.`);
  }

  function updateTrayColors(source: PaletteSource, colors: PaletteColor[]) {
    setTray((t) => {
      const g = t[source];
      if (!g) return t;
      if (!colors.length) {
        const next = { ...t };
        delete next[source];
        return next;
      }
      return { ...t, [source]: { ...g, colors } };
    });
  }

  const pending = Object.values(tray).filter((g): g is PendingGroup => Boolean(g));
  const busyLabel = (s: PaletteSource) => (busy === s ? "Working…" : null);

  return (
    <div className="space-y-5">
      {/* ── Colour palette (primary, always on) ────────────────────────────── */}
      <div>
        <div className="flex items-baseline justify-between">
          <div className="text-sm font-medium">Colour palette</div>
          <div className={HINT}>{palette.length}/{PALETTE_MAX}</div>
        </div>
        <div className="mt-2 space-y-2">
          {palette.map((c, i) => (
            <SwatchRow
              key={i}
              color={c}
              onHex={(hex) => setPalette(palette.map((p, j) => (j === i ? { ...p, hex } : p)))}
              onName={(name) => setPalette(palette.map((p, j) => (j === i ? { ...p, name } : p)))}
              onRemove={() => setPalette(palette.filter((_, j) => j !== i))}
            />
          ))}
          {palette.length < PALETTE_MAX ? (
            <button
              type="button"
              onClick={() => setPalette([...palette, { hex: "#000000", name: "" }])}
              className="rounded border border-dashed border-neutral-300 px-2 py-1 text-xs dark:border-neutral-700"
            >
              + Add colour
            </button>
          ) : null}
        </div>
      </div>

      {/* ── Source actions + review tray + groups (flag-gated) ─────────────── */}
      {colorsUi ? (
        <>
          <div className="rounded-md border border-neutral-200 p-3 dark:border-neutral-800">
            <div className="text-sm font-medium">Build a palette</div>
            <p className={`mt-0.5 ${HINT}`}>
              Pull colours from a source, review them below, then keep the ones you want.
            </p>
            <div className="mt-2 flex flex-wrap gap-2">
              <button
                type="button"
                className={BTN}
                disabled={busy !== null || !pdfPath}
                title={pdfPath ? undefined : "Upload a brand PDF above first"}
                onClick={() =>
                  runSource("pdf", "/api/admin/account/brand/extract/palette", { pdfPath })
                }
              >
                {busyLabel("pdf") ?? "Extract from PDF"}
              </button>
              <button
                type="button"
                className={BTN}
                disabled={busy !== null}
                onClick={() => runSource("website", "/api/admin/account/brand/colors/website")}
              >
                {busyLabel("website") ?? "Pull from website"}
              </button>
              <button
                type="button"
                className={BTN}
                disabled={busy !== null}
                onClick={() =>
                  runSource("ai", "/api/admin/account/brand/colors/theme", { seed: palette })
                }
              >
                {busyLabel("ai") ?? "Generate AI theme"}
              </button>
              {logosUi ? (
                <button
                  type="button"
                  className={BTN}
                  disabled={busy !== null}
                  onClick={() => runSource("logo", "/api/admin/account/brand/colors/logo")}
                >
                  {busyLabel("logo") ?? "From logo"}
                </button>
              ) : null}
            </div>
            {msg ? <p className="mt-2 text-xs text-neutral-600 dark:text-neutral-300">{msg}</p> : null}
          </div>

          {/* Review tray */}
          {pending.map((p) => (
            <div
              key={p.source}
              className="rounded-md border border-amber-300 bg-amber-50/50 p-3 dark:border-amber-800/60 dark:bg-amber-950/20"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <SourceBadge source={p.source} />
                  <span className="text-sm font-medium">{p.label}</span>
                  <span className={HINT}>· review</span>
                </div>
                <div className="flex gap-2">
                  <button
                    type="button"
                    className={BTN}
                    disabled={palettes.length >= GROUPS_MAX}
                    title={palettes.length >= GROUPS_MAX ? `Palettes full (${GROUPS_MAX} max)` : undefined}
                    onClick={() => keepGroup(p)}
                  >
                    Keep as palette
                  </button>
                  <button type="button" className={BTN} onClick={() => addToPalette(p.colors)}>
                    Add to Colour palette
                  </button>
                  <button type="button" className={BTN} onClick={() => clearTray(p.source)}>
                    Dismiss
                  </button>
                </div>
              </div>
              <div className="mt-2 space-y-2">
                {p.colors.map((c, i) => (
                  <SwatchRow
                    key={i}
                    color={c}
                    onHex={(hex) =>
                      updateTrayColors(
                        p.source,
                        p.colors.map((x, j) => (j === i ? { ...x, hex } : x)),
                      )
                    }
                    onName={(name) =>
                      updateTrayColors(
                        p.source,
                        p.colors.map((x, j) => (j === i ? { ...x, name } : x)),
                      )
                    }
                    onRemove={() =>
                      updateTrayColors(
                        p.source,
                        p.colors.filter((_, j) => j !== i),
                      )
                    }
                    extraAction={{
                      label: "→ palette",
                      title: "Add just this colour to your Colour palette",
                      onClick: () => addToPalette([c]),
                    }}
                  />
                ))}
              </div>
            </div>
          ))}

          {/* Kept palette groups */}
          {palettes.length ? (
            <div className="space-y-3">
              <div className="text-sm font-medium">Palettes</div>
              {palettes.map((g, gi) => (
                <div
                  key={g.id}
                  className="rounded-md border border-neutral-200 p-3 dark:border-neutral-800"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      {g.source ? <SourceBadge source={g.source} /> : null}
                      <input
                        className="rounded-md border border-transparent px-1 py-0.5 text-sm font-medium hover:border-neutral-300 focus:border-neutral-300 dark:hover:border-neutral-700 dark:focus:border-neutral-700 dark:bg-transparent"
                        value={g.name}
                        aria-label="Palette name"
                        onChange={(e) =>
                          setPalettes(
                            palettes.map((x, j) =>
                              j === gi ? { ...x, name: e.target.value.slice(0, 80) } : x,
                            ),
                          )
                        }
                      />
                    </div>
                    <button
                      type="button"
                      className="text-xs text-red-600"
                      onClick={() => setPalettes(palettes.filter((_, j) => j !== gi))}
                    >
                      Remove palette
                    </button>
                  </div>
                  <div className="mt-2 space-y-2">
                    {g.colors.map((c, ci) => (
                      <SwatchRow
                        key={ci}
                        color={c}
                        onHex={(hex) =>
                          setPalettes(
                            palettes.map((x, j) =>
                              j === gi
                                ? { ...x, colors: x.colors.map((y, k) => (k === ci ? { ...y, hex } : y)) }
                                : x,
                            ),
                          )
                        }
                        onName={(name) =>
                          setPalettes(
                            palettes.map((x, j) =>
                              j === gi
                                ? { ...x, colors: x.colors.map((y, k) => (k === ci ? { ...y, name } : y)) }
                                : x,
                            ),
                          )
                        }
                        onRemove={() =>
                          setPalettes(
                            palettes.map((x, j) =>
                              j === gi ? { ...x, colors: x.colors.filter((_, k) => k !== ci) } : x,
                            ),
                          )
                        }
                        extraAction={{
                          label: "→ palette",
                          title: "Add this colour to your Colour palette",
                          onClick: () => addToPalette([c]),
                        }}
                      />
                    ))}
                  </div>
                </div>
              ))}
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

function SourceBadge({ source }: { source: PaletteSource }) {
  return (
    <span className="rounded bg-neutral-200 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300">
      {SOURCE_LABEL[source]}
    </span>
  );
}

function SwatchRow({
  color,
  onHex,
  onName,
  onRemove,
  extraAction,
}: {
  color: PaletteColor;
  onHex?: (hex: string) => void;
  onName?: (name: string) => void;
  onRemove?: () => void;
  extraAction?: { label: string; title?: string; onClick: () => void };
}) {
  const safeHex = HEX6.test(color.hex.toLowerCase()) ? color.hex : "#000000";
  return (
    <div className="flex items-center gap-2">
      {onHex ? (
        <input
          type="color"
          value={safeHex}
          onChange={(e) => onHex(e.target.value)}
          className={SWATCH}
          aria-label="Colour"
        />
      ) : (
        <span className={SWATCH} style={{ backgroundColor: safeHex }} aria-hidden />
      )}
      {onName ? (
        <input
          className={INPUT}
          placeholder="Name (e.g. Primary)"
          maxLength={NAME_MAX}
          value={color.name ?? ""}
          onChange={(e) => onName(e.target.value.slice(0, NAME_MAX))}
        />
      ) : (
        <span className="flex-1 text-sm">{color.name || color.hex}</span>
      )}
      {color.role ? <span className="text-xs text-neutral-500">{color.role}</span> : null}
      {color.estimated ? (
        <span
          title="Estimated from a swatch/image (no printed colour code) — double-check it"
          className="rounded bg-amber-100 px-1 py-0.5 text-[10px] text-amber-700 dark:bg-amber-900/40 dark:text-amber-300"
        >
          ~est
        </span>
      ) : null}
      {extraAction ? (
        <button
          type="button"
          title={extraAction.title}
          onClick={extraAction.onClick}
          className="rounded border border-neutral-300 px-2 py-1 text-xs dark:border-neutral-700"
        >
          {extraAction.label}
        </button>
      ) : null}
      {onRemove ? (
        <button
          type="button"
          onClick={onRemove}
          aria-label="Remove colour"
          className="rounded border border-neutral-300 px-2 py-1 text-xs text-red-600 dark:border-neutral-700"
        >
          ✕
        </button>
      ) : null}
    </div>
  );
}
