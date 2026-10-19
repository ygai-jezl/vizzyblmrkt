import { Fragment, type CSSProperties } from "react";
import Script from "next/script";
import {
  FEATURES, FEATURE_TAGS, STAGES, STAGE_IDS, nearFeature, nearStage, stageOf,
  type FeatureSlug, type StageId,
} from "@/lib/site/content";
import { siteOrigin } from "@/lib/site/flags";
import { CHAPTERS, FAQ, HERO_LABEL } from "@/lib/site/home";
import { translator, type Translator } from "@/lib/site/i18n";
import { sitePath, type SiteLang } from "@/lib/site/langs";
import { ARROW, ARROW_BACK } from "./icons";
import { HeroLoop, LoopStory, StageLoop } from "./Loops";
import { SiteShell, loopLabels } from "./SiteShell";
import { StackSection } from "./StackSection";
import { Walkthrough } from "./Walkthrough";

const cssVars = (vars: Record<string, string>) => vars as CSSProperties;

/** A "|"-split headline: line breaks, the last line in the gradient. */
function Lines({ parts, spans }: { parts: string[]; spans?: boolean }) {
  const last = parts.length - 1;
  return (
    <>
      {parts.map((x, i) =>
        i === last ? <span key={i} className="grad">{x}</span>
        : spans ? <span key={i}>{x}</span>
        : <Fragment key={i}>{x}<br /></Fragment>,
      )}
    </>
  );
}

/** The bar under the header on stage and feature pages: six stages, the features of this one. */
function StageBar({ lang, stage, feature }: { lang: SiteLang; stage: StageId; feature?: FeatureSlug }) {
  const { t, fmt } = translator(lang);
  const p = nearStage(stage, -1), n = nearStage(stage, 1), st = STAGES[stage];
  const href = (id: StageId) => sitePath(lang, { kind: "stage", id });
  return (
    <>
      <div className="topzone" />
      <nav className="stagebar" aria-label={t("The agentic growth loop")}>
        <div className="sb-row">
          <a className="sb-arrow" href={href(p)} aria-label={fmt("Previous stage: {name}", { name: t(STAGES[p].name) })}>{ARROW_BACK}</a>
          {STAGE_IDS.map((id, k) => (
            <a
              key={id}
              className={`sb-stage${k === 2 ? " gate-after" : ""}${feature && id === stage ? " within" : ""}`}
              href={href(id)}
              style={cssVars({ "--c": STAGES[id].color })}
              aria-current={id === stage ? (feature ? "true" : "page") : undefined}
            >
              <span className="n">{STAGES[id].no}</span><i /><span className="lab">{t(STAGES[id].name)}</span>
            </a>
          ))}
          <a className="sb-arrow" href={href(n)} aria-label={fmt("Next stage: {name}", { name: t(STAGES[n].name) })}>{ARROW}</a>
        </div>
        <div className="sb-sub">
          <span className="k">{fmt("In {stage}", { stage: t(st.name) })}</span>
          {st.features.map((f) => (
            <a key={f} href={sitePath(lang, { kind: "feature", slug: f })} style={cssVars({ "--c": st.color })} aria-current={f === feature ? "page" : undefined}>
              {t(FEATURES[f].name)}
            </a>
          ))}
        </div>
      </nav>
    </>
  );
}

function JoinButton({ lang, t }: { lang: SiteLang; t: Translator["t"] }) {
  return <a className="btn" href={`${sitePath(lang, { kind: "home" })}#join`}>{t("Join the waitlist")} {ARROW}</a>;
}

// ── Home ────────────────────────────────────────────────────────────────

