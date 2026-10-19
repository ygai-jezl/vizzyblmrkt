"use client";

import { useState } from "react";
import { Globe, RefreshCw, UploadCloud } from "lucide-react";
import type { SiteFont, SiteFonts } from "@/lib/types/imageStyle";
import { fontStackFor } from "@/lib/content/fonts";

/**
 * Brand › Fonts "Found on your site": the fonts images use when none was uploaded, read from the
 * brand's website (Brand image style). Shows what each role uses and why, with Check again and
 * Upload a font.
 */
export function SiteFontsPanel({
  initial,
  domain,
  onUpload,
}: {
  initial: SiteFonts | null;
  domain: string | null;
  onUpload: () => void;
}) {
  const [fonts, setFonts] = useState<SiteFonts | null>(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function check() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/brand-kit/site-fonts", { method: "POST" });
      const data = (await res.json().catch(() => ({}))) as { siteFonts?: SiteFonts; error?: string; message?: string };
      if (res.ok && data.siteFonts) setFonts(data.siteFonts);
      else if (data.error === "no_primary_domain") setError("Add your website under Domains first.");
      else if (data.error === "forbidden") setError("Only an admin can check the site.");
      else setError(data.message ?? "Couldn't check your site. Try again.");
    } catch {
      setError("Couldn't check your site. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  const roles = fonts ? ([["Headings", fonts.heading], ["Body", fonts.body]] as const) : [];
  const found = roles.some(([, f]) => f);

  return (
    <div className="rounded-xl border border-neutral-200 p-3 dark:border-neutral-800">
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2 text-sm font-medium">
          <Globe size={15} className="shrink-0 text-neutral-400" />
          <span>Found on your site</span>
          {fonts?.domain ?? domain ? (
            <span className="truncate text-xs font-normal text-neutral-500">{fonts?.domain ?? domain}</span>
          ) : null}
        </div>
        <button
          type="button"
          onClick={check}
          disabled={busy}
          className="inline-flex shrink-0 items-center gap-1 rounded-md border border-neutral-300 px-2 py-1 text-xs hover:bg-neutral-50 disabled:opacity-60 dark:border-neutral-700 dark:hover:bg-neutral-900"
        >
          <RefreshCw size={12} className={busy ? "animate-spin" : ""} />
          {busy ? "Checking…" : fonts ? "Check again" : "Check my site"}
        </button>
      </div>

      {!fonts ? (
        <p className="text-sm text-neutral-500">Not checked yet. Images use the fonts we find there.</p>
      ) : !found ? (
        <p className="text-sm text-neutral-500">No fonts named on your site. Images use our standard fonts.</p>
      ) : (
        <ul className="space-y-1.5">
          {roles.map(([label, f]) =>
            f ? (
              <li key={label} className="flex items-baseline gap-3">
                <span className="w-16 shrink-0 text-xs text-neutral-500">{label}</span>
                <span className="text-base" style={{ fontFamily: fontStackFor(f.family) }}>
                  {f.family}
                </span>
                <span className="truncate text-xs text-neutral-500">{why(f)}</span>
              </li>
            ) : null,
          )}
        </ul>
      )}

      {error ? <p className="mt-2 text-xs text-red-600">{error}</p> : null}

      <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-neutral-100 pt-2 dark:border-neutral-900">
        <span className="text-xs text-neutral-500">Uploaded fonts always come first.</span>
        <button
          type="button"
          onClick={onUpload}
          className="inline-flex items-center gap-1 text-xs font-medium text-neutral-700 hover:text-neutral-950 dark:text-neutral-300 dark:hover:text-white"
        >
          <UploadCloud size={13} /> Upload a font
        </button>
      </div>
    </div>
  );
}

function why(f: SiteFont): string {
  if (f.source === "google") return "From Google Fonts";
  if (f.detected) return `Closest free match for ${f.detected}`;
  return "Your site uses system fonts";
}
