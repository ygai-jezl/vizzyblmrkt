"use client";

import { useEffect, useRef, useState, type ComponentType, type MouseEvent } from "react";
import Link from "next/link";
import { BookOpen, Check, ExternalLink, Lock, TriangleAlert, X } from "lucide-react";
import { helpPage } from "@/lib/help/pages";
import { parseHelpPath } from "@/lib/help/places";
import { HELP_LOADERS } from "./loaders";
import { listenForHowTo } from "./openHowTo";

/** A setup step as /api/admin/growth returns it with the setup guide on. */
export interface GuideStep {
  label: string;
  done: boolean;
  href: string;
  howTo?: string;
  needs?: Array<{ label: string; href: string }>;
  optional?: boolean;
  warning?: string;
}

const slugOf = (path: string | undefined) => (path ? (parseHelpPath(path)?.slug ?? null) : null);

/**
 * The How to drawer: a help page beside the page you're on, so you can follow
 * the steps while you do them. It stays open as you move around the app. Above
 * the page, the setup steps it covers and where your brand is on each. Links to
 * other help pages open here; links into the app go there.
 */
export function HowToDrawer() {
  const [path, setPath] = useState<string | null>(null);
  const [body, setBody] = useState<{ slug: string; Component: ComponentType } | null>(null);
  const [steps, setSteps] = useState<GuideStep[] | null>(null);
  const scroller = useRef<HTMLDivElement>(null);

  useEffect(() => listenForHowTo(setPath), []);

  const parsed = path ? parseHelpPath(path) : null;
  const slug = parsed?.slug ?? null;
  const anchor = parsed?.anchor ?? null;

  useEffect(() => {
    if (slug === null) return;
    let alive = true;
    const load = Object.hasOwn(HELP_LOADERS, slug) ? HELP_LOADERS[slug] : undefined;
    if (!load) return;
    load()
      .then((m) => {
        if (alive) setBody({ slug, Component: m.default });
      })
      .catch(() => {
        // Offline: the Full page link still works.
      });
    return () => {
      alive = false;
    };
  }, [slug]);

  useEffect(() => {
    if (!path) return;
    let alive = true;
    fetch("/api/admin/growth")
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { steps?: GuideStep[] } | null) => {
        if (alive) setSteps(data?.steps ?? null);
      })
      .catch(() => {
        // Offline: the guide still shows, without your progress.
      });
    return () => {
      alive = false;
    };
  }, [path]);

  // Open at the section asked for, once its page has loaded.
  useEffect(() => {
    if (!body || body.slug !== slug) return;
    // Scroll the drawer only: scrollIntoView would move the page behind it too.
    const box = scroller.current;
    if (!box) return;
    const el = anchor ? box.querySelector(`#${CSS.escape(anchor)}`) : null;
    const top = el ? el.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop - 12 : 0;
    box.scrollTo({ top });
  }, [body, slug, anchor, path]);

  useEffect(() => {
    if (!path) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPath(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [path]);

  if (!path || slug === null) return null;
  const page = helpPage(slug);
  const Body = body && body.slug === slug ? body.Component : null;
  const mine = (steps ?? []).filter((st) => slugOf(st.howTo) === slug);

  // Help links stay in the drawer; the developer docs open in a new tab; app links go to the app.
  const onClickCapture = (e: MouseEvent<HTMLDivElement>) => {
    const a = (e.target as HTMLElement).closest("a");
    const href = a?.getAttribute("href");
    if (!href || e.metaKey || e.ctrlKey || e.shiftKey) return;
    if (href.startsWith("#")) return;
    if (parseHelpPath(href)) {
      e.preventDefault();
      setPath(href);
    } else if (href.startsWith("/developers")) {
      e.preventDefault();
      window.open(href, "_blank", "noopener");
    }
  };

  return (
    <aside
      aria-label="How to"
      className="sticky top-0 flex h-screen w-[420px] max-w-full shrink-0 flex-col border-l border-shell-line bg-shell-side text-shell-ink"
    >
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-shell-line px-4">
        <BookOpen size={16} aria-hidden className="shrink-0 text-shell-accent" />
        <span className="truncate text-sm font-semibold">How to{page?.slug ? `: ${page.label}` : ""}</span>
        <span className="flex-1" />
        <a
          href={path}
          target="_blank"
          rel="noopener"
          className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap text-xs text-shell-accent hover:underline"
        >
          Full page
          <ExternalLink size={12} aria-hidden />
        </a>
        <button
          type="button"
          onClick={() => setPath(null)}
          aria-label="Close How to"
          className="grid h-8 w-8 place-items-center rounded-md text-shell-muted hover:bg-shell-hover hover:text-shell-ink"
        >
          <X size={16} aria-hidden />
        </button>
      </div>
      <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto px-5 pb-10 pt-4" onClickCapture={onClickCapture}>
        {mine.length ? (
          <section className="mb-2 rounded-xl border border-shell-line bg-shell-card p-3.5">
            <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-shell-muted">On your brand</p>
            <ul className="space-y-2">
              {mine.map((st) => (
                <li key={st.label} className="flex items-start gap-2 text-sm">
                  {st.done ? (
                    <Check size={15} aria-label="Done" className="mt-0.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
                  ) : st.needs ? (
                    <Lock size={14} aria-label="Needs another step first" className="mt-0.5 shrink-0 text-shell-faint" />
                  ) : (
                    <span aria-label="To do" className="mt-1 h-3 w-3 shrink-0 rounded-full border-2 border-shell-accent" />
                  )}
                  <span className="min-w-0">
                    {st.done ? (
                      <span className="text-shell-muted">{st.label}</span>
                    ) : (
                      <Link href={st.href} className="text-shell-ink hover:underline">
                        {st.label}
                      </Link>
                    )}
                    {!st.done && st.needs ? (
                      <span className="block text-xs text-shell-muted">
                        Needs: {st.needs.map((n) => n.label).join(", ")}
                      </span>
                    ) : null}
                    {!st.done && st.warning ? (
                      <span className="mt-0.5 flex items-start gap-1 text-xs text-amber-700 dark:text-amber-400">
                        <TriangleAlert size={12} aria-hidden className="mt-0.5 shrink-0" />
                        {st.warning}
                      </span>
                    ) : null}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
        {Body ? (
          <div className="text-sm [&_h1]:text-xl [&_h2]:mt-8 [&_h2]:text-base">
            <Body />
          </div>
        ) : (
          <p className="text-sm text-shell-muted">Loading…</p>
        )}
      </div>
    </aside>
  );
}