export function HomeView({ lang }: { lang: SiteLang }) {
  const { t, lines } = translator(lang);
  const labels = loopLabels(t);
  const core = CHAPTERS[0]!;
  return (
    <SiteShell lang={lang} page={{ kind: "home" }} withFaq>
      <HeroLoop labels={labels} label={t(HERO_LABEL)} lapText={t("The agentic growth loop · lap")} approveText={t("You approve what ships")} />
      <main id="top">
        <section className="manifesto" aria-label={t("Agentic Growth Loop")}>
          <h1><Lines parts={lines("Growth|that|compounds")} spans /></h1>
        </section>

        <section className="sec" id="loop">
          <div className="sec-head"><h2>{t("The Loop")}</h2><span className="aside">{t("Six stages, one memory")}</span></div>
          <p className="lede"><b>{t("Six stages. One shared memory.")}</b> {t("Agents do the work at every stage, and what they learn goes back into the middle, so every lap starts ahead of the last.")}</p>
          <LoopStory labels={labels} first={{ name: core.kind === "core" ? t(core.name) : "", no: "00" }}>
            {CHAPTERS.map((ch) => {
              if (ch.kind === "core") {
                return (
                  <article key="core" className="ch" data-target="core" data-name={t(ch.name)} data-no={ch.no} style={cssVars({ "--c": ch.color })}>
                    <div className="ch-k"><i />{t(ch.label)}</div>
                    <h3>{t(ch.title)}</h3>
                    <p>{t(ch.body)}</p>
                    <dl className="facts">
                      {ch.facts.map((f) => <div key={f.term}><dt>{t(f.term)}</dt><dd>{t(f.value)}</dd></div>)}
                    </dl>
                  </article>
                );
              }
              if (ch.kind === "cross") {
                return (
                  <article key={ch.name} className="ch cross" data-target={String(ch.target)} data-name={t(ch.name)} data-no={ch.no} style={cssVars({ "--c": "#ffffff" })}>
                    <div className="ch-k"><span className={`glyph ${ch.glyph}`} />{t(ch.label)}</div>
                    <h3>{t(ch.title)}</h3>
                    <p>{t(ch.body)}</p>
                    {ch.now && ch.next ? (
                      <div className="split">
                        <div className="now"><h4><i />{t("Already compounding")}</h4><ul>{ch.now.map((x) => <li key={x}>{t(x)}</li>)}</ul></div>
                        <div className="nxt"><h4><i />{t("Coming next")}</h4><ul>{ch.next.map((x) => <li key={x}>{t(x)}</li>)}</ul></div>
                      </div>
                    ) : null}
                  </article>
                );
              }
              const s = STAGES[ch.id];
              return (
                <article key={ch.id} id={`ch-${ch.id}`} className="ch" data-target={String(s.u)} data-stage={ch.id} data-name={t(s.name)} data-no={s.no} style={cssVars({ "--c": s.color })}>
                  <div className="ch-k"><i />{t(ch.label)}</div>
                  <h3>{t(s.name)}</h3>
                  <p>{t(ch.body)}</p>
                  <dl className="facts">
                    <div><dt>{t("Agent")}</dt><dd>{t(ch.agent)}</dd></div>
                    <div><dt>{t("Adds to memory")}</dt><dd>{t(ch.adds)}</dd></div>
                    <div>
                      <dt>{t("Today")}</dt>
                      <dd><span className={ch.status.text === "Partly live" ? "st part" : "st"}>{t(ch.status.text)}{ch.status.note ? <small>{t(ch.status.note)}</small> : null}</span></dd>
                    </div>
                  </dl>
                  <a className="explore" href={sitePath(lang, { kind: "stage", id: ch.id })}>{t(`Explore ${s.name}`)} {ARROW}</a>
                </article>
              );
            })}
          </LoopStory>
        </section>

        <StackSection t={t} />

        <section className="sec faq" id="questions">
          <div className="sec-head"><h2 className="md">{t("Questions")}</h2><span className="aside">{t("The short answers")}</span></div>
          <dl className="qa">
            {FAQ.map((e) => (
              <div key={e.q}>
                <dt>{t(e.q)}</dt>
                <dd>
                  {t(e.a)}
                  {e.link ? <> <a href={e.link.href}>{e.link.href.startsWith("http") ? e.link.label : t(e.link.label)}</a></> : null}
                </dd>
              </div>
            ))}
          </dl>
        </section>

        <section className="close" id="join">
          <h2><Lines parts={lines("Start your|first lap")} /></h2>
          <div className="joinbox">
            <div data-vizzybl-campaign="agentic-growth-loop" data-vizzybl-type="WIDGET_2" />
          </div>
        </section>
      </main>
      {/* Our own waitlist widget, loaded from the platform origin (see src/app/page.tsx for why it must be). */}
      <Script src={`${siteOrigin()}/embed.js`} strategy="afterInteractive" />
    </SiteShell>
  );
}

// ── Stage ───────────────────────────────────────────────────────────────

