"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { createLoop } from "./engine/loop";

/** The loop's words, already translated. */
export interface LoopLabels {
  stages: Record<string, string>;
  core: string[];
  ghost: [string, string];
  approve: string;
  back: string;
}

type LoopHandle = { setTarget: (t: number | "core") => void; destroy: () => void };

function LoopBox({ id, className, label, onReady }: { id?: string; className: string; label?: string; onReady: (root: HTMLDivElement) => () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => (ref.current ? onReady(ref.current) : undefined), [onReady]);
  return (
    <div ref={ref} id={id} className={className} role={label ? "img" : undefined} aria-label={label} aria-hidden={label ? undefined : true}>
      <canvas aria-hidden="true" />
      <div className="corona" aria-hidden="true" />
      <div className="eclipse" aria-hidden="true" />
      <div className="overlay" aria-hidden="true" />
    </div>
  );
}

/** The hero: the loop laps on its own; a click on a stage scrolls to its chapter. */
export function HeroLoop({ labels, label, lapText, approveText }: { labels: LoopLabels; label: string; lapText: string; approveText: string }) {
  const [lap, setLap] = useState(1);
  const [ready] = useState(() => (root: HTMLDivElement) => {
    const loop: LoopHandle = createLoop(root, { mode: "travel", labels, onPick: scrollToChapter, onLap: (n: number) => setLap(n) });
    return () => loop.destroy();
  });
  return (
    <header className="hero">
      <LoopBox id="heroLoop" className="loopbox" label={label} onReady={ready} />
      <div className="hero-foot">
        <span>{lapText}&nbsp;<b>{String(lap).padStart(2, "0")}</b></span>
        <span className="key"><i />{approveText}</span>
      </div>
    </header>
  );
}

function scrollToChapter(id: string) {
  const ch = document.getElementById(`ch-${id}`);
  if (!ch) return;
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  ch.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" });
}

/**
 * "The Loop": a pinned loop beside the chapters. The chapter crossing the middle of
 * the screen is the one being read; the loop's pulse glides to it.
 */
export function LoopStory({ labels, first, children }: { labels: LoopLabels; first: { name: string; no: string }; children: ReactNode }) {
  const story = useRef<HTMLDivElement>(null);
  const [cap, setCap] = useState<{ name: string; no: string }>({ name: first.name, no: `${first.no} / 06` });
  const [ready] = useState(() => (root: HTMLDivElement) => {
    const loop: LoopHandle = createLoop(root, { mode: "park", vertical: true, count: 1800, labels, onPick: scrollToChapter });
    const chapters = [...(story.current?.querySelectorAll<HTMLElement>(".ch") ?? [])];
    let current: HTMLElement | null = null;
    const activate = (ch: HTMLElement) => {
      chapters.forEach((c) => c.classList.toggle("on", c === ch));
      const t = ch.dataset.target ?? "core";
      loop.setTarget(t === "core" ? "core" : parseFloat(t));
      const no = ch.dataset.no ?? "";
      setCap({ name: ch.dataset.name ?? "", no: /^\d+$/.test(no) ? `${no} / 06` : no });
    };
    const spy = () => {
      if (!chapters.length) return;
      const mid = window.innerHeight / 2;
      let pick = chapters.find((c) => { const r = c.getBoundingClientRect(); return r.top <= mid && r.bottom > mid; }) ?? null;
      if (!pick) pick = chapters[0]!.getBoundingClientRect().top > mid ? chapters[0]! : chapters[chapters.length - 1]!;
      if (pick !== current) { current = pick; activate(pick); }
    };
    loop.setTarget("core");
    window.addEventListener("scroll", spy, { passive: true });
    window.addEventListener("resize", spy);
    spy();
    return () => { window.removeEventListener("scroll", spy); window.removeEventListener("resize", spy); loop.destroy(); };
  });
  return (
    <div className="story" ref={story}>
      <div className="pin" aria-hidden="true">
        <div className="pin-stage">
          <LoopBox id="pinLoop" className="loopbox v focusloop" onReady={ready} />
        </div>
        <div className="pin-cap"><span><b>{cap.name}</b></span><span dir="ltr">{cap.no}</span></div>
      </div>
      <div className="chapters">{children}</div>
    </div>
  );
}

/** A stage page's pinned loop, lit at that stage; a click on another stage opens its page. */
export function StageLoop({ labels, target, hrefs, name, no }: { labels: LoopLabels; target: number; hrefs: Record<string, string>; name: string; no: string }) {
  const [ready] = useState(() => (root: HTMLDivElement) => {
    const loop: LoopHandle = createLoop(root, { mode: "park", vertical: true, count: 1800, labels, onPick: (id: string) => { const h = hrefs[id]; if (h) window.location.href = h; } });
    loop.setTarget(target);
    return () => loop.destroy();
  });
  return (
    <div className="pin" aria-hidden="true">
      <div className="pin-stage">
        <LoopBox id="hubLoop" className="loopbox v focusloop" onReady={ready} />
      </div>
      <div className="pin-cap"><span><b>{name}</b></span><span dir="ltr">{no}</span></div>
    </div>
  );
}
