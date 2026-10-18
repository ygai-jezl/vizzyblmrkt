"use client";

import { useEffect } from "react";

/** Headlines that may be shrunk to fit their box (see fitHeads). */
const FIT = ".manifesto h1, .ch h3, .close h2, .fhero h1, .hub-h, .fcard b, .fnext b";

/**
 * Shrink a headline until its longest line fits, rather than let it break mid-phrase
 * or run off the page. English keeps its own line breaks; there, only a single word
 * that cannot wrap is shrunk. Longer languages fit every headline.
 */
function fitHeads(root: HTMLElement, lang: string) {
  for (const el of root.querySelectorAll<HTMLElement>(FIT)) {
    el.style.fontSize = "";
    if (!el.offsetParent || (lang === "en" && (el.children.length || /\s/.test((el.textContent ?? "").trim())))) continue;
    const room = el.clientWidth;
    const r = document.createRange();
    el.style.whiteSpace = "nowrap";
    r.selectNodeContents(el);
    const need = r.getBoundingClientRect().width;
    el.style.whiteSpace = "";
    if (need > room + 1) el.style.fontSize = (Math.max(0.56, room / need) * parseFloat(getComputedStyle(el).fontSize)).toFixed(1) + "px";
  }
}

/**
 * Page-wide behaviour for the site: the document's language and direction (the
 * root layout is shared with the app and says English), headline fitting, and on a
 * stage page the arrow keys and swipes that move round the loop.
 */
export function SiteBehaviour({ lang, dir, prevHref, nextHref }: { lang: string; dir: "ltr" | "rtl"; prevHref?: string; nextHref?: string }) {
  useEffect(() => {
    const html = document.documentElement;
    const was = { lang: html.lang, dir: html.dir };
    html.lang = lang;
    html.dir = dir;
    const root = document.querySelector<HTMLElement>(".yg");
    if (!root) return;
    const fit = () => fitHeads(root, lang);
    fit();
    let t: ReturnType<typeof setTimeout> | undefined;
    const onResize = () => { clearTimeout(t); t = setTimeout(fit, 120); };
    window.addEventListener("resize", onResize);
    void document.fonts?.ready.then(fit);

    const go = (forward: boolean) => { const h = forward ? nextHref : prevHref; if (h) window.location.href = h; };
    const onKey = (e: KeyboardEvent) => {
      if (!prevHref || e.metaKey || e.ctrlKey || e.altKey || (e.key !== "ArrowLeft" && e.key !== "ArrowRight")) return;
      if ((e.target as HTMLElement).closest?.("input, textarea, select, [role=tab], [contenteditable]")) return;
      e.preventDefault();
      go((e.key === "ArrowRight") !== (dir === "rtl"));
    };
    let tx = 0, ty = 0;
    const onStart = (e: TouchEvent) => { tx = e.touches[0]?.clientX ?? 0; ty = e.touches[0]?.clientY ?? 0; };
    const onEnd = (e: TouchEvent) => {
      if (!prevHref) return;
      const dx = (e.changedTouches[0]?.clientX ?? 0) - tx, dy = (e.changedTouches[0]?.clientY ?? 0) - ty;
      if (Math.abs(dx) > 70 && Math.abs(dx) > 2 * Math.abs(dy)) go((dx < 0) !== (dir === "rtl"));
    };
    document.addEventListener("keydown", onKey);
    const hub = root.querySelector<HTMLElement>(".stagehub");
    hub?.addEventListener("touchstart", onStart, { passive: true });
    hub?.addEventListener("touchend", onEnd, { passive: true });
    return () => {
      html.lang = was.lang; html.dir = was.dir;
      clearTimeout(t);
      window.removeEventListener("resize", onResize);
      document.removeEventListener("keydown", onKey);
      hub?.removeEventListener("touchstart", onStart);
      hub?.removeEventListener("touchend", onEnd);
    };
  }, [lang, dir, prevHref, nextHref]);
  return null;
}
