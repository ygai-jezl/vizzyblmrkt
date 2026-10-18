/**
 * The five-step feature walkthrough: progress-bar tabs over an auto-playing product
 * mock. Each scene is a pure function of time within its step, driven by attributes
 * in the scene's HTML:
 *   data-at="s" / data-in="s"   add .in from s seconds
 *   data-done="s"               add .done from s seconds
 *   data-press="s"              .press for 0.35s from s, then .pressed
 *   data-type="s,d" data-text   type the text over d seconds from s
 *   data-count="from,to,s0,s1[,decimals]" (+ data-suffix)  count up between s0 and s1
 *   data-tally="selector"       show how many matching elements in the scene are done
 * Works on markup the server already rendered (step 1 showing), so the copy is in
 * the page for readers and crawlers before any script runs.
 *
 * createWalkthrough(root, config) → destroy()
 *   config.steps        [{ dur, head }] (see FeatureStep in src/lib/site/content.ts)
 *   config.named / config.placeholder   the mock's title once named / before
 *   config.stepText     ["Step 1 of 5", ...], already translated
 *   config.labels       { pause, play, next }, already translated
 */

const PAUSE = '<svg viewBox="0 0 12 12" fill="currentColor"><rect x="2" y="1.5" width="2.6" height="9"/><rect x="7.4" y="1.5" width="2.6" height="9"/></svg>';
const PLAY = '<svg viewBox="0 0 12 12" fill="currentColor"><path d="M3 1.5v9l7.5-4.5Z"/></svg>';
const NEXT = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M3 8h10M9 4l4 4-4 4"/></svg>';
const clamp01 = (x) => Math.max(0, Math.min(1, x));
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;");

export function createWalkthrough(root, cfg) {
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const q = (s) => root.querySelector(s);
  const qa = (s, from = root) => [...from.querySelectorAll(s)];
  const steps = cfg.steps, n = steps.length;
  const tabs = qa(".tab"), copies = qa(".p-copy"), scenes = qa(".scene");
  const panel = q(".panel"), stepEl = q(".p-step"), playBtn = q(".pp");
  const pill = q(".pill"), idea = q(".idea-t"), pipe = q(".pipe"), pipeLis = qa(".pipe li");
  const parts = scenes.map((sc) => ({
    at: qa("[data-at]", sc), inn: qa("[data-in]", sc), done: qa("[data-done]", sc), press: qa("[data-press]", sc),
    type: qa("[data-type]", sc), count: qa("[data-count]", sc), tally: qa("[data-tally]", sc),
  }));
  const P = { cur: 0, t: 0, playing: !reduce, onScreen: false, last: 0, raf: 0 };

  function applyScene(k, t) {
    const p = parts[k], s = t / 1000;
    for (const el of p.at) el.classList.toggle("in", s >= +el.dataset.at);
    for (const el of p.inn) el.classList.toggle("in", s >= +el.dataset.in);
    for (const el of p.done) el.classList.toggle("done", s >= +el.dataset.done);
    for (const el of p.press) { const a = +el.dataset.press; el.classList.toggle("press", s >= a && s < a + 0.35); el.classList.toggle("pressed", s >= a); }
    for (const el of p.type) {
      const [a, d] = el.dataset.type.split(",").map(Number), full = el.dataset.text.replace(/\\n/g, "\n");
      const f = clamp01((s - a) / d), txt = full.slice(0, Math.round(full.length * f));
      if (el._t !== txt) { el._t = txt; el.textContent = txt; }
      el.classList.toggle("typing", f > 0 && f < 1);
    }
    for (const el of p.count) {
      const [a, b, s0, s1, dec] = el.dataset.count.split(",").map(Number), f = clamp01((s - s0) / (s1 - s0));
      const v = a + (b - a) * (1 - (1 - f) * (1 - f)), txt = dec ? v.toFixed(dec) : Math.round(v).toLocaleString("en-GB");
      if (el._v !== txt) { el._v = txt; el.textContent = txt + (el.dataset.suffix || ""); }
    }
    for (const el of p.tally) { const c = String(scenes[k].querySelectorAll(el.dataset.tally).length); if (el.textContent !== c) el.textContent = c; }
  }
  function applyHead(k, t) {
    const s = t / 1000; let st = steps[k].head[0];
    for (const h of steps[k].head) if (s >= h[0]) st = h;
    const [, label, tone, dots, named] = st;
    if (pill.textContent !== label) { pill.textContent = label; pill.dataset.t = tone; }
    const title = named ? cfg.named : cfg.placeholder;
    if (idea.textContent !== title) { idea.textContent = title; idea.classList.toggle("ph", !named); }
    pipeLis.forEach((li, i) => li.classList.toggle("on", i < dots));
    pipe.style.setProperty("--fill", dots > 1 ? (dots - 1) / (pipeLis.length - 1) : 0);
  }
  function render() {
    applyScene(P.cur, P.t); applyHead(P.cur, P.t);
    const d = steps[P.cur].dur;
    tabs.forEach((b, i) => { b.querySelector(".bar i").style.width = (i < P.cur ? 100 : i > P.cur ? 0 : (P.t / d) * 100) + "%"; });
  }
  function go(k) {
    P.cur = k; P.t = reduce ? steps[k].dur : 0;
    scenes.forEach((sc, i) => sc.classList.toggle("active", i === k));
    copies.forEach((c, i) => { c.hidden = i !== k; });
    tabs.forEach((b, i) => { b.setAttribute("aria-selected", String(i === k)); b.tabIndex = i === k ? 0 : -1; });
    stepEl.textContent = cfg.stepText[k];
    panel.setAttribute("aria-labelledby", tabs[k].id);
    render(); kick();
  }
  function frame(now) {
    P.raf = 0;
    if (!(P.playing && P.onScreen)) { P.last = 0; return; }
    const dt = P.last ? Math.min(60, now - P.last) : 16; P.last = now; P.t += dt;
    if (P.t >= steps[P.cur].dur) { go((P.cur + 1) % n); return; }
    render(); P.raf = requestAnimationFrame(frame);
  }
  function kick() { if (!P.raf && P.playing && P.onScreen) { P.last = 0; P.raf = requestAnimationFrame(frame); } }
  function setPlaying(p) {
    P.playing = p;
    playBtn.innerHTML = reduce ? esc(cfg.labels.next) + " " + NEXT : p ? PAUSE + esc(cfg.labels.pause) : PLAY + esc(cfg.labels.play);
    kick();
  }

  const onTab = (e) => { const b = e.target.closest(".tab"); if (b) go(tabs.indexOf(b)); };
  const onKey = (e) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    e.preventDefault();
    const fwd = (e.key === "ArrowRight") !== (getComputedStyle(root).direction === "rtl");
    const k = (P.cur + (fwd ? 1 : n - 1)) % n; go(k); tabs[k].focus();
  };
  const onPlay = () => { if (reduce) go((P.cur + 1) % n); else setPlaying(!P.playing); };
  const tablist = q(".tabs");
  tablist.addEventListener("click", onTab);
  tablist.addEventListener("keydown", onKey);
  playBtn.addEventListener("click", onPlay);
  const io = new IntersectionObserver((es) => { P.onScreen = es[0].isIntersecting; kick(); }, { threshold: 0.25 });
  io.observe(panel);
  setPlaying(P.playing); go(0);

  return () => {
    if (P.raf) cancelAnimationFrame(P.raf);
    P.playing = false; io.disconnect();
    tablist.removeEventListener("click", onTab); tablist.removeEventListener("keydown", onKey); playBtn.removeEventListener("click", onPlay);
  };
}
