/**
 * The growth loop: particles streaming round a figure-eight (a lemniscate), with the
 * six stages as nodes, "growth memory" at the crossing, and a pulse that either laps
 * ("travel", the hero) or glides to the stage being read ("park", the pinned loops).
 * Plain JavaScript on purpose: it is a tight canvas loop over typed arrays.
 *
 * createLoop(root, options) draws into root's <canvas>, .corona, .eclipse and .overlay.
 *   options.mode      "travel" | "park"
 *   options.vertical  true for the upright loop; default: upright when narrower than 640px
 *   options.count     particle count
 *   options.labels    { stages: {id: name}, core: [line, ...], ghost: [make, grow], approve, back }
 *   options.onPick    called with a stage id when its node or label is clicked
 *   options.onLap     called with the lap number (travel)
 * Returns { setTarget(u | "core"), destroy() }.
 */

const TAU = Math.PI * 2, SY = 1.5, M = 2048, NB = 128, LAP_MS = 32000;
const STAGES = [
  { id: "understand", u: 0.125 },
  { id: "plan", u: 0.25 },
  { id: "create", u: 0.375 },
  { id: "launch", u: 0.625 },
  { id: "engage", u: 0.75 },
  { id: "learn", u: 0.875 },
];
const MAKE = [[0, "#ddd3ff"], [0.35, "#a78bfa"], [0.7, "#6f6cf4"], [1, "#3b82f6"]];
const GROW = [[0, "#b5f5fd"], [0.35, "#22d3ee"], [0.7, "#14b8a6"], [1, "#34d399"]];
const rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const ramp = (stops, t) => {
  for (let i = 1; i < stops.length; i++) if (t <= stops[i][0]) {
    const [p0, c0] = stops[i - 1], [p1, c1] = stops[i], f = (t - p0) / (p1 - p0), a = rgb(c0), b = rgb(c1);
    return a.map((v, j) => Math.round(v + (b[j] - v) * f));
  }
  return rgb(stops[stops.length - 1][1]);
};
const gauss = () => { let u = 0, v = 0; while (!u) u = Math.random(); while (!v) v = Math.random(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(TAU * v); };

export function createLoop(root, o) {
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const L = o.labels;
  const cv = root.querySelector("canvas"), ctx = cv.getContext("2d");
  const overlay = root.querySelector(".overlay"), eclipse = root.querySelector(".eclipse"), corona = root.querySelector(".corona");
  const PX = new Float32Array(M), PY = new Float32Array(M), NX = new Float32Array(M), NY = new Float32Array(M), BY = new Float32Array(M);
  let W, H, CX, CY, A, R0, vertical = null, scale = 1, maxBY, N = 0, SPR = [];
  let pu, sp, off, sz, al, ph, born, nodeEls = {}, lblEls = {}, gateEl = null, gateU = 0.55, xlEls = [];
  let pulse = o.mode === "park" ? 0.9 : 0.02, target = null, amp = 1, ampT = 1, lap = 1, flare = 0, time = 0, last = 0, running = false, dead = false;

  function geometry() {
    if (vertical) { W = 600; H = 1040; CX = 300; CY = 520; A = 390; R0 = 50; }
    else { W = 1200; H = 640; CX = 600; CY = 330; A = 440; R0 = 58; }
    maxBY = SY * A * 0.3536;
    const n = 6000, bx = new Float32Array(n + 1), by = new Float32Array(n + 1), cum = new Float32Array(n + 1);
    for (let i = 0; i <= n; i++) {
      const t = Math.PI / 2 + (TAU * i) / n, d = 1 + Math.sin(t) ** 2;
      bx[i] = (A * Math.cos(t)) / d; by[i] = (SY * A * Math.sin(t) * Math.cos(t)) / d;
      if (i) cum[i] = cum[i - 1] + Math.hypot(bx[i] - bx[i - 1], by[i] - by[i - 1]);
    }
    const len = cum[n];
    for (let k = 0, j = 0; k < M; k++) {
      const s = (k / M) * len;
      while (j < n - 1 && cum[j + 1] < s) j++;
      const f = (s - cum[j]) / (cum[j + 1] - cum[j] || 1), x = bx[j] + (bx[j + 1] - bx[j]) * f, y = by[j] + (by[j + 1] - by[j]) * f;
      BY[k] = y;
      if (vertical) { PX[k] = CX + y; PY[k] = CY + x; } else { PX[k] = CX + x; PY[k] = CY + y; }
    }
    for (let k = 0; k < M; k++) {
      const a = (k - 1 + M) % M, b = (k + 1) % M, tx = PX[b] - PX[a], ty = PY[b] - PY[a], l = Math.hypot(tx, ty) || 1;
      NX[k] = -ty / l; NY[k] = tx / l;
    }
  }
  const colorArr = (u) => { const k = (u * M) | 0, t = Math.min(1, Math.max(0, (BY[k] + maxBY) / (2 * maxBY))); return ramp(u < 0.5 ? MAKE : GROW, t); };
  const colorAt = (u) => `rgb(${colorArr(u)})`;
  function sprites() {
    SPR = [];
    for (let b = 0; b < NB; b++) {
      const c = colorArr((b + 0.5) / NB), w = c.map((v) => Math.round(v + (255 - v) * 0.65));
      const s = document.createElement("canvas"); s.width = s.height = 32;
      const g = s.getContext("2d"), gr = g.createRadialGradient(16, 16, 0, 16, 16, 16);
      gr.addColorStop(0, `rgba(${w},1)`); gr.addColorStop(0.2, `rgba(${c},0.9)`);
      gr.addColorStop(0.5, `rgba(${c},0.2)`); gr.addColorStop(1, `rgba(${c},0)`);
      g.fillStyle = gr; g.fillRect(0, 0, 32, 32); SPR.push(s);
    }
  }
  function particles() {
    N = o.count || (vertical ? 2000 : 3600);
    pu = new Float32Array(N); sp = new Float32Array(N); off = new Float32Array(N);
    sz = new Float32Array(N); al = new Float32Array(N); ph = new Float32Array(N); born = new Float32Array(N);
    const k = vertical ? 1.25 : 1, startShare = o.mode === "park" ? 0.8 : 0.45;
    for (let i = 0; i < N; i++) {
      const r = Math.random(); let sigma, a, s, v = 1;
      if (r < 0.55) { sigma = 4.5; a = 0.3 + 0.4 * Math.random(); s = 2.2 + 2.4 * Math.random(); }
      else if (r < 0.9) { sigma = 12; a = 0.16 + 0.28 * Math.random(); s = 2 + 3 * Math.random(); }
      else { sigma = 30; a = 0.07 + 0.16 * Math.random(); s = 1.6 + 2.6 * Math.random(); v = 0.85; }
      pu[i] = Math.random(); off[i] = gauss() * sigma * k; sz[i] = s * k; al[i] = a; ph[i] = Math.random() * TAU;
      sp[i] = (v * (0.88 + 0.24 * Math.random())) / LAP_MS;
      born[i] = i < N * startShare ? 1 : 0;
    }
  }
  const pct = (x, y) => `left:${((x / W) * 100).toFixed(3)}%;top:${((y / H) * 100).toFixed(3)}%;`;
  const el = (tag, cls, text) => { const e = document.createElement(tag); e.className = cls; if (text != null) e.textContent = text; return e; };
  function layout() {
    overlay.textContent = ""; nodeEls = {}; lblEls = {};
    const lobeC = (make) => vertical ? [CX, CY + (make ? -1 : 1) * A * 0.56] : [CX + (make ? -1 : 1) * A * 0.56, CY];
    if (!vertical) for (const [make, word, u] of [[true, L.ghost[0], 0.25], [false, L.ghost[1], 0.75]]) {
      const [x, y] = lobeC(make), e = el("span", "ghost", word);
      e.style.cssText = pct(x, y) + `--c:${colorAt(u)};--k:${Math.min(1, 5.4 / word.length).toFixed(3)}`; overlay.appendChild(e);
    }
    for (const s of STAGES) {
      const k = Math.round(s.u * M) % M, x = PX[k], y = PY[k], c = colorAt(s.u);
      const [lx, ly] = lobeC(s.u < 0.5);
      let dx = x - lx, dy = y - ly; const l = Math.hypot(dx, dy); dx /= l; dy /= l;
      if (vertical) { dx = -dx; dy = -dy; }
      const gap = vertical ? 26 : 30;
      const n = el("i", "node"); n.style.cssText = pct(x, y) + `--c:${c}`;
      const t = el("div", "lbl"); t.appendChild(el("b", "", L.stages[s.id]));
      t.style.cssText = pct(x + dx * gap, y + dy * gap) + `--c:${c};text-align:${dx < -0.5 ? "right" : dx > 0.5 ? "left" : "center"};` +
        `transform:translate(${(-50 + dx * 50).toFixed(1)}%,${(-50 + dy * 50).toFixed(1)}%)`;
      overlay.append(n, t); nodeEls[s.id] = n; lblEls[s.id] = t;
      if (o.onPick) for (const e of [n, t]) { e.classList.add("pick"); e.addEventListener("click", () => o.onPick(s.id)); }
    }
    let g = M / 2;
    while (Math.hypot(PX[g] - CX, PY[g] - CY) < R0 + 22) g++;
    const gate = el("i", "gate"); gate.style.cssText = pct(PX[g], PY[g]); overlay.appendChild(gate);
    gateEl = gate; gateU = g / M; xlEls = [];
    if (o.mode === "park") for (const [u, text] of [[gateU, L.approve], [0.955, L.back]]) {
      const k = Math.round(u * M) % M, x = PX[k], y = PY[k], left = x < CX;
      const e = el("span", "xl", text);
      e.style.cssText = pct(x, y) + `transform:translate(${left ? "calc(-100% - 16px)" : "16px"},-50%)`;
      overlay.appendChild(e); xlEls.push([u, e]);
    }
    const d = ((2 * R0) / W) * 100;
    eclipse.style.cssText = pct(CX, CY) + `width:${d}%;`;
    const core = el("span", "");
    L.core.forEach((line, i) => { if (i) core.appendChild(document.createElement("br")); core.appendChild(document.createTextNode(line)); });
    eclipse.textContent = ""; eclipse.appendChild(core);
    corona.style.cssText = pct(CX, CY) + `width:${d * 2.6}%;`;
  }
  const activeCount = () => reduce ? N : Math.min(N, Math.floor(N * ((o.mode === "park" ? 0.8 : 0.45) + 0.11 * (lap - 1))));
  function paint(dt) {
    const act = activeCount();
    for (let i = 0; i < N; i++) { const u = pu[i] + sp[i] * dt; pu[i] = u - Math.floor(u); if (born[i] < 1 && i < act) born[i] = Math.min(1, born[i] + dt / 2400); }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = "destination-out"; ctx.fillStyle = "rgba(0,0,0,0.2)"; ctx.fillRect(0, 0, cv.width, cv.height);
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    ctx.globalCompositeOperation = "lighter";
    for (let i = 0; i < act; i++) {
      const u = pu[i], k = (u * M) | 0, oo = off[i] * (1 + 0.2 * Math.sin(time * 0.0005 + ph[i]));
      let du = Math.abs(u - pulse); if (du > 0.5) du = 1 - du;
      const boost = reduce ? 1 : 1 + 2.4 * amp * Math.exp(-(du * du) / 0.0016);
      const focus = o.mode === "park" ? amp * (1 - 0.76 * (1 - Math.exp(-(du * du) / 0.006))) + (1 - amp) * 0.45 : 1;
      ctx.globalAlpha = Math.min(1, al[i] * boost * focus * (reduce ? 1 : born[i]));
      const s = sz[i];
      ctx.drawImage(SPR[(u * NB) | 0], PX[k] + NX[k] * oo - s, PY[k] + NY[k] * oo - s, s * 2, s * 2);
    }
    ctx.globalAlpha = 1;
  }
  function light() {
    for (const s of STAGES) {
      let du = Math.abs(pulse - s.u); if (du > 0.5) du = 1 - du;
      const on = amp > 0.5 && du < 0.045;
      nodeEls[s.id].classList.toggle("lit", on); lblEls[s.id].classList.toggle("lit", on);
    }
    corona.style.opacity = (0.45 + 0.55 * flare).toFixed(3);
    if (o.mode === "park") {
      const near = (u, w) => { let d = Math.abs(pulse - u); if (d > 0.5) d = 1 - d; return amp > 0.5 && d < w; };
      for (const [u, e] of xlEls) e.classList.toggle("lit", near(u, 0.03));
      if (gateEl) gateEl.classList.toggle("lit", near(gateU, 0.03));
      root.classList.toggle("core-on", amp < 0.3);
    }
  }
  function step(dt) {
    if (o.mode === "travel") {
      pulse += dt / LAP_MS;
      if (pulse >= 1) { pulse -= 1; lap++; flare = 1; if (o.onLap) o.onLap(lap); }
      flare = Math.max(0, flare - dt / 3000);
    } else {
      if (target !== null) { let d = target - pulse; d -= Math.round(d); pulse = (pulse + Math.sign(d) * Math.min(Math.abs(d), dt / 2600) + 1) % 1; }
      amp += (ampT - amp) * Math.min(1, dt / 500);
      flare += ((ampT === 0 ? 1 : 0) - flare) * Math.min(1, dt / 600);
    }
  }
  function warm() {
    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, cv.width, cv.height);
    for (let f = 0; f < 24; f++) { time += 16; paint(16); }
    light();
  }
  // Fit the core label inside the circle, and keep the two labels that face each other across a lobe apart.
  function coreFit() {
    eclipse.style.fontSize = Math.max(9, (vertical ? 15 : 12.5) * (root.clientWidth / W)) + "px";
    const span = eclipse.firstElementChild, room = eclipse.clientWidth * 0.84;
    if (span && span.offsetWidth > room) eclipse.style.fontSize = Math.max(6, parseFloat(eclipse.style.fontSize) * room / span.offsetWidth) + "px";
    root.style.removeProperty("--lk");
    if (!vertical) return;
    let k = 1;
    for (const [a, b] of [["understand", "create"], ["launch", "learn"]]) {
      const la = lblEls[a], lb = lblEls[b]; if (!la || !lb) continue;
      const ra = la.getBoundingClientRect(), rb = lb.getBoundingClientRect();
      const span2 = Math.max(ra.right, rb.right) - Math.min(ra.left, rb.left), need = Math.max(ra.width, rb.width) * 1.16 + Math.min(ra.width, rb.width) + 12;
      if (need > span2) k = Math.min(k, span2 / need);
    }
    if (k < 1) root.style.setProperty("--lk", Math.max(0.6, k).toFixed(3));
  }
  function size() {
    const w = root.clientWidth; if (!w || dead) return;
    const v = o.vertical ?? w < 640;
    if (v !== vertical) { vertical = v; root.classList.toggle("v", v); geometry(); sprites(); particles(); layout(); }
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    cv.width = Math.round(root.clientWidth * dpr); cv.height = Math.round(root.clientHeight * dpr);
    scale = (root.clientWidth / W) * dpr;
    coreFit();
    warm();
  }
  function tick(now) {
    if (!running || dead) return;
    // A loop created while its page is hidden has no layout yet; do not let a frame run without one.
    if (vertical === null) { size(); if (vertical === null) { requestAnimationFrame(tick); return; } }
    const dt = last ? Math.min(50, now - last) : 16; last = now; time += dt;
    step(dt); paint(dt); light();
    requestAnimationFrame(tick);
  }
  size();
  let rz;
  const ro = new ResizeObserver(() => { clearTimeout(rz); rz = setTimeout(size, 120); });
  ro.observe(root);
  let io = null;
  if (!reduce) {
    io = new IntersectionObserver((es) => {
      const vis = es[0].isIntersecting;
      if (vis && !running) { running = true; last = 0; requestAnimationFrame(tick); }
      if (!vis) running = false;
    });
    io.observe(root);
  }
  return {
    setTarget(t) {
      if (t === "core") { ampT = 0; } else { ampT = 1; target = t; }
      if (reduce || !running) { if (t !== "core") pulse = t; amp = ampT; flare = ampT === 0 ? 1 : 0; if (Object.keys(nodeEls).length) warm(); }
    },
    destroy() {
      dead = true; running = false; clearTimeout(rz); ro.disconnect(); if (io) io.disconnect();
    },
  };
}
