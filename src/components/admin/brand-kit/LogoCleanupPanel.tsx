"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { BrandLogo } from "@/lib/types/brandLogo";
import { brandLogoPublicUrl } from "@/lib/content/brandKit";
import { fitLogoSize, HEAVY_LOGO_BYTES, type EmailStyleLogoChoice } from "./emailStyleForm";
import {
  CLEANUP_WORK_SIZE,
  cleanupFileName,
  fitWithin,
  makeWhite,
  removeWhiteBackground,
  showsAsWhiteBox,
  trimBox,
  type CleanupMode,
} from "./logoCleanup";

/**
 * Brand › Email style's logo clean-up (admins, with the header options on): "Remove white
 * background" and "Make logo white" for the picked logo, with Before and After on the header
 * as it is now. It runs here, on a canvas (logoCleanup.ts does the pixels), and "Save as a new
 * logo" adds the result to Brand › Logos as a new PNG through the usual upload, so the
 * original is never changed. The card then picks it; emails change only when the style is saved.
 */

const HINT = "text-xs text-neutral-500";
const BTN =
  "rounded-md border border-neutral-300 px-3 py-1.5 text-sm disabled:opacity-50 dark:border-neutral-700";
const ERROR = "text-xs text-red-600 dark:text-red-400";

const CANT_EDIT = "This logo can't be edited here";
const NOT_LOADED = "We couldn't load this logo";

/** The logo's pixels on white (so any transparency counts as background), or why there are none. */
type Pixels = { rgba: Uint8ClampedArray; width: number; height: number };

/** A clean-up's result, trimmed and sized for email, or why there isn't one. */
type Processed = { canvas: HTMLCanvasElement } | { message: string };

/** The logo didn't load, or a canvas couldn't be read: worth another try, so it isn't kept. */
function retryable(r: Processed): boolean {
  return "message" in r && (r.message === NOT_LOADED || r.message === CANT_EDIT);
}

/** Load the logo (same-origin: the logo route sends no CORS headers) on a white canvas, long side ≤ 1200px. */
function loadPixels(src: string): Promise<Pixels | string> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      try {
        if (!(img.naturalWidth > 0) || !(img.naturalHeight > 0)) return resolve(CANT_EDIT);
        const scale = Math.min(1, CLEANUP_WORK_SIZE / Math.max(img.naturalWidth, img.naturalHeight));
        const width = Math.max(1, Math.round(img.naturalWidth * scale));
        const height = Math.max(1, Math.round(img.naturalHeight * scale));
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const g = canvas.getContext("2d");
        if (!g) return resolve(CANT_EDIT);
        g.fillStyle = "#ffffff";
        g.fillRect(0, 0, width, height);
        g.imageSmoothingQuality = "high";
        g.drawImage(img, 0, 0, width, height);
        resolve({ rgba: g.getImageData(0, 0, width, height).data, width, height });
      } catch {
        resolve(CANT_EDIT); // a tainted or unsupported canvas: a message, never an error
      }
    };
    img.onerror = () => resolve(NOT_LOADED);
    img.src = src;
  });
}

/** Clean the pixels, trim to what's left and scale it to fit 600×144 (3× the header's logo box). */
function clean(px: Pixels, mode: CleanupMode): Processed {
  try {
    const r = mode === "white" ? makeWhite(px.rgba, px.width, px.height) : removeWhiteBackground(px.rgba, px.width, px.height);
    if (!r.changed) return { message: r.message };
    const box = trimBox(r.rgba, px.width, px.height);
    if (!box) return { message: "Nothing is left of this logo once its background is gone" };
    const size = fitWithin(box.width, box.height);
    const full = document.createElement("canvas");
    full.width = px.width;
    full.height = px.height;
    const canvas = document.createElement("canvas");
    canvas.width = size.width;
    canvas.height = size.height;
    const fg = full.getContext("2d");
    const g = canvas.getContext("2d");
    if (!fg || !g) return { message: CANT_EDIT };
    const data = fg.createImageData(px.width, px.height);
    data.data.set(r.rgba);
    fg.putImageData(data, 0, 0);
    g.imageSmoothingEnabled = true;
    g.imageSmoothingQuality = "high";
    g.drawImage(full, box.x, box.y, box.width, box.height, 0, 0, size.width, size.height);
    return { canvas };
  } catch {
    return { message: CANT_EDIT };
  }
}

