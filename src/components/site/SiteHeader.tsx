"use client";

import { Fragment, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ARROW, CHEVRON as CHEV } from "./icons";

export interface MenuStage {
  name: string;
  href: string;
  color: string;
  features: { name: string; tag: string; href: string }[];
}

export interface HeaderProps {
  homeHref: string;
  labels: {
    features: string; loop: string; developers: string; login: string; join: string; language: string;
    make: string; grow: string; seeItWork: string; featured: string; featuredBlurb: string; howItWorks: string;
  };
  make: MenuStage[];
  grow: MenuStage[];
  featuredHref: string;
  /** Other languages of this page; empty when the site is English only. */
  languages: { code: string; name: string; href: string; current: boolean }[];
}

/** The BBH-style nav block: Features (mega menu), The Loop, Developers, Log in, language, Join. */
export function SiteHeader(p: HeaderProps) {
  const [menu, setMenu] = useState(false);
  const [lang, setLang] = useState(false);
  const head = useRef<HTMLDivElement>(null);
  const trig = useRef<HTMLButtonElement>(null);
  const langTrig = useRef<HTMLButtonElement>(null);
  const openedAt = useRef(0);
  const closeT = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const openMenu = (open: boolean) => {
    setMenu(open);
    if (open) { openedAt.current = Date.now(); setLang(false); }
  };

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (head.current && !head.current.contains(e.target as Node)) { setMenu(false); setLang(false); }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setMenu((m) => { if (m) trig.current?.focus(); return false; });
      setLang((l) => { if (l) langTrig.current?.focus(); return false; });
    };
    document.addEventListener("click", onDoc);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("click", onDoc); document.removeEventListener("keydown", onKey); clearTimeout(closeT.current); };
  }, []);

  const hoverOpen = () => { clearTimeout(closeT.current); if (!menu) openMenu(true); };
  const hoverClose = () => { closeT.current = setTimeout(() => setMenu(false), 240); };
  const current = p.languages.find((l) => l.current);

  const column = (title: string, stages: MenuStage[]) => (
    <div className="mcol">
      <h4>{title}</h4>
      {stages.map((s) => (
        <Fragment key={s.href}>
          <a className="msub" href={s.href} style={{ "--c": s.color } as React.CSSProperties}>
            <i />{s.name}{ARROW}
          </a>
          {s.features.map((f) => (
            <a key={f.href} className="mitem" href={f.href}><b>{f.name}</b><span>{f.tag}</span></a>
          ))}
        </Fragment>
      ))}
    </div>
  );

  return (
    <div className="site-head" ref={head}>
      <nav className="navblock" aria-label="Main">
        <a className="mark" href={p.homeHref} aria-label="YouGrow home">
          <svg><use href="#loopmark" /></svg>
        </a>
        <div className="links">
          <button
            ref={trig}
            className="trig keep"
            type="button"
            aria-expanded={menu}
            aria-controls="featMenu"
            onClick={() => { if (menu && Date.now() - openedAt.current < 400) return; openMenu(!menu); }}
            onMouseEnter={hoverOpen}
            onMouseLeave={hoverClose}
          >
            {p.labels.features}{CHEV}
          </button>
          <a href={`${p.homeHref}#loop`}>{p.labels.loop}</a>
          <Link href="/developers">{p.labels.developers}</Link>
          <Link href="/login">{p.labels.login}</Link>
          {current ? (
            <button
              ref={langTrig}
              className="trig keep"
              type="button"
              aria-expanded={lang}
              aria-controls="langMenu"
              aria-label={p.labels.language}
              onClick={() => { setLang(!lang); setMenu(false); }}
            >
              <span id="langNow">{current.name}</span>{CHEV}
            </button>
          ) : null}
          <a className="keep" href={`${p.homeHref}#join`}>{p.labels.join}</a>
        </div>
        <a className="word" href={p.homeHref}>YOUGROW</a>
      </nav>
      <div className="menu" id="featMenu" hidden={!menu} onMouseEnter={() => clearTimeout(closeT.current)} onMouseLeave={hoverClose}
        onClick={(e) => { if ((e.target as HTMLElement).closest("a")) setMenu(false); }}>
        {column(p.labels.make, p.make)}
        {column(p.labels.grow, p.grow)}
        <a className="mfeat" href={p.featuredHref}>
          <div><span className="k">{p.labels.seeItWork}</span><h5>{p.labels.featured}</h5><p>{p.labels.featuredBlurb}</p></div>
          <span className="go">{p.labels.howItWorks} {ARROW}</span>
        </a>
      </div>
      {current ? (
        <div className="langmenu" id="langMenu" hidden={!lang} style={{ left: langLeft(langTrig.current, head.current) }}>
          {p.languages.map((l) => (
            <a key={l.code} href={l.href} hrefLang={l.code} lang={l.code} aria-current={l.current ? "true" : undefined}>
              {l.name}<span>{l.code}</span>
            </a>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function langLeft(trig: HTMLElement | null, head: HTMLElement | null): number | undefined {
  if (!trig || !head) return undefined;
  return trig.getBoundingClientRect().left - head.getBoundingClientRect().left;
}
