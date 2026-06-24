"use client";

import { LOCALES } from "@/lib/i18n/locale";

/**
 * In-widget language picker, rendered only when a launch supports >1 language.
 * Persists the choice in an `lng` cookie and reloads with `?lng=` so the server
 * re-resolves and re-renders in the chosen language (keeps SSR authoritative —
 * no client-only locale state, so no hydration mismatch).
 */
export function LanguageSwitcher({
  locales,
  current,
  label,
}: {
  locales: string[];
  current: string;
  /** Localized accessible name for the picker (resolved by the server page). */
  label: string;
}) {
  if (locales.length < 2) return null;
  const options = locales
    .map((code) => LOCALES.find((l) => l.code === code))
    .filter((l): l is (typeof LOCALES)[number] => !!l);
  if (options.length < 2) return null;

  return (
    <div className="flex justify-end">
      <select
        value={current}
        aria-label={label}
        onChange={(e) => {
          const lng = e.target.value;
          // Persist the choice. NOTE: inside the cross-site /embed iframe this is a
          // third-party cookie and may be blocked (Safari ITP / Chrome phase-out),
          // so cross-load persistence isn't guaranteed there — but the `?lng=` below
          // keeps the immediate reload (and SSR) authoritative regardless.
          document.cookie = `lng=${lng};path=/;max-age=31536000;samesite=lax`;
          const url = new URL(window.location.href);
          url.searchParams.set("lng", lng);
          window.location.href = url.toString();
        }}
        className="rounded-md border border-neutral-300 bg-transparent px-2 py-1 text-xs text-neutral-600 dark:border-neutral-700 dark:text-neutral-300"
      >
        {options.map((l) => (
          <option key={l.code} value={l.code}>
            {l.nativeName}
          </option>
        ))}
      </select>
    </div>
  );
}
