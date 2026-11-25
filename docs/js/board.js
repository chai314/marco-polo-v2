// The Galton board: every ball is one simulated price path from the engine. Time runs down, price runs across (log scale).
// Balls fall along their real paths, land in a heap at their final price, and a gauge strip compares the running estimate with the true price.
// Layers, back to front: a 2D canvas (pins, payoff tint, the heap), an SVG overlay (lines, labels, trails, gauge), a ball canvas (WebGL2 points, or 2D).
"use strict";

const Board = (() => {
  const NP = 2048, FONT = 'Heros, "Helvetica Neue", Helvetica, Arial, sans-serif', NS = "http://www.w3.org/2000/svg";
  const INK = "#14171a", PALE = "#b9bfc6", MUTE = "#5f666f", PIN = "#d3d7dc", RULE = "#c9ced4", GHOST = "#8a9097";
  const BLUE = "#1657c9", GREEN = "#10936a", GREEN_D = "#0b6b4d", ORANGE = "#ec6a00", ORANGE_D = "#b34e00", VIOLET = "#a8328f", RED = "#bf3a2f", YELLOW = "#f2c200";
  const rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
  const C = { ink: rgb(INK), pale: rgb(PALE), blue: rgb(BLUE), red: rgb(RED), violet: rgb(VIOLET), ghost: rgb("#9aa0a7") };
  const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const isFlat = (p) => p === "european" || p === "merton";
  const fmtN = (n) => Math.round(n).toLocaleString("en");
  const fmtP = (x) => (Number.isInteger(x) ? String(x) : x.toFixed(2).replace(/0$/, ""));
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const nice = (x) => { const p = 10 ** Math.floor(Math.log10(x)), m = x / p; return (m > 5 ? 10 : m > 2 ? 5 : m > 1 ? 2 : 1) * p; };
  const ticks = (lo, hi, n) => { const s = nice((hi - lo) / n), out = []; for (let v = Math.ceil(lo / s - 1e-9) * s; v <= hi + s * 1e-6; v += s) out.push(Math.abs(v) < s * 1e-9 ? 0 : v); return { vals: out, step: s }; };
  const decimals = (step) => Math.max(0, Math.min(8, -Math.floor(Math.log10(step) + 1e-9)));
  const zOf = (p) => { const t = Math.sqrt(-2 * Math.log(Math.min(p, 1 - p))), v = t - (2.515517 + 0.802853 * t + 0.010328 * t * t) / (1 + 1.432788 * t + 0.189269 * t * t + 0.001308 * t ** 3); return p < 0.5 ? -v : v; };
  const mulberry = (a) => () => { a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const el = (name, attrs) => { const e = document.createElementNS(NS, name); for (const k in attrs) e.setAttribute(k, attrs[k]); return e; };

  const VS = `#version 300 es
  precision highp float;
  layout(location=0) in vec2 a_pos; layout(location=1) in float a_size; layout(location=2) in vec4 a_col; layout(location=3) in float a_ring;
  uniform vec2 u_res; uniform float u_dpr; out vec4 v_col; out float v_size; out float v_ring;
  void main(){ gl_Position = vec4(a_pos.x / u_res.x * 2.0 - 1.0, 1.0 - a_pos.y / u_res.y * 2.0, 0.0, 1.0); gl_PointSize = a_size * u_dpr; v_col = a_col; v_size = a_size; v_ring = a_ring; }`;
  const FS = `#version 300 es
  precision highp float; in vec4 v_col; in float v_size; in float v_ring; uniform float u_dpr; uniform float u_ring; out vec4 o;
  void main(){
    float R = v_size * 0.5 - 0.75, d = length(gl_PointCoord - 0.5) * v_size;
    float outer = clamp((R - d) * u_dpr + 0.5, 0.0, 1.0);
    float inner = v_ring > 0.5 ? clamp((d - (R - u_ring)) * u_dpr + 0.5, 0.0, 1.0) : 1.0;
    float a = v_col.a * outer * inner; if (a <= 0.0) discard; o = vec4(v_col.rgb * a, a);
  }`;

  // ---------------------------------------------------------------- paths from the engine (the same random model as the Paths view)
  async function simulate(spec, sel, seed) {
    const m = isFlat(spec.product) ? 64 : Math.min(64, spec.m), anti = Boolean(sel & 1), half = anti ? NP / 2 : NP, strat = Boolean(sel & 4) && spec.product !== "american";
    const [z, u, jn, pol] = await Promise.all([
      Engine.call("normals", { seed, n: half * m }), Engine.call("normals", { seed: seed + 1, n: NP, uniform: true }),
      spec.lam ? Engine.call("normals", { seed: seed + 2, n: 2 * NP * m }) : null,
      spec.product === "american" ? Engine.call("policy", { spec }) : null]);
    if (strat) {
      const xi = await Engine.call("impliedNormals", { u: Array.from({ length: half }, (_, i) => ((i + u[i]) / half) * (anti ? 0.5 : 1)) }), a = 1 / Math.sqrt(m);
      for (let i = 0; i < half; i++) { let t = 0; for (let j = 0; j < m; j++) t += z[i * m + j]; const lift = a * (xi[i] - a * t); for (let j = 0; j < m; j++) z[i * m + j] += lift; }
    }
    return { z, jn, pol, m, anti, half, strat };
  }
  function develop(spec, raw) { // log(S/S0) for every path
    const { z, jn, m, half } = raw, dt = spec.T / m, sd = spec.sigma * Math.sqrt(dt), k = spec.lam ? Math.exp(spec.muJ + spec.delta ** 2 / 2) - 1 : 0;
    const drift = (spec.r - spec.q - spec.sigma ** 2 / 2 - (spec.lam || 0) * k) * dt, X = new Float32Array(NP * (m + 1)), cut = spec.lam ? spec.lam * dt : 0, thr = cut ? zOf(1 - cut) : 9;
    const jumps = spec.lam ? new Uint8Array(NP * m) : null;
    for (let i = 0; i < NP; i++) {
      const src = i < half ? i : i - half, sg = i < half ? 1 : -1;
      let x = 0;
      for (let j = 0; j < m; j++) {
        x += drift + sd * sg * z[src * m + j];
        if (cut && jn[2 * (i * m + j)] > thr) { x += spec.muJ + spec.delta * jn[2 * (i * m + j) + 1]; jumps[i * m + j] = 1; }
        X[i * (m + 1) + j + 1] = x;
      }
    }
    return { X, jumps };
  }
  // What happens to each path: where it stops, what it pays, how it is heaped.
  async function makeBatch(cfg, seed) {
    const { spec, sel } = cfg, raw = await simulate(spec, sel, seed), { X, jumps } = develop(spec, raw), { m, pol } = raw;
    const S0 = spec.S0, K = spec.K, call = spec.call, bar = spec.product === "barrier", asian = spec.product === "asian", us = spec.product === "american";
    const bridge = bar && spec.mode === "bridge" && Boolean(sel & 8), lh = bar ? Math.log(spec.H / S0) : 0;
    const end = new Float32Array(NP), heap = new Float32Array(NP), pay = new Float32Array(NP), gStop = new Float32Array(NP).fill(1), stopLn = new Float32Array(NP), alpha = new Float32Array(NP).fill(1), fate = new Uint8Array(NP), avgLn = new Float32Array(NP);
    const nPol = pol ? pol.length / 4 : 0, vanilla = (v) => (call ? Math.max(v - K, 0) : Math.max(K - v, 0)), dt = spec.T / m;
    for (let i = 0; i < NP; i++) {
      const o = i * (m + 1);
      let avg = 0, hit = 0, ex = 0;
      for (let j = 1; j <= m; j++) {
        const s = S0 * Math.exp(X[o + j]);
        avg += s;
        if (bar && !hit && (spec.down ? s <= spec.H : s >= spec.H)) hit = j;
        if (pol && j < m && !ex) { const x = s / K, q = 4 * clamp(Math.round((j * (nPol + 1)) / m) - 1, 0, nPol - 1); if (x < 1 && 1 - x > pol[q] + x * (pol[q + 1] + x * (pol[q + 2] + x * pol[q + 3]))) ex = j; }
      }
      const sT = S0 * Math.exp(X[o + m]);
      end[i] = X[o + m]; avgLn[i] = Math.log(avg / m / S0);
      heap[i] = asian ? avgLn[i] : X[o + m];
      stopLn[i] = X[o + m];
      const v = asian ? avg / m : sT;
      pay[i] = vanilla(v);
      if (bar) {
        if (bridge) {
          let alive = 1;
          for (let j = 0; j < m; j++) {
            const a = spec.down ? X[o + j] - lh : lh - X[o + j], b = spec.down ? X[o + j + 1] - lh : lh - X[o + j + 1];
            alive *= a > 0 && b > 0 ? 1 - Math.exp((-2 * a * b) / (spec.sigma ** 2 * dt)) : 0;
          }
          alpha[i] = spec.knockIn ? 1 - alive : alive;
          pay[i] = vanilla(sT);
        } else {
          const live = Boolean(hit) === spec.knockIn;
          if (!live) pay[i] = 0;
          if (!spec.knockIn && hit) { fate[i] = 1; const xp = X[o + hit - 1], xc = X[o + hit]; gStop[i] = (hit - 1 + clamp((lh - xp) / (xc - xp || 1), 0, 1)) / m; stopLn[i] = lh; }
          else if (spec.knockIn && !hit) fate[i] = 3;
        }
      }
      if (us && ex) { fate[i] = 2; gStop[i] = ex / m; stopLn[i] = X[o + ex]; pay[i] = Math.max(K - S0 * Math.exp(X[o + ex]), 0); }
    }
    // balls drop in a shuffled order (pairs stay together with A), or stratified runs would fall lane by lane
    const half = raw.anti ? raw.half : NP, rng = mulberry((seed * 2654435761) >>> 0), idx = Array.from({ length: half }, (_, i) => i);
    for (let i = half - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [idx[i], idx[j]] = [idx[j], idx[i]]; }
    const order = new Int32Array(NP);
    idx.forEach((p, k) => { if (raw.anti) { order[2 * k] = p; order[2 * k + 1] = p + half; } else order[k] = p; });
    const sorted = Float32Array.from(end).sort();
    return { m, X, jumps, end, heap, pay, gStop, stopLn, alpha, fate, avgLn, order, pos: 0, sorted, anti: raw.anti, strat: raw.strat, half: raw.half, pol, seed };
  }

  // ---------------------------------------------------------------- the board
  function create(host, opts = {}) {
    opts = { gauge: true, ...opts };
    const dpr = () => Math.min(2, window.devicePixelRatio || 1);
    host.style.overflow = "hidden";
    const back = document.createElement("canvas"), svg = el("svg", { "aria-hidden": "true" }), front = document.createElement("canvas"), live = document.createElement("p");
    for (const c of [back, front]) { c.setAttribute("aria-hidden", "true"); c.style.cssText = "position:absolute;left:0;top:0;width:100%;height:100%;pointer-events:none;display:block"; }
    svg.style.cssText = "position:absolute;left:0;top:0;width:100%;height:100%;pointer-events:none;display:block;overflow:hidden";
    svg.setAttribute("font-family", FONT);
    live.setAttribute("aria-live", "polite");
    live.style.cssText = "position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0";
    host.append(back, svg, front, live);
    const bctx = back.getContext("2d");
    const wantGL = !new URLSearchParams(location.search).has("canvas");
    let gl = wantGL ? front.getContext("webgl2", { antialias: false, alpha: true, premultipliedAlpha: true }) : null, fctx = null, prog, vao, vbuf, loc = {};
    const initGL = () => {
      const sh = (k, src) => { const s = gl.createShader(k); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) console.error(gl.getShaderInfoLog(s)); return s; };
      prog = gl.createProgram(); gl.attachShader(prog, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FS)); gl.linkProgram(prog);
      for (const k of ["u_res", "u_dpr", "u_ring"]) loc[k] = gl.getUniformLocation(prog, k);
      vao = gl.createVertexArray(); vbuf = gl.createBuffer(); gl.bindVertexArray(vao); gl.bindBuffer(gl.ARRAY_BUFFER, vbuf);
      [[0, 2, 0], [1, 1, 2], [2, 4, 3], [3, 1, 7]].forEach(([i, n, off]) => { gl.enableVertexAttribArray(i); gl.vertexAttribPointer(i, n, gl.FLOAT, false, 32, off * 4); });
    };
    if (gl) { initGL(); front.addEventListener("webglcontextlost", (e) => e.preventDefault()); front.addEventListener("webglcontextrestored", () => { initGL(); kick(); }); } else fctx = front.getContext("2d");

    let S = null, L = null, W = 0, H = 0, destroyed = false, visible = true, raf = 0, last = 0, buf = new Float32Array(8 * 1024), R = {};
    const listeners = { land: [] };
    const G = { needle: NaN, trail: [], range: NaN, cmp: NaN, lastPx: NaN, hasNeedle: false };
    let trace = null, traceLabel = "", compare = null, cfg = null, key = "", lastAria = 0, ariaCount = -1, ariaDirty = false;
    const show = () => ({ pins: true, heap: true, gauge: true, trail: "auto", ...(cfg?.show || {}) });

    function fresh() {
      return { gen: (S?.gen || 0) + 1, cur: null, first: null, loading: null, batchNo: 0, scale: null, active: [], launchQ: [], qi: 0, clock: S?.clock || 0, count: 0, sums: { pay: 0, pay2: 0, st: 0, st2: 0 }, landed: { ln: [], cls: [], alpha: [], bin: [], slot: [], avg: [], twin: [] }, binCount: null, reserved: null, maxRes: 0, pitch: 0, trays: [0, 0, 0, 0], lanes: new Int32Array(32), dirty: true, drops: [], trails: [], routes: {}, chips: [], last: null, needleSettled: true, gaugeDirty: true };
    }
    S = fresh();

    // ------------------------------------------------------------ gadgets
    const flags = () => {
      const sp = cfg?.spec, sel = cfg?.sel || 0;
      if (!sp) return {};
      const f = { A: Boolean(sel & 1), C: Boolean(sel & 2), S: Boolean(sel & 4) && sp.product !== "american", K: Boolean(sel & 8) && (sp.product === "merton" || (sp.product === "barrier" && sp.mode === "bridge")) };
      f.ring = f.K && sp.product === "merton"; f.shade = f.K && sp.product === "barrier";
      f.kind = sp.product === "american" ? 2 : sp.product === "barrier" && !f.shade ? (sp.knockIn ? 3 : 1) : 0;
      return f;
    };

    // ------------------------------------------------------------ layout
    function scaleFor(b) {
      const sp = cfg.spec, marks = [sp.S0, sp.K].concat(sp.H || []);
      if (!b) { const w = 2.6 * sp.sigma * Math.sqrt(sp.T); return { lo: Math.min(sp.S0 * Math.exp(-w), ...marks.map((v) => v * 0.985)), hi: Math.max(sp.S0 * Math.exp(w), ...marks.map((v) => v * 1.015)) }; }
      return { lo: Math.min(sp.S0 * Math.exp(b.sorted[Math.floor(NP * 0.001)]), ...marks.map((v) => v * 0.985)), hi: Math.max(sp.S0 * Math.exp(b.sorted[Math.floor(NP * 0.999)]), ...marks.map((v) => v * 1.015)) };
    }
    function layout() {
      W = host.clientWidth; H = host.clientHeight;
      if (!W || !H) return;
      for (const c of [back, front]) { c.width = Math.round(W * dpr()); c.height = Math.round(H * dpr()); }
      svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
      if (!cfg) { L = null; paintBoard(); svg.innerHTML = ""; return; }
      const f = flags(), sp = cfg.spec, small = W < 560, r = small ? (f.ring ? 2.2 : 2.4) : 3, pad = small ? 14 : 22, x0 = pad, x1 = W - pad;
      const gh = opts.gauge && show().gauge !== false ? 104 + (f.C ? 30 : 0) : 0, below = 38 + (f.S ? 44 : 0);
      const floor = H - gh - (gh ? 8 : 0) - below, pinTop = 42;
      let heapH = Math.max(70, 0.38 * H), pinBot = floor - heapH - 20;
      if (pinBot - pinTop < 90) { heapH = Math.max(60, heapH - (90 - (pinBot - pinTop))); pinBot = floor - heapH - 20; }
      const sc = S.scale || scaleFor(null), lo = Math.log(sc.lo), hi = Math.log(sc.hi), bx = (x1 - x0) / (hi - lo), ax = x0 + (Math.log(sp.S0) - lo) * bx;
      const nb = Math.max(8, Math.floor((x1 - x0) / (2 * r))), m = S.cur?.m || (isFlat(sp.product) ? 64 : Math.min(64, sp.m));
      const xP = (p) => x0 + (Math.log(p) - lo) * bx;
      L = { gx0: x0 + Math.min(170, W * 0.38) + 14, W, H, small, r, x0, x1, floor, pinTop, pinBot, pinH: pinBot - pinTop, heapTop: pinBot + 20, heapH, nb, bw: (x1 - x0) / nb, ax, bx, lo, hi, m, xP, gy: H - 104 - 6, gh, below, f, xK: xP(sp.K), xS: xP(sp.S0), xH: sp.H ? xP(sp.H) : NaN };
      L.heapTop = pinBot + 20; L.heapH = floor - L.heapTop;
      // trays sit in the top corner of the heap, away from the barrier
      const side = f.kind === 2 ? "left" : sp.H ? (sp.H < sp.S0 ? "right" : "left") : "right";
      const tw = f.kind === 1 ? 70 : f.kind === 2 ? 88 : 100;
      L.tray = { w: tw, h: 40, x: side === "right" ? x1 - tw : x0, y: L.heapTop + 22, side };
      rebucket();
      build();
      S.dirty = true; S.gaugeDirty = true;
      kick();
    }
    const yAt = (j) => L.pinTop + (L.pinH * j) / L.m;
    const binOf = (xv) => clamp(Math.floor((xv - L.x0) / L.bw), 0, L.nb - 1);
    const inZone = (absV) => (cfg.spec.call ? absV > cfg.spec.K : absV < cfg.spec.K);
    const pitchFor = (mx) => (mx <= 1 ? 2 * L.r : Math.max(0.3, Math.min(2 * L.r, (L.floor - L.heapTop - 6 - 2 * L.r) / (mx - 1))));
    const slotY = (slot) => L.floor - 1 - L.r - slot * S.pitch;

    // heap values that are already landed move to the bins of the new layout
    function rebucket() {
      S.binCount = new Int32Array(L.nb); S.reserved = new Int32Array(L.nb); S.maxRes = 0;
      const d = S.landed;
      for (let i = 0; i < d.ln.length; i++) { const b = binOf(L.ax + L.bx * d.ln[i]); d.bin[i] = b; d.slot[i] = S.binCount[b]++; S.reserved[b]++; }
      for (let b = 0; b < L.nb; b++) S.maxRes = Math.max(S.maxRes, S.reserved[b]);
      S.pitch = pitchFor(S.maxRes);
    }

    // ------------------------------------------------------------ the static overlay
    function build() {
      const sp = cfg.spec, f = L.f, b = S.cur, T = (x, y, s, o = {}) => `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" font-size="${o.size || 12}" fill="${o.fill || MUTE}" text-anchor="${o.a || "start"}"${o.bold ? ' font-weight="700"' : ""} stroke="#fff" stroke-width="3" stroke-linejoin="round" paint-order="stroke">${esc(s)}</text>`;
      let s = "";
      // hopper
      const hx = clamp(L.xS, 14, W - 14);
      s += `<path d="M${hx - 7} 20 L${hx + 7} 20 L${hx} 34 Z" fill="${INK}"/>`;
      const hl = `today ${fmtP(sp.S0)}`;
      s += hx < 100 ? T(hx + 12, 31, hl, { fill: INK }) : T(hx - 11, 31, hl, { a: "end", fill: INK });
      // the heap floor and price ticks
      if (show().heap !== false) {
        s += `<line x1="${L.x0 - 6}" x2="${L.x1 + 6}" y1="${L.floor + 0.5}" y2="${L.floor + 0.5}" stroke="${INK}" stroke-width="1"/>`;
        const tk = ticks(Math.exp(L.lo), Math.exp(L.hi), Math.max(3, Math.round((L.x1 - L.x0) / 90))), dec = decimals(tk.step);
        for (const v of tk.vals) { const x = L.xP(v); if (x < L.x0 - 4 || x > L.x1 + 4) continue; s += `<line x1="${x.toFixed(1)}" x2="${x.toFixed(1)}" y1="${L.floor + 1}" y2="${L.floor + 5}" stroke="${PIN}" stroke-width="1"/>` + `<text x="${x.toFixed(1)}" y="${L.floor + 19}" font-size="11.5" fill="${MUTE}" text-anchor="middle">${esc(v.toLocaleString("en", { minimumFractionDigits: dec, maximumFractionDigits: dec }))}</text>`; }
        s += `<text data-r="count" x="${L.x1}" y="${L.heapTop - 5}" font-size="13" font-weight="700" fill="${INK}" text-anchor="end" style="font-variant-numeric:tabular-nums" stroke="#fff" stroke-width="3" paint-order="stroke" stroke-linejoin="round">0 balls</text>`;
        s += `<text x="${L.x1}" y="${L.floor + 34}" font-size="11" fill="${MUTE}" text-anchor="end">price on expiry day (log scale)</text>`;
        // strike and payoff zone label
        s += `<line x1="${L.xK.toFixed(1)}" x2="${L.xK.toFixed(1)}" y1="${L.heapTop}" y2="${L.floor}" stroke="${INK}" stroke-width="1.4"/>`;
        s += T(L.xK + (sp.call ? -6 : 6), L.heapTop - 5, `strike ${fmtP(sp.K)}`, { a: sp.call ? "end" : "start", fill: INK, bold: true });
        // "pays here" shares the row with the ball count at the right edge: keep it only where it fits
        if (!sp.call || L.xK + 6 + 62 < L.x1 - 84) s += T(L.xK + (sp.call ? 6 : -6), L.heapTop - 5, "pays here", { a: sp.call ? "start" : "end", fill: MUTE });
        if (sp.product === "asian") s += T(sp.call ? L.x0 : L.x1, L.heapTop + 15, "heaped by each path’s average", { a: sp.call ? "start" : "end", size: 11.5 });
      }
      // gadgets in the pin field
      if (f.A && b) { const mx = L.ax + L.bx * b.sorted[NP >> 1]; s += `<line x1="${mx.toFixed(1)}" x2="${mx.toFixed(1)}" y1="${L.pinTop}" y2="${L.pinBot}" stroke="${BLUE}" stroke-width="1" stroke-dasharray="5 4" opacity=".5"/>`; }
      if (sp.H) {
        s += `<line x1="${L.xH.toFixed(1)}" x2="${L.xH.toFixed(1)}" y1="${L.pinTop}" y2="${L.floor}" stroke="${RED}" stroke-width="2.5"/>`;
        const away = sp.H < sp.S0;
        s += T(L.xH + (away ? 7 : -7), L.pinTop + 12, `barrier ${fmtP(sp.H)}`, { a: away ? "start" : "end", fill: RED, bold: true });
      }
      if (sp.product === "american" && b?.pol) {
        const pol = b.pol, nPol = pol.length / 4, pts = [], xmin = Math.max(0.4, Math.exp(L.lo) / sp.K);
        for (let j = 1; j < L.m; j++) {
          const q = 4 * clamp(Math.round((j * (nPol + 1)) / L.m) - 1, 0, nPol - 1), g = (x) => 1 - x - (pol[q] + x * (pol[q + 1] + x * (pol[q + 2] + x * pol[q + 3])));
          let hi = 1, found = false;
          for (let x = 0.999; x > xmin; x -= 0.004) if (g(x) > 0) { hi = x; found = true; break; }
          if (!found) { pts.push(null); continue; }
          let a = hi, c = hi + 0.004;
          for (let it = 0; it < 30; it++) { const mid = (a + c) / 2; if (g(mid) > 0) a = mid; else c = mid; }
          pts.push([L.xP(sp.K * (a + c) / 2), yAt(j)]);
        }
        const good = pts.filter(Boolean);
        if (good.length > 1) {
          let d = "", open = false;
          for (const p of pts) { if (!p) { open = false; continue; } d += (open ? "L" : "M") + clamp(p[0], L.x0, L.x1).toFixed(1) + " " + p[1].toFixed(1); open = true; }
          const lab = good[Math.floor(good.length / 2)];
          s += `<path d="${d}" fill="none" stroke="${INK}" stroke-width="1.4" stroke-dasharray="6 4"/>` + T(lab[0] - 8, lab[1] - 7, "exercise boundary", { size: 11.5, a: "end" });
        }
      }
      // trays
      if (f.kind) {
        const t = L.tray, name = ["", "knocked out", "exercised early", "never knocked in"][f.kind], col = f.kind === 1 ? RED : f.kind === 2 ? INK : GHOST;
        s += `<rect x="${t.x}" y="${t.y}" width="${t.w}" height="${t.h}" fill="#fff" stroke="${col}" stroke-width="1.5"/>` + `<text x="${t.x + t.w / 2}" y="${t.y + 15}" font-size="11.5" fill="${f.kind === 3 ? MUTE : col}" text-anchor="middle">${name}</text>` + `<text data-r="tray" x="${t.x + t.w / 2}" y="${t.y + 33}" font-size="15" font-weight="700" fill="${INK}" text-anchor="middle">${S.trays[f.kind]}</text>`;
      }
      // lanes
      if (f.S && b) {
        for (let h = 1; h < 32; h++) { const x = L.ax + L.bx * b.sorted[Math.floor((NP * h) / 32)]; s += `<line x1="${x.toFixed(1)}" x2="${x.toFixed(1)}" y1="${L.floor - 7}" y2="${L.floor + 1}" stroke="${GREEN}" stroke-width="1.5"/>`; }
        s += `<g data-r="lanes"></g><text x="${L.x0}" y="${L.floor + 66}" font-size="11.5" fill="${GREEN_D}">32 lanes, equally likely</text>`;
      }
      if (f.ring) s += `<path data-r="curve" fill="none" stroke="${VIOLET}" stroke-width="1.6"/><text data-r="curveLabel" font-size="11.5" fill="${VIOLET}" stroke="#fff" stroke-width="3" paint-order="stroke" stroke-linejoin="round"></text>`;
      // moving parts
      s += `<g data-r="routes"></g><g data-r="trails"></g><g data-r="notch"></g><g data-r="chips"></g>`;
      if (L.gh) s += gaugeSvg(T);
      svg.innerHTML = s;
      R = {};
      svg.querySelectorAll("[data-r]").forEach((e) => { R[e.dataset.r] = e; });
      R.trailEls = [];
      for (const t of S.trails) mountTrail(t);
      R.routeEls = {};
      for (const k in S.routes) setRoute(k);
      for (const c of S.chips) R.chips.appendChild(c);
      updateDynamic(true);
    }

    function gaugeSvg(T) {
      const y0 = L.gy, f = L.f, x0 = L.x0, x1 = L.x1, yc = y0 - (f.C ? 30 : 0), g0 = L.gx0, ay = y0 + 70;
      let s = "";
      if (f.C) s += `<text x="${x0}" y="${yc + 12}" font-size="11.5" fill="${MUTE}">stock, average so far</text><line x1="${g0}" x2="${x1}" y1="${yc + 20}" y2="${yc + 20}" stroke="${RULE}"/><g data-r="stockTicks"></g><line data-r="stockKnown" y1="${yc + 12}" y2="${yc + 28}" stroke="${INK}" stroke-width="1.6"/><g data-r="stockNeedle" opacity="0"><line y1="${yc + 11}" y2="${yc + 29}" stroke="${ORANGE}" stroke-width="2.4"/></g>`;
      s += `<text data-r="gLabel" x="${x0}" y="${y0 + 16}" font-size="12" fill="${MUTE}">Average payoff so far</text>`;
      s += `<text data-r="value" x="${x0}" y="${y0 + 46}" font-size="28" font-weight="700" fill="${INK}" style="font-variant-numeric:tabular-nums">\u2013</text>`;
      s += `<text data-r="gNote" x="${x0}" y="${y0 + 59}" font-size="11" fill="${MUTE}"></text>`;
      s += `<rect x="${x0}" y="${y0 + 66}" width="10" height="10" fill="${YELLOW}"/><text data-r="exactLabel" x="${x0 + 16}" y="${y0 + 75.5}" font-size="12.5" fill="${INK}"></text>`;
      s += `<line x1="${g0}" x2="${x1}" y1="${ay + 0.5}" y2="${ay + 0.5}" stroke="${RULE}" stroke-width="1"/><g data-r="axisTicks"></g>`;
      s += `<rect data-r="band" x="${(g0 + x1) / 2 - 4}" y="${ay - 30}" width="8" height="30" fill="${YELLOW}"/>`;
      s += `<g data-r="ghosts"></g>`;
      for (const k of ["off", "offCmp"]) s += `<g data-r="${k}" opacity="0"><line stroke="${k === "off" ? INK : GHOST}" stroke-width="1" stroke-dasharray="3 3"/><path fill="${k === "off" ? INK : GHOST}"/><text font-size="11.5" font-weight="700" fill="${k === "off" ? INK : GHOST}" stroke="#fff" stroke-width="3" paint-order="stroke" stroke-linejoin="round"></text></g>`;
      if (f.C) s += `<g data-r="arrow" opacity="0"><line stroke="${ORANGE}" stroke-width="2"/><path fill="${ORANGE}"/><text font-size="11" fill="${ORANGE_D}" text-anchor="middle" stroke="#fff" stroke-width="3" paint-order="stroke" stroke-linejoin="round">\u2212 \u03b2 \u00d7 error</text></g>`;
      s += `<g data-r="cmp" opacity="0"><line y1="${ay - 26}" y2="${ay}" stroke="${GHOST}" stroke-width="2"/><path d="M-4 ${ay - 34} L4 ${ay - 34} L0 ${ay - 27} Z" fill="${GHOST}"/><text data-r="cmpLabel" x="-8" y="${ay - 27}" font-size="11.5" font-weight="700" fill="${GHOST}" text-anchor="end" stroke="#fff" stroke-width="3" paint-order="stroke" stroke-linejoin="round">plain</text></g>`;
      s += `<g data-r="needle" opacity="0"><line y1="${ay - 34}" y2="${ay}" stroke="${INK}" stroke-width="2"/><path d="M-4 ${ay - 42} L4 ${ay - 42} L0 ${ay - 34} Z" fill="${INK}"/></g>`;
      s += `<text data-r="needleLabel" y="${ay - 35}" font-size="11.5" font-weight="700" fill="${INK}" text-anchor="start" opacity="0" stroke="#fff" stroke-width="3" paint-order="stroke" stroke-linejoin="round"></text>`;
      return s;
    }

    // ------------------------------------------------------------ painting
    function paintBoard() {
      const k = dpr();
      bctx.setTransform(k, 0, 0, k, 0, 0);
      bctx.clearRect(0, 0, back.width, back.height);
      if (!L || !cfg) return;
      const sh = show(), sp = cfg.spec;
      if (sh.heap !== false) { bctx.fillStyle = "rgba(20,23,26,.045)"; const ty = L.heapTop - 17; if (sp.call) bctx.fillRect(L.xK, ty, W - L.xK, L.floor - ty); else bctx.fillRect(0, ty, L.xK, L.floor - ty); }
      if (sh.pins !== false) {
        const rows = Math.min(L.m, 18), step = Math.ceil(L.m / rows), p = new Path2D();
        for (let j = step, row = 0; j <= L.m; j += step, row++) { const y = yAt(j), off = row % 2 ? 6.5 : 0; for (let x = L.x0 + off; x <= L.x1; x += 13) { p.moveTo(x + 2.0, y); p.arc(x, y, 2.0, 0, 6.2832); } }
        bctx.fillStyle = PIN; bctx.fill(p);
      }
      if (sh.heap === false) return;
      const d = S.landed, f = L.f, groups = new Map(), asianTicks = sp.product === "asian" ? new Path2D() : null;
      for (let i = 0; i < d.ln.length; i++) {
        const x = L.x0 + (d.bin[i] + 0.5) * L.bw, y = slotY(d.slot[i]), kk = d.cls[i] * 16 + Math.round(d.alpha[i] * 8) + (d.twin[i] ? 32 : 0);
        let g = groups.get(kk);
        if (!g) groups.set(kk, (g = new Path2D()));
        g.moveTo(x + L.r, y); g.arc(x, y, L.r, 0, 6.2832);
        if (asianTicks) { const ax = L.ax + L.bx * d.avg[i]; asianTicks.moveTo(ax + 1.8, L.floor + 6); asianTicks.arc(ax, L.floor + 6, 1.8, 0, 6.2832); }
      }
      for (const [kk, g] of groups) {
        const cls = (kk >> 4) & 1, a = (kk & 15) / 8, col = cls ? (f.ring ? VIOLET : INK) : f.ring ? VIOLET : PALE;
        if (f.ring) { bctx.globalAlpha = cls ? 1 : 0.4; bctx.strokeStyle = col; bctx.lineWidth = L.small ? 1 : 1.2; bctx.stroke(g); } else { bctx.globalAlpha = a; bctx.fillStyle = col; bctx.fill(g); if (kk & 32) { bctx.globalAlpha = 1; bctx.strokeStyle = BLUE; bctx.lineWidth = 1; bctx.stroke(g); } }
      }
      bctx.globalAlpha = 1;
      if (asianTicks) { bctx.strokeStyle = "rgba(20,23,26,.35)"; bctx.lineWidth = 1; bctx.stroke(asianTicks); }
    }

    function paintFront(n) {
      const k = dpr();
      if (gl) {
        gl.viewport(0, 0, front.width, front.height); gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
        if (!n) return;
        gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
        gl.useProgram(prog); gl.bindVertexArray(vao); gl.bindBuffer(gl.ARRAY_BUFFER, vbuf);
        gl.bufferData(gl.ARRAY_BUFFER, buf.subarray(0, n * 8), gl.DYNAMIC_DRAW);
        gl.uniform2f(loc.u_res, W, H); gl.uniform1f(loc.u_dpr, k); gl.uniform1f(loc.u_ring, L && L.small ? 1.0 : 1.4);
        gl.drawArrays(gl.POINTS, 0, n);
      } else {
        fctx.setTransform(k, 0, 0, k, 0, 0); fctx.clearRect(0, 0, front.width, front.height);
        for (let i = 0; i < n; i++) {
          const o = i * 8, rad = buf[o + 2] * 0.5 - 0.75;
          fctx.beginPath(); fctx.arc(buf[o], buf[o + 1], rad, 0, 6.2832);
          const c = `rgba(${Math.round(buf[o + 3] * 255)},${Math.round(buf[o + 4] * 255)},${Math.round(buf[o + 5] * 255)},${buf[o + 6]})`;
          if (buf[o + 7] > 0.5) { fctx.strokeStyle = c; fctx.lineWidth = 1.3; fctx.stroke(); } else { fctx.fillStyle = c; fctx.fill(); }
        }
      }
    }

    // ------------------------------------------------------------ balls
    const ROUTE = { i05: [INK, 0.05, 1], b25: [BLUE, 0.25, 1.4], i12: [INK, 0.12, 1], b12: [BLUE, 0.12, 1] };
    function setRoute(k) {
      let e = R.routeEls[k];
      if (!e) { const [c, o, w] = ROUTE[k]; e = R.routeEls[k] = el("path", { fill: "none", stroke: c, "stroke-opacity": o, "stroke-width": w, "stroke-linejoin": "round" }); R.routes.appendChild(e); }
      e.setAttribute("d", S.routes[k]);
    }
    function addRoute(k, ball) { // the route down to the last pin row (or to where the ball stopped)
      const p = polyline(ball.b, ball).pts, end = ball.fate === 0 ? p.length - 2 : p.length;
      let d = "";
      for (let j = 2; j < end; j += 2) d += (j > 2 ? "L" : "M") + p[j].toFixed(1) + " " + p[j + 1].toFixed(1);
      S.routes[k] = (S.routes[k] || "") + d; setRoute(k);
    }
    function mountTrail(t) {
      t.el = el("path", { fill: "none", stroke: t.color, "stroke-width": t.w || 1.2, "stroke-opacity": t.op || 1, "stroke-linejoin": "round", "stroke-linecap": "round" });
      if (t.d) t.el.setAttribute("d", t.d);
      R.trails.appendChild(t.el);
      if (t.jumps?.length) { t.notchEl = el("path", { fill: "none", stroke: VIOLET, "stroke-width": "2.2" }); R.notch.appendChild(t.notchEl); }
    }
    function polyline(b, ball) { // the ball's route in pixels: dates, then the fall into the heap
      const { X, m } = b, o = ball.i * (m + 1), pts = [L.ax, 34], gs = ball.gStop;
      const jumps = [];
      pts.push(L.ax, L.pinTop);
      for (let j = 1; j <= m; j++) {
        if (j / m > gs + 1e-9) { const f = gs * m - (j - 1), ln = X[o + j - 1] + (X[o + j] - X[o + j - 1]) * f; pts.push(L.ax + L.bx * ln, L.pinTop + L.pinH * gs); break; }
        pts.push(L.ax + L.bx * X[o + j], yAt(j));
        if (b.jumps && b.jumps[ball.i * m + j - 1]) jumps.push(pts.length - 2);
      }
      if (ball.fate === 0) pts.push(ball.xBin, ball.yLand);
      for (let k = 0; k < pts.length; k += 2) pts[k] = clamp(pts[k], 2, W - 2);
      return { pts, jumps };
    }
    function drawTrail(t, ball) {
      const p = t.pts, upTo = ball.phase === 0 ? ball.y : 1e9, out = [];
      for (let i = 0; i < p.length; i += 2) { if (p[i + 1] > upTo && i > 0) break; out.push((i ? "L" : "M") + p[i].toFixed(1) + " " + p[i + 1].toFixed(1)); }
      if (ball.phase === 0) out.push("L" + ball.x.toFixed(1) + " " + ball.y.toFixed(1));
      t.d = out.join(""); t.el.setAttribute("d", t.d);
      if (t.notchEl) t.notchEl.setAttribute("d", t.jumps.filter((k) => p[k + 1] <= upTo).map((k) => `M${(p[k] - 4.5).toFixed(1)} ${p[k + 1].toFixed(1)}L${(p[k] + 4.5).toFixed(1)} ${p[k + 1].toFixed(1)}`).join(""));
    }
    function bounds(ball) { // the heap spot of a ball (also used for reduced motion)
      const b = ball.b, i = ball.i, hv = b.heap[i], xv = L.ax + L.bx * hv;
      ball.bin = binOf(xv); ball.xBin = L.x0 + (ball.bin + 0.5) * L.bw;
    }
    function prepare(ball) { // fixes what the ball does the moment it starts to fall
      const b = ball.b, i = ball.i, sp = cfg.spec;
      ball.fate = L.f.shade ? 0 : b.fate[i]; ball.gStop = ball.fate === 0 ? 1 : b.gStop[i];
      ball.pay = b.pay[i]; ball.alpha = L.f.shade ? clamp(b.alpha[i], 0.06, 1) : 1;
      const absV = sp.S0 * Math.exp(b.heap[i]);
      ball.cls = inZone(absV) ? 1 : 0;
      ball.ring = L.f.ring ? 1 : 0;
      ball.col = ball.blue ? C.blue : ball.cls || ball.one ? C.ink : C.pale;
      if (ball.fate === 0) { bounds(ball); ball.slot = S.reserved[ball.bin]++; S.maxRes = Math.max(S.maxRes, ball.slot + 1); ball.yLand = slotY(ball.slot); }
      else ball.yLand = L.floor - L.r;
      ball.r0 = ball.one ? 5 : L.r;
    }
    function activate(ball) {
      prepare(ball);
      if (S.pitch !== pitchFor(S.maxRes)) { S.pitch = pitchFor(S.maxRes); S.dirty = true; }
      if (ball.fate === 0) ball.yLand = slotY(ball.slot);
      const yStopFall = ball.fate === 0 ? ball.yLand : L.pinTop + L.pinH * ball.gStop, span = Math.max(1, (ball.fate ? L.floor - L.r : ball.yLand) - 34);
      ball.stopU = ball.fate === 0 ? 1 : clamp(((yStopFall - 34) / span) ** (1 / 1.35), 0.02, 1);
      ball.span = span; ball.phase = 0; ball.dur = ball.dur0;
      if (ball.trail) { const t = ball.trail; const r = polyline(ball.b, ball); t.pts = r.pts; t.jumps = r.jumps; ball.t = t; S.trails.push(t); mountTrail(t); }
      else if (ball.faint) addRoute(ball.pair ? "b25" : "i05", ball);
      S.active.push(ball);
    }
    function place(ball, u) { // position of a falling ball at time fraction u
      const b = ball.b, m = L.m, y = 34 + ball.span * Math.pow(u, 1.35), g = clamp((y - L.pinTop) / L.pinH, 0, 1), f = Math.min(g, ball.gStop) * m, j = Math.min(m - 1, Math.floor(f)), fr = f - j, o = ball.i * (m + 1);
      const ln = b.X[o + j] + (b.X[o + j + 1] - b.X[o + j]) * fr;
      let x = L.ax + L.bx * ln;
      if (ball.fate === 0 && y > L.pinBot) {
        const s = clamp((y - L.pinBot) / Math.max(1, ball.yLand - L.pinBot), 0, 1), xe = L.ax + L.bx * b.end[ball.i];
        x = xe + (ball.xBin - xe) * s; ball.rad = ball.r0 + (L.r - ball.r0) * s;
      } else ball.rad = ball.r0;
      ball.x = Math.max(2, Math.min(W - 2, x)); ball.y = y;
    }
    function step(ball) { // returns false when the ball is done
      const t = S.clock - ball.t0;
      if (ball.phase === 0) {
        const u = Math.min(1, t / ball.dur0);
        if (u < ball.stopU) { place(ball, u); return true; }
        place(ball, ball.stopU);
        if (ball.fate === 0) { ball.phase = 2; ball.ts = S.clock; ball.x = ball.xBin; ball.y = ball.yLand; } else { ball.phase = 1; ball.ts = S.clock; ball.sx = ball.x; ball.sy = ball.y; ball.red = ball.fate === 1; }
      }
      if (ball.phase === 1) {
        const q = Math.min(1, (S.clock - ball.ts) / 480), e = 1 - (1 - q) ** 3, tr = L.tray, tx = tr.x + tr.w / 2, ty = tr.y + 6;
        ball.x = ball.sx + (tx - ball.sx) * e; ball.y = ball.sy + (ty - ball.sy) * e;
        if (ball.fate === 1) ball.col = C.red;
        if (q >= 1) { commit(ball); return false; }
        return true;
      }
      const q = Math.min(1, (S.clock - ball.ts) / 100);
      ball.x = ball.xBin; ball.y = slotY(ball.slot) - 2 * Math.sin(Math.PI * q); ball.rad = L.r;
      if (q >= 1) { commit(ball); return false; }
      return true;
    }
    function commit(ball) {
      if (ball.committed) return;
      ball.committed = true;
      const b = ball.b, i = ball.i, sp = cfg.spec, disc = Math.exp(-sp.r * sp.T), pv = ball.pay * disc, st = sp.S0 * Math.exp(b.end[i]) * disc;
      S.count++; S.sums.pay += pv; S.sums.pay2 += pv * pv; S.sums.st += st; S.sums.st2 += st * st;
      if (ball.fate === 0) {
        const d = S.landed;
        d.ln.push(b.heap[i]); d.cls.push(ball.cls); d.alpha.push(ball.alpha); d.bin.push(ball.bin); d.slot.push(S.binCount[ball.bin]++); d.avg.push(b.avgLn[i]); d.twin.push(ball.twin ? 1 : 0);
        let lo = 0, hi = 31; // lane of this ball among the 32 equally likely ones
        const e = b.end[i];
        while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (e >= b.sorted[Math.floor((NP * mid) / 32)]) lo = mid; else hi = mid - 1; }
        S.lanes[lo]++;
      } else S.trays[L.f.kind]++;
      if (ball.keep) addRoute(ball.pair ? "b12" : "i12", ball);
      S.dirty = true; S.gaugeDirty = true; ariaDirty = true;
      S.last = { count: S.count, ST: sp.S0 * Math.exp(b.end[i]), payoff: ball.pay };
      S.landedFrame = true;
      if (ball.chip && R.chips) {
        const tr = L.tray;
        let cx, cy, anchor = "middle";
        if (ball.fate) { const left = tr.side === "left"; cx = left ? tr.x + tr.w + 8 : tr.x - 8; cy = tr.y + 24; anchor = left ? "start" : "end"; }
        else {
          const top = slotY(ball.slot) - L.r; cx = clamp(ball.xBin, 44, W - 44); cy = top - 9;
          if (cy < L.heapTop + 12) { const right = ball.bin < L.nb / 2; cx = clamp(ball.xBin + (right ? 12 : -12), 10, W - 10); cy = L.heapTop + 16; anchor = right ? "start" : "end"; }
        }
        const txt = el("text", { x: cx, y: cy, "font-size": "12", "font-weight": "700", fill: INK, "text-anchor": anchor, stroke: "#fff", "stroke-width": "3", "paint-order": "stroke", "stroke-linejoin": "round" });
        txt.style.transition = "opacity .5s"; txt.textContent = "pays " + (ball.pay > 0 ? ball.pay.toFixed(2) : "0");
        R.chips.appendChild(txt); S.chips.push(txt);
        setTimeout(() => { txt.style.opacity = "0"; }, 2000);
        setTimeout(() => { txt.remove(); S.chips = S.chips.filter((c) => c !== txt); }, 2600);
      }
      const dr = ball.drop;
      if (--dr.left === 0) { dr.res(); S.drops = S.drops.filter((d) => d !== dr); }
    }

    // ------------------------------------------------------------ batches
    function advance() {
      if (S.loading) return S.loading;
      const gen = S.gen, local = cfg, no = S.batchNo++;
      S.loading = makeBatch(cfg, cfg.seed + 4 * no).then((b) => {
        if (gen !== S.gen) return b;
        S.loading = null; S.cur = b;
        if (no === 0) { S.first = b; S.scale = scaleFor(b); layout(); }
        return b;
      }, (e) => { if (gen === S.gen) { S.loading = null; S.batchNo--; } throw e; });
      return S.loading;
    }
    async function take(n) {
      const picks = [], gen = S.gen;
      while (picks.length < n) {
        if (!S.cur || S.cur.pos >= NP) { await advance(); if (gen !== S.gen) return null; continue; }
        picks.push([S.cur, S.cur.order[S.cur.pos++]]);
      }
      return picks;
    }

    // ------------------------------------------------------------ gauge
    function traceAt(tr, n) {
      if (!tr || !tr.length || n < 1) return NaN;
      if (n <= tr[0][0]) return tr[0][1];
      for (let k = 1; k < tr.length; k++) if (tr[k][0] >= n) { const a = tr[k - 1], c = tr[k], t = (Math.log(n) - Math.log(a[0])) / (Math.log(c[0]) - Math.log(a[0]) || 1); return a[1] + (c[1] - a[1]) * t; }
      return tr[tr.length - 1][1];
    }
    const meanPay = () => (S.count ? S.sums.pay / S.count : NaN);
    const sdOf = (s, s2, n) => (n > 1 ? Math.sqrt(Math.max(0, (s2 - (s * s) / n) / (n - 1))) : NaN);
    function gaugeTarget() {
      const exact = cfg.exact, lastSe = trace?.length ? trace[trace.length - 1][2] : NaN, plainSe = sdOf(S.sums.pay, S.sums.pay2, S.count) / Math.sqrt(S.count);
      if (cfg.gaugeRange) return { center: (cfg.gaugeRange[0] + cfg.gaugeRange[1]) / 2, half: (cfg.gaugeRange[1] - cfg.gaugeRange[0]) / 2, fixed: true };
      const center = Number.isFinite(exact) ? exact : Number.isFinite(meanPay()) ? meanPay() : 1;
      let half = Math.max(Number.isFinite(plainSe) ? 3.5 * plainSe : 0, Number.isFinite(lastSe) ? 4 * lastSe : 0);
      if (!(half > 0)) half = Math.max(Math.abs(center) * 0.35, 0.05);
      return { center, half };
    }
    function updateGauge(dt, force) {
      if (!L?.gh || !R.needle) return;
      const sp = cfg.spec, { center, half, fixed } = gaugeTarget(), gx0 = L.gx0, gx1 = L.x1, y0 = L.gy, ay = y0 + 70;
      if (!Number.isFinite(G.range) || force && !S.count || fixed) G.range = half;
      else if (fixed) G.range = half;
      else G.range += (half - G.range) * (1 - Math.exp(-dt / 140));
      const rng = G.range, px = (v) => clamp(gx0 + ((v - (center - rng)) / (2 * rng)) * (gx1 - gx0), gx0 + 3, gx1 - 3);
      // ticks
      const tk = ticks(center - rng, center + rng, 4), dec = decimals(tk.step);
      const sig = tk.vals.map((v) => v.toFixed(dec)).join("|");
      if (sig !== G.sig) { G.sig = sig; R.axisTicks.innerHTML = tk.vals.map((v) => `<line x1="${px(v).toFixed(1)}" x2="${px(v).toFixed(1)}" y1="${ay + 1}" y2="${ay + 6}" stroke="${RULE}"/><text x="${px(v).toFixed(1)}" y="${ay + 27}" font-size="11.5" fill="${MUTE}" text-anchor="middle">${esc(v.toLocaleString("en", { minimumFractionDigits: dec, maximumFractionDigits: dec }))}</text>`).join(""); }
      R.exactLabel.innerHTML = Number.isFinite(cfg.exact) ? `true price <tspan font-weight="700">${cfg.exact.toFixed(2)}</tspan>` : "true price";
      const mx = (gx0 + gx1) / 2;
      R.band.setAttribute("x", (Number.isFinite(cfg.exact) ? px(cfg.exact) : mx) - 4);
      const plain = !cfg.sel, letters = ["A", "C", "S", "K"].filter((l) => L.f[l]).join("+");
      R.gLabel.textContent = plain || !letters ? "Average payoff so far" : `Estimate with ${letters} so far`;
      R.gNote.textContent = plain || !letters ? "" : "the engine\u2019s own estimate at this many balls";
      let tv = plain ? meanPay() : traceAt(trace, S.count);
      if (!Number.isFinite(tv)) tv = meanPay();
      R.value.textContent = Number.isFinite(tv) && S.count ? tv.toFixed(2) : "\u2013";
      const pxr = (v) => gx0 + ((v - (center - rng)) / (2 * rng)) * (gx1 - gx0);
      // a value off the axis gets an arrow at that end instead of a needle
      const offMark = (g, v, text, y) => {
        const raw = Number.isFinite(v) ? pxr(v) : 0;
        if (!Number.isFinite(v) || (raw >= gx0 && raw <= gx1)) { g.setAttribute("opacity", "0"); return false; }
        const left = raw < gx0, tip = left ? gx0 + 2 : gx1 - 2, d = left ? 1 : -1, base = tip + d * 9, [ln, ar, tx] = g.childNodes;
        ar.setAttribute("d", `M${tip} ${y} L${base} ${y - 4.5} L${base} ${y + 4.5} Z`);
        ln.setAttribute("x1", base); ln.setAttribute("x2", base + d * 22); ln.setAttribute("y1", y); ln.setAttribute("y2", y);
        tx.textContent = text; tx.setAttribute("x", base + d * 27); tx.setAttribute("y", y + 4); tx.setAttribute("text-anchor", left ? "start" : "end");
        g.setAttribute("opacity", "1"); return true;
      };
      const offMain = offMark(R.off, tv, Number.isFinite(tv) && S.count ? tv.toFixed(2) : "", ay - 20), offCmp = offMark(R.offCmp, traceAt(compare, S.count), `plain ${traceAt(compare, S.count).toFixed(1)}`, ay - 6);
      let target = Number.isFinite(tv) && !offMain ? px(tv) : NaN, moving = false;
      if (Number.isFinite(target)) {
        if (!Number.isFinite(G.needle)) G.needle = target;
        const before = G.needle;
        G.needle += (target - G.needle) * (1 - Math.exp(-dt / 40));
        if (Math.abs(target - G.needle) < 0.05) G.needle = target;
        moving = Math.abs(target - G.needle) > 0.05 || Math.abs(before - G.needle) > 0.02;
        if (!G.trail.length || Math.abs(G.trail[G.trail.length - 1] - G.needle) > 0.5) { G.trail.push(G.needle); if (G.trail.length > 30) G.trail.shift(); }
        R.needle.setAttribute("transform", `translate(${G.needle.toFixed(2)} 0)`); R.needle.setAttribute("opacity", "1");
        const lab = R.needleLabel, right = G.needle > gx1 - 70; // the method name sits beside the needle
        lab.textContent = traceLabel; lab.setAttribute("x", (G.needle + (right ? -7 : 7)).toFixed(1)); lab.setAttribute("text-anchor", right ? "end" : "start"); lab.setAttribute("opacity", traceLabel ? "1" : "0");
      } else { R.needle.setAttribute("opacity", "0"); R.needleLabel.setAttribute("opacity", "0"); G.trail.length = 0; G.needle = NaN; }
      // ghost trail
      const gh = R.ghosts, n = G.trail.length;
      while (gh.childNodes.length < 30) gh.appendChild(el("line", { y1: ay - 34, y2: ay, stroke: INK, "stroke-width": "1" }));
      for (let k = 0; k < 30; k++) { const node = gh.childNodes[k], idx = n - 2 - k; if (idx >= 0) { node.setAttribute("x1", G.trail[idx].toFixed(1)); node.setAttribute("x2", G.trail[idx].toFixed(1)); node.setAttribute("opacity", (0.28 * (1 - k / 30)).toFixed(3)); } else node.setAttribute("opacity", "0"); }
      // compare needle
      const cv = traceAt(compare, S.count);
      if (Number.isFinite(cv) && !offCmp) { R.cmp.setAttribute("transform", `translate(${px(cv).toFixed(2)} 0)`); R.cmp.setAttribute("opacity", "1"); const cl = R.cmpLabel, rt = px(cv) < gx0 + 50; cl.setAttribute("x", rt ? 8 : -8); cl.setAttribute("text-anchor", rt ? "start" : "end"); } else R.cmp.setAttribute("opacity", "0");
      // the answer key: discounted stock average against its known value
      if (L.f.C && R.stockNeedle) {
        const known = sp.S0 * Math.exp(-sp.q * sp.T), sdS = sdOf(S.sums.st, S.sums.st2, S.count), halfS = Math.max(3.5 * (Number.isFinite(sdS) ? sdS / Math.sqrt(S.count) : 0), known * 0.004), sx = (v) => clamp(gx0 + ((v - (known - halfS)) / (2 * halfS)) * (gx1 - gx0), gx0 + 3, gx1 - 3);
        R.stockKnown.setAttribute("x1", mx); R.stockKnown.setAttribute("x2", mx);
        if (S.count) {
          const sn = sx(S.sums.st / S.count);
          R.stockNeedle.setAttribute("transform", `translate(${sn.toFixed(2)} 0)`); R.stockNeedle.setAttribute("opacity", "1");
          const pm = Number.isFinite(meanPay()) ? px(meanPay()) : NaN, ar = R.arrow;
          if (Number.isFinite(pm) && Number.isFinite(G.needle) && Math.abs(pm - G.needle) > 6) {
            const ay2 = y0 + 82, dir = Math.sign(G.needle - pm);
            const ln = ar.firstChild; ln.setAttribute("x1", pm); ln.setAttribute("x2", G.needle - dir * 6); ln.setAttribute("y1", ay2); ln.setAttribute("y2", ay2);
            ar.childNodes[1].setAttribute("d", `M${G.needle} ${ay2} L${G.needle - dir * 8} ${ay2 - 4} L${G.needle - dir * 8} ${ay2 + 4} Z`);
            const t = ar.childNodes[2], lft = Math.min(pm, G.needle) > gx0 + 90; t.setAttribute("text-anchor", "middle"); t.setAttribute("x", ((pm + G.needle) / 2).toFixed(1)); t.setAttribute("y", ay2 - 5);
            ar.setAttribute("opacity", "1");
          } else ar.setAttribute("opacity", "0");
          const stk = R.stockTicks; if (!stk.firstChild) stk.appendChild(el("text", { x: gx1, y: L.gy - 30 + 12, "font-size": "11.5", fill: ORANGE_D, "text-anchor": "end" }));
          stk.firstChild.textContent = "known " + known.toFixed(2);
        } else { R.stockNeedle.setAttribute("opacity", "0"); R.arrow.setAttribute("opacity", "0"); }
      }
      S.needleSettled = !moving && Math.abs(G.range - half) < half * 0.002;
    }

    function updateDynamic(force) {
      if (!L) return;
      const f = L.f;
      if (R.count) R.count.textContent = `${fmtN(S.count)} ball${S.count === 1 ? "" : "s"}`;
      if (R.tray && f.kind) R.tray.textContent = fmtN(S.trays[f.kind]);
      if (f.S && R.lanes) {
        const total = S.lanes.reduce((a, v) => a + v, 0), b = S.cur || S.first;
        let s = "";
        if (b) for (let h = 0; h < 32; h++) {
          const xa = h ? L.ax + L.bx * b.sorted[Math.floor((NP * h) / 32)] : L.x0, xb = h < 31 ? L.ax + L.bx * b.sorted[Math.floor((NP * (h + 1)) / 32)] : L.x1, hh = total ? Math.min(9, (S.lanes[h] / (total / 32)) * 6) : 0;
          s += `<rect x="${(xa + 0.5).toFixed(1)}" y="${(L.floor + 50 - hh).toFixed(1)}" width="${Math.max(0.5, xb - xa - 1).toFixed(1)}" height="${hh.toFixed(1)}" fill="${GREEN}"/>`;
        }
        s += `<line x1="${L.x0}" x2="${L.x1}" y1="${L.floor + 50.5}" y2="${L.floor + 50.5}" stroke="${GREEN}" stroke-width=".5"/>`;
        R.lanes.innerHTML = s;
      }
      if (f.ring && R.curve && cfg.spec.product === "merton") {
        const sp = cfg.spec, kappa = Math.exp(sp.muJ + sp.delta ** 2 / 2) - 1, drift = (sp.r - sp.q - sp.sigma ** 2 / 2 - sp.lam * kappa) * sp.T, lamT = sp.lam * sp.T, N = Math.max(S.count, 80);
        const dln = (L.bw / (L.x1 - L.x0)) * (L.hi - L.lo), pts = [];
        let peak = 0, peakX = 0;
        for (let x = L.x0; x <= L.x1; x += 3) {
          const y = Math.log(Math.exp(L.lo + ((x - L.x0) / (L.x1 - L.x0)) * (L.hi - L.lo)) / sp.S0);
          let dens = 0, w = Math.exp(-lamT);
          for (let k = 0; k < 40; k++) { const v = sp.sigma ** 2 * sp.T + k * sp.delta ** 2, mu = drift + k * sp.muJ; dens += w * Math.exp(-((y - mu) ** 2) / (2 * v)) / Math.sqrt(2 * Math.PI * v); w *= lamT / (k + 1); }
          const h = Math.min(L.floor - L.heapTop - 4, N * dens * dln * S.pitch);
          pts.push([x, L.floor - h]);
          if (h > peak) { peak = h; peakX = x; }
        }
        R.curve.setAttribute("d", pts.map((p, i) => (i ? "L" : "M") + p[0].toFixed(1) + " " + p[1].toFixed(1)).join(""));
        const ballTop = (xa, xb) => { // highest ball between two x positions
          let t = L.floor;
          for (let bb = Math.max(0, Math.floor((xa - L.x0) / L.bw)); bb <= Math.min(L.nb - 1, Math.floor((xb - L.x0) / L.bw)); bb++) if (S.reserved[bb]) t = Math.min(t, slotY(S.reserved[bb] - 1) - L.r);
          return t;
        };
        const lw = 150, py = L.floor - peak;
        const cands = [[peakX + 14, "start"], [peakX - 14, "end"]].filter(([x, an]) => (an === "start" ? x + lw <= L.x1 - 4 : x - lw >= L.x0));
        let best = null;
        for (const [x, an] of cands) { // the label sits at the peak's height, or just above any balls under it
          const top = ballTop(an === "start" ? x : x - lw, an === "start" ? x + lw : x), y = Math.min(py + 3, top - 5);
          const xa = an === "start" ? x : x - lw, xb = xa + lw;
          if (y >= L.heapTop + 12 && !(L.xK > xa - 3 && L.xK < xb + 3)) { best = { x, an, y }; break; }
        }
        if (!best) { // beside the strike line, a row below its labels, on whichever side has room, never across the line
          const left = L.xK - 10 - lw >= L.x0, x = left ? L.xK - 10 : L.xK + 10, an = left ? "end" : "start";
          const top = ballTop(left ? x - lw : x, left ? x : x + lw);
          best = { x, an, y: Math.max(L.heapTop + 26, Math.min(L.heapTop + 30, top - 5)) };
        }
        R.curveLabel.setAttribute("x", best.x); R.curveLabel.setAttribute("y", best.y); R.curveLabel.setAttribute("text-anchor", best.an); R.curveLabel.textContent = "the formula fills this in";
      }
    }

    // ------------------------------------------------------------ the loop
    const running = () => visible && !document.hidden && !destroyed;
    function kick() { if (!raf && running()) raf = requestAnimationFrame(frame); }
    function frame(ts) {
      raf = 0;
      if (!running() || !L || !cfg) { last = 0; return; }
      const dt = last ? Math.min(250, ts - last) : 16;
      last = ts; S.clock += dt;
      S.landedFrame = false;
      while (S.qi < S.launchQ.length && S.launchQ[S.qi].t0 <= S.clock) activate(S.launchQ[S.qi++]);
      if (S.qi && S.qi === S.launchQ.length) { S.launchQ.length = 0; S.qi = 0; }
      const act = S.active;
      for (let k = act.length - 1; k >= 0; k--) if (!step(act[k])) { act[k] = act[act.length - 1]; act.pop(); }
      // ball positions to the GPU
      if (buf.length < act.length * 8) buf = new Float32Array(act.length * 16);
      let n = 0;
      for (const b of act) {
        if (b.phase === 0 && !(b.x >= 0)) continue;
        const o = n++ * 8, c = b.col;
        buf[o] = b.x; buf[o + 1] = b.y; buf[o + 2] = (b.rad || L.r) * 2 + 1.5; buf[o + 3] = c[0]; buf[o + 4] = c[1]; buf[o + 5] = c[2]; buf[o + 6] = b.alpha; buf[o + 7] = b.ring;
        if (b.t) drawTrail(b.t, b);
      }
      paintFront(n);
      const pitchNow = pitchFor(S.maxRes);
      if (pitchNow !== S.pitch) { S.pitch = pitchNow; S.dirty = true; }
      if (S.dirty) { S.dirty = false; paintBoard(); updateDynamic(); }
      if (S.gaugeDirty || !S.needleSettled || G.trail.length > 1) { updateGauge(dt, false); S.gaugeDirty = false; if (G.trail.length > 1 && S.needleSettled && G.trail.length) { G.trail.shift(); if (G.trail.length > 1) S.needleSettled = false; } }
      if (S.landedFrame) { updateDynamic(); const info = { count: S.count, ST: S.last.ST, payoff: S.last.payoff, mean: meanPay(), exact: cfg.exact }; for (const fn of listeners.land) fn(info); }
      if (ariaDirty && ts - lastAria > 1000) { lastAria = ts; ariaDirty = false; ariaCount = S.count; live.textContent = `${fmtN(S.count)} ball${S.count === 1 ? "" : "s"} dropped. Average payoff ${meanPay().toFixed(1)}. True price ${Number.isFinite(cfg.exact) ? cfg.exact.toFixed(2) : "not known yet"}.`; }
      if (act.length || S.qi < S.launchQ.length || !S.needleSettled || S.dirty || ariaDirty || G.trail.length > 1) raf = requestAnimationFrame(frame);
      else last = 0;
    }

    // ------------------------------------------------------------ the API
    function release() { for (const d of S.drops) d.res(); S.drops = []; }
    function reset() {
      release();
      const keep = { first: S.first, scale: S.scale };
      S = fresh();
      Object.assign(S, keep);
      if (S.first) { S.first.pos = 0; S.cur = S.first; S.batchNo = 1; }
      G.trail.length = 0; G.needle = NaN; G.range = NaN; G.sig = "";
      ariaCount = -1; live.textContent = "";
      S.landedFrame = false;
    }
    function set(c) {
      const k = JSON.stringify([c.spec, c.sel, c.seed, c.strata]), changed = k !== key;
      cfg = { show: {}, ...c, sel: c.sel || 0, seed: c.seed >>> 0 };
      if (changed) {
        key = k;
        const gen = S.gen + 1;
        release();
        S = fresh(); S.gen = gen;
        G.trail.length = 0; G.needle = NaN; G.range = NaN; G.sig = "";
        live.textContent = ""; ariaDirty = false;
        layout();
        const go = (tries) => advance().catch(() => { if (tries > 0 && !destroyed) setTimeout(() => go(tries - 1), 250); });
        go(4);
      } else { layout(); S.gaugeDirty = true; kick(); }
    }
    function drop(n, o = {}) {
      if (!cfg) return Promise.resolve();
      const pace = o.pace || (n === 1 ? "one" : "rain"), gen = S.gen;
      if (n === 1 && pace === "one" && L?.f.A) n = 2; // a single drop with A is the mirror pair, falling together
      return take(n).then((picks) => {
        if (!picks || gen !== S.gen || destroyed) return;
        for (const t of S.trails) t.el?.remove();
        S.trails = []; R.notch && (R.notch.innerHTML = ""); R.chips && (R.chips.innerHTML = ""); S.chips = [];
        S.routes = {}; R.routes && (R.routes.innerHTML = ""); R.routeEls = {};
        return new Promise((res) => {
          const dr = { left: picks.length, res }, f = L.f, one = pace === "one", span = Math.min(3000, 250 + n * 1.2), balls = [];
          const dur = one ? 1900 : 1400;
          picks.forEach(([b, i], k) => {
            const pair = f.A && b.anti;
            const slot = one ? (pair ? Math.floor(k / 2) * 2000 : k * 2000) : pair ? Math.floor(k / 2) * (span / (n / 2)) : (k * span) / n;
            const ball = { b, i, t0: S.clock + slot, dur0: dur, one, pair, twin: pair, blue: one && pair, drop: dr, chip: one, faint: !one && ((pair && k < 64) || (!pair && n <= 64)), keep: !one && k >= n - 24, trail: one ? { color: pair ? BLUE : INK, w: pair ? 1.4 : 1.2, op: pair ? 0.8 : 1 } : null, phase: -1 };
            balls.push(ball);
          });
          if (still) {
            S.drops.push(dr);
            for (const ball of balls) { prepare(ball); ball.x = ball.xBin; ball.y = ball.yLand; ball.phase = 2; commit(ball); }
            S.pitch = pitchFor(S.maxRes); S.dirty = true; kick();
            return;
          }
          S.drops.push(dr);
          for (const ball of balls) S.launchQ.push(ball);
          S.launchQ.sort((a, c) => a.t0 - c.t0);
          kick();
        });
      });
    }
    function clear() {
      const had = S.cur;
      for (const t of S.trails) t.el?.remove();
      reset();
      if (!had) advance().catch(() => {});
      layout();
      kick();
    }
    // the resolved drop promises of cleared balls stay pending by design: a cleared board has nothing to wait for
    const api = {
      set, drop, clear, resize() { layout(); },
      setTrace(t, label) { trace = t; traceLabel = label || ""; S.gaugeDirty = true; G.needle = Number.isFinite(G.needle) ? G.needle : NaN; kick(); },
      setCompare(t) { compare = t; S.gaugeDirty = true; kick(); },
      on(name, fn) { (listeners[name] || (listeners[name] = [])).push(fn); },
      get count() { return S.count; },
      get webgl() { return Boolean(gl); },
      get state() { return S; },
      destroy() { destroyed = true; ro.disconnect(); io.disconnect(); document.removeEventListener("visibilitychange", kick); cancelAnimationFrame(raf); back.remove(); svg.remove(); front.remove(); live.remove(); },
    };
    const ro = new ResizeObserver(() => { if (host.clientWidth !== W || host.clientHeight !== H) layout(); });
    ro.observe(host);
    const io = new IntersectionObserver((e) => { visible = e[e.length - 1].isIntersecting; if (visible) { last = 0; kick(); } });
    io.observe(host);
    document.addEventListener("visibilitychange", () => { last = 0; kick(); });
    layout();
    return api;
  }

  return { create };
})();
