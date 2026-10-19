"use client";

import { useRef, useState, type KeyboardEvent } from "react";
import type { ThemePreference } from "@/lib/theme";
import { siteThemeCookie } from "@/lib/site/theme";

const ICON = { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true } as const;

const ICONS: Record<ThemePreference, React.ReactNode> = {
  light: (
    <svg {...ICON}>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
    </svg>
  ),
  system: (
    <svg {...ICON}>
      <rect x="2.5" y="3.5" width="19" height="13" rx="2" />
      <path d="M8 20.5h8M12 16.5v4" />
    </svg>
  ),
  dark: (
    <svg {...ICON}>
      <path d="M20.5 13.3A8.5 8.5 0 1 1 10.7 3.5a6.6 6.6 0 0 0 9.8 9.8Z" />
    </svg>
  ),
};

const ORDER: ThemePreference[] = ["light", "system", "dark"];

/**
 * Light, system or dark: three icons in the footer. The choice goes on the .yg wrapper
 * (data-yg-theme) and in a cookie, and a "yg-theme" event tells the loops to redraw.
 */
export function ThemeSwitch({ initial, labels }: { initial: ThemePreference; labels: Record<ThemePreference | "theme", string> }) {
  const [pref, setPref] = useState<ThemePreference>(initial);
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);

  const choose = (p: ThemePreference) => {
    setPref(p);
    const yg = document.querySelector<HTMLElement>(".yg");
    if (yg) {
      if (p === "system") yg.removeAttribute("data-yg-theme");
      else yg.setAttribute("data-yg-theme", p);
    }
    document.cookie = siteThemeCookie(p, window.location.protocol === "https:");
    document.dispatchEvent(new Event("yg-theme"));
  };

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    e.preventDefault();
    const k = (ORDER.indexOf(pref) + (e.key === "ArrowRight" ? 1 : ORDER.length - 1)) % ORDER.length;
    const next = ORDER[k] as ThemePreference;
    choose(next);
    buttons.current[k]?.focus();
  };

  return (
    <div className="themes" role="radiogroup" aria-label={labels.theme} onKeyDown={onKey}>
      {ORDER.map((p, i) => (
        <button
          key={p}
          ref={(el) => { buttons.current[i] = el; }}
          type="button"
          role="radio"
          aria-checked={pref === p}
          tabIndex={pref === p ? 0 : -1}
          aria-label={labels[p]}
          title={labels[p]}
          onClick={() => choose(p)}
        >
          {ICONS[p]}
        </button>
      ))}
    </div>
  );
}