export function StageView({ lang, id }: { lang: SiteLang; id: StageId }) {
  const { t } = translator(lang);
  const s = STAGES[id], p = nearStage(id, -1), n = nearStage(id, 1);
  const href = (x: StageId) => sitePath(lang, { kind: "stage", id: x });
  const li = (a: string[]) => a.map((x) => <li key={x}>{t(x)}</li>);
  return (
    <SiteShell lang={lang} page={{ kind: "stage", id }} around={{ prev: href(p), next: href(n) }}>
      <StageBar lang={lang} stage={id} />
      <div className="stagehub">
        <StageLoop
          labels={loopLabels(t)}
          target={s.u}
          hrefs={Object.fromEntries(STAGE_IDS.map((x) => [x, href(x)]))}
          name={t(s.name)}
          no={`${s.no} / 06`}
        />
        <div className="hub-body">
          <div style={cssVars({ "--c": s.color })}>
            <div className="ch-k"><i style={{ boxShadow: `0 0 0 5px color-mix(in srgb, ${s.color} 25%, transparent), 0 0 18px ${s.color}` }} />{s.no} · {t(s.half)}</div>
            <h1 className="hub-h">{t(s.name)}</h1>
            <p className="hub-promise">{t(s.promise)}</p>
            <p className="hub-p">{t(s.body)}</p>
            <div className="io">
              <div><h2 className="hub-k">{t("Reads from memory")}</h2><ul>{li(s.reads)}</ul></div>
              <span className="arr" aria-hidden="true">{ARROW}</span>
              <div><h2 className="hub-k">{t("Adds to memory")}</h2><ul>{li(s.writes)}</ul></div>
            </div>
            <dl className="facts">
              <div><dt>{t("Who does the work")}</dt><dd>{t(s.who)}</dd></div>
              <div><dt>{t("Where you decide")}</dt><dd>{t(s.decide)}</dd></div>
            </dl>
            <div className="hub-sec">
              <h2 className="hub-k">{t(s.features.length > 1 ? "Features in this stage" : "The feature in this stage")}</h2>
              <div className="fcards">
                {s.features.map((f) => (
                  <a key={f} className="fcard" href={sitePath(lang, { kind: "feature", slug: f })}>
                    <div><b>{t(FEATURES[f].name)}</b><span>{t(FEATURE_TAGS[f])}</span></div>
                    <em>{t("See how it works")} {ARROW}</em>
                  </a>
                ))}
              </div>
            </div>
            <div className="hub-sec split">
              <div className="now"><h4><i />{t("Live today")}</h4><ul>{li(s.live)}</ul></div>
              <div className="nxt"><h4><i />{t("Coming next")}</h4><ul>{li(s.next)}</ul></div>
            </div>
          </div>
          <nav className="fnext" aria-label={t("The Loop")}>
            <a href={href(p)}><span>{t("← Previous stage")}</span><b>{t(STAGES[p].name)}</b></a>
            <a href={href(n)}><span>{t("Next stage →")}</span><b>{t(STAGES[n].name)}</b></a>
          </nav>
        </div>
      </div>
    </SiteShell>
  );
}

// ── Feature ─────────────────────────────────────────────────────────────

export function FeatureView({ lang, slug }: { lang: SiteLang; slug: FeatureSlug }) {
  const { t, fmt, lines } = translator(lang);
  const f = FEATURES[slug], st = stageOf(slug), prev = nearFeature(slug, -1), next = nearFeature(slug, 1);
  const fhref = (x: FeatureSlug) => sitePath(lang, { kind: "feature", slug: x });
  return (
    <SiteShell lang={lang} page={{ kind: "feature", slug }}>
      <StageBar lang={lang} stage={st} feature={slug} />
      <section className="fhero" style={cssVars({ "--fc": f.color })}>
        <p className="fk"><a href={sitePath(lang, { kind: "stage", id: st })}>{t(STAGES[st].name)}</a><span className="sep">›</span>{t(f.name)}</p>
        <h1><Lines parts={lines(f.h1)} /></h1>
        <p className="fsub">{t(f.sub)}</p>
      </section>
      <section className="sec" id="how">
        <div className="sec-head"><h2 className="md">{t("How it works")}</h2><span className="aside">{t(f.aside)}</span></div>
        <Walkthrough
          ariaLabel={fmt("How {name} works", { name: t(f.name) })}
          steps={f.steps.map((s) => ({ tab: t(s.tab), title: t(s.title), desc: t(s.desc), dur: s.dur, head: s.head, scene: s.scene }))}
          obj={f.obj}
          pipe={f.pipe}
          stepText={f.steps.map((_, k) => fmt("Step {n} of {m}", { n: k + 1, m: f.steps.length }))}
          labels={{ pause: t("Pause"), play: t("Play"), next: t("Next step"), workspace: t("Your workspace") }}
        />
      </section>
      <nav className="fnext" aria-label={t("Features")}>
        <a href={fhref(prev)}><span>{t("← Previous")}</span><b>{t(FEATURES[prev].name)}</b></a>
        <a href={fhref(next)}><span>{t("Next →")}</span><b>{t(FEATURES[next].name)}</b></a>
      </nav>
      <section className="close">
        <h2><Lines parts={lines(f.close)} /></h2>
        <JoinButton lang={lang} t={t} />
      </section>
    </SiteShell>
  );
}