export function LogoCleanupPanel({
  logo,
  tenantId,
  stops,
  whiteBackground,
  disabled,
  onBusy,
  onPrimaryPinned,
  onAdded,
}: {
  /** The picked logo (a listed PNG or JPEG). The card remounts this for another one. */
  logo: EmailStyleLogoChoice;
  tenantId: string;
  /** The header's colours as the band draws them: one, or a gradient's two. */
  stops: readonly string[];
  /** The logo's corners are white; null = not known yet. */
  whiteBackground: boolean | null;
  disabled: boolean;
  onBusy: (busy: boolean) => void;
  /** The primary as the server kept it (flagged first if none was), so the new logo didn't take its place. */
  onPrimaryPinned: (id: string) => void;
  onAdded: (logo: BrandLogo) => void;
}) {
  const [open, setOpen] = useState(false);
  const [remove, setRemove] = useState(false);
  const [white, setWhite] = useState(false);
  const [results, setResults] = useState<Partial<Record<CleanupMode, Processed>>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Make logo white clears the background too.
  const mode: CleanupMode | null = white ? "white" : remove ? "remove" : null;
  const src = brandLogoPublicUrl(tenantId, logo.filename);

  // Cached by option, so a header change (every tick of a colour drag) only restyles the tiles.
  // A failure worth retrying is dropped from both caches, so the next tick or reopen tries again.
  const pixels = useRef<Promise<Pixels | string> | null>(null);
  const cache = useRef(new Map<CleanupMode, Promise<Processed>>());
  const cleanUp = useCallback(
    (m: CleanupMode) => {
      let p = cache.current.get(m);
      if (!p) {
        const load = (pixels.current ??= loadPixels(src));
        const done = load.then(
          (px) =>
            // A beat first, so "Working…" shows before the pixels are crunched.
            new Promise<Processed>((resolve) =>
              setTimeout(() => resolve(typeof px === "string" ? { message: px } : clean(px, m)), 0),
            ),
        );
        void done.then((r) => {
          if (!retryable(r)) return;
          if (pixels.current === load) pixels.current = null;
          if (cache.current.get(m) === done) cache.current.delete(m);
        });
        cache.current.set(m, done);
        p = done;
      }
      return p;
    },
    [src],
  );
  useEffect(() => {
    if (!open || !mode) return;
    void cleanUp(mode).then((r) => setResults((prev) => (prev[mode] === r ? prev : { ...prev, [mode]: r })));
  }, [open, mode, cleanUp]);

  const result = mode ? results[mode] : undefined;
  const band = stops.length > 1 ? `linear-gradient(135deg,${stops[0]},${stops[1]})` : stops[0];

  async function save() {
    if (!mode || !result || !("canvas" in result)) return;
    setSaving(true);
    onBusy(true);
    setError(null);
    try {
      const blob = await new Promise<Blob | null>((resolve) => result.canvas.toBlob(resolve, "image/png"));
      if (!blob) {
        setError(`${CANT_EDIT}.`);
        return;
      }
      if (blob.size > HEAVY_LOGO_BYTES) {
        setError("The cleaned-up logo is over 200 KB, too big for email — try a simpler logo.");
        return;
      }
      const fd = new FormData();
      fd.append("file", new File([blob], cleanupFileName(logo.title, mode), { type: "image/png" }));
      // With none flagged, the newest logo is the primary, and this upload would take its place
      // (in Create, "Use brand kit", Vizzy): the server flags today's first, from its own list.
      fd.append("keepPrimary", "1");
      const res = await fetch("/api/admin/brand-kit/logos/upload", { method: "POST", body: fd });
      const data = (await res.json().catch(() => ({}))) as { logo?: BrandLogo; primaryId?: string; message?: string };
      if (!res.ok || !data.logo) {
        setError(
          data.message ??
            (res.status === 503
              ? "Logos aren't switched on here, so the new logo can't be saved."
              : "Couldn't save the new logo — try again."),
        );
        return;
      }
      if (data.primaryId) onPrimaryPinned(data.primaryId);
      onAdded(data.logo);
    } catch {
      setError("Couldn't save the new logo — check your connection and try again.");
    } finally {
      setSaving(false);
      onBusy(false);
    }
  }

  if (!open) {
    const hint = whiteBackground === true && showsAsWhiteBox(stops);
    return (
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        {hint ? <p className="text-sm text-amber-800 dark:text-amber-300">Your logo has a white background — clean it up?</p> : null}
        <button
          type="button"
          disabled={disabled}
          className={BTN}
          onClick={() => {
            setOpen(true);
            if (hint) setRemove(true);
          }}
        >
          {hint ? "Clean it up" : "Clean up this logo"}
        </button>
      </div>
    );
  }

  return (
    <section aria-label="Clean up this logo" className="space-y-3 rounded-md border border-neutral-200 p-3 dark:border-neutral-800">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-medium">Clean up this logo</h3>
          <p className={HINT}>Saved as a new logo in Brand › Logos. The original stays as it is.</p>
        </div>
        <button
          type="button"
          disabled={saving}
          className={`shrink-0 ${BTN}`}
          onClick={() => {
            setOpen(false);
            // A failure is tried again on reopen, which shows Working… rather than the old message.
            setResults((prev) => Object.fromEntries(Object.entries(prev).filter(([, r]) => !retryable(r))));
          }}
        >
          Close
        </button>
      </div>
      <div className="space-y-2">
        <label className={`flex items-start gap-2 text-sm ${disabled || white ? "cursor-not-allowed" : "cursor-pointer"}`}>
          <input
            type="checkbox"
            className="mt-0.5"
            checked={remove || white}
            disabled={disabled || white}
            aria-describedby="logo-cleanup-remove-hint"
            onChange={(e) => {
              setRemove(e.target.checked);
              setError(null);
            }}
          />
          <span>
            Remove white background
            <span id="logo-cleanup-remove-hint" className={`block ${HINT}`}>
              White areas inside the logo, like the inside of an &lsquo;o&rsquo;, stay white — tick Make logo white to
              clear them.
            </span>
          </span>
        </label>
        <label className={`flex items-start gap-2 text-sm ${disabled ? "cursor-not-allowed" : "cursor-pointer"}`}>
          <input
            type="checkbox"
            className="mt-0.5"
            checked={white}
            disabled={disabled}
            aria-describedby="logo-cleanup-white-hint"
            onChange={(e) => {
              setWhite(e.target.checked);
              setError(null);
            }}
          />
          <span>
            Make logo white
            <span id="logo-cleanup-white-hint" className={`block ${HINT}`}>
              For a one-colour logo: it turns white, and its white details turn see-through.
            </span>
          </span>
        </label>
      </div>
      <div className="flex flex-wrap gap-3">
        <Tile label="Before" band={band}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={src} alt={`${logo.title}, as it is`} className="max-h-12 max-w-[200px]" />
        </Tile>
        <Tile label="After" band={band}>
          {!mode ? (
            <span className="rounded bg-white/85 px-2 py-1 text-xs text-neutral-700">Tick an option to see it</span>
          ) : !result ? (
            <span className="rounded bg-white/85 px-2 py-1 text-xs text-neutral-700">Working…</span>
          ) : "canvas" in result ? (
            <Drawn canvas={result.canvas} label={`${logo.title}, cleaned up`} />
          ) : (
            <span className="rounded bg-white/85 px-2 py-1 text-xs text-neutral-700">{result.message}</span>
          )}
        </Tile>
      </div>
      <p className={HINT}>
        Best for a one-colour logo on plain white. Check the After — detailed or multi-colour logos can come out rough.
      </p>
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          disabled={disabled || !result || !("canvas" in result)}
          onClick={() => void save()}
          className={`font-medium ${BTN}`}
        >
          {saving ? "Saving…" : "Save as a new logo"}
        </button>
        {error ? (
          <span role="alert" className={ERROR}>
            {error}
          </span>
        ) : null}
      </div>
    </section>
  );
}

/** A preview tile: the logo on the header's colours, at the size an email shows it. */
function Tile({ label, band, children }: { label: string; band: string | undefined; children: React.ReactNode }) {
  return (
    <figure className="space-y-1">
      <figcaption className={HINT}>{label}</figcaption>
      <div className="flex h-20 w-[248px] max-w-full items-center rounded px-6 py-4" style={{ background: band }}>
        {children}
      </div>
    </figure>
  );
}

/** A copy of an offscreen canvas, shown at the size the header shows the logo. */
function Drawn({ canvas, label }: { canvas: HTMLCanvasElement; label: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const size = fitLogoSize(canvas.width, canvas.height);
  useEffect(() => {
    const g = ref.current?.getContext("2d");
    if (!g) return;
    g.clearRect(0, 0, canvas.width, canvas.height);
    g.drawImage(canvas, 0, 0);
  }, [canvas]);
  return (
    <canvas
      ref={ref}
      width={canvas.width}
      height={canvas.height}
      role="img"
      aria-label={label}
      style={size ?? undefined}
    />
  );
}
