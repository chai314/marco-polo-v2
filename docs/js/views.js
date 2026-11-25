// The four views in the evidence panel. Lines go through the ink engine; axes, labels and handles are SVG.
"use strict";

const Views = (() => {
  const INK = [0.078, 0.09, 0.102], GREY = [0.47, 0.5, 0.54], PALE = [0.62, 0.65, 0.69], RED = [0.75, 0.21, 0.17];
  const svg = () => document.getElementById("marks");
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const text = (x, y, s, cls = "", anchor = "start") => `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" class="${cls}" text-anchor="${anchor}">${s}</text>`;
  const nice = (x) => { const p = 10 ** Math.floor(Math.log10(x)), m = x / p; return (m > 5 ? 10 : m > 2 ? 5 : m > 1 ? 2 : 1) * p; };
  const ticks = (lo, hi, n) => { const s = nice((hi - lo) / n), out = []; for (let v = Math.ceil(lo / s - 1e-9) * s; v <= hi + s * 1e-6; v += s) out.push(Math.abs(v) < s * 1e-9 ? 0 : v); return out; };
  const decimals = (step) => Math.max(0, Math.min(8, -Math.floor(Math.log10(step) + 1e-9)));
  const path = (pts) => pts.map((p, i) => (i ? "L" : "M") + p[0].toFixed(1) + " " + p[1].toFixed(1)).join("");
  const fmt = (v, d) => minus(v.toFixed(d));
  const isFlat = (p) => p === "european" || p === "merton";
  const show = (on) => {
    document.getElementById("sheet").hidden = on !== "sheet";
    document.getElementById("lab-board").hidden = on !== "board";
    svg().style.display = on === "plot" ? "" : "none";
  };

  // ------------------------------------------------------------------ board (the Galton board)
  let galton = null;
  const BOARD_NOTE = { barrier: " Balls that touch the red wall are knocked out.", american: " Balls that cross the dashed line are exercised early.", asian: " Each ball is heaped by its average price, which is what this option pays on." };
  async function board(ctx) {
    show("board");
    Ink.clear();
    ctx.wait("");
    const { spec, sel, base, ref } = ctx, host = document.getElementById("lab-board");
    if (!galton) galton = Board.create(host, { gauge: true });
    galton.set({ spec, sel, seed: base.seed, exact: ref, strata: base.strata });
    ctx.tools(`<button type="button" class="tool" id="t-drop1">Drop 1</button><button type="button" class="tool" id="t-drop1k">Drop 1,000</button><button type="button" class="tool" id="t-clear">Clear</button>`);
    const run = (n) => galton.drop(n).catch(() => {});
    document.getElementById("t-drop1").onclick = () => run(1);
    document.getElementById("t-drop1k").onclick = () => run(1000);
    document.getElementById("t-clear").onclick = () => galton.clear();
    ctx.caption("Each ball is one simulated future. The needle is the engine’s own estimate after that many balls, and the yellow bar is the true price. Switch tricks on the right and watch the needle calm down." + (BOARD_NOTE[spec.product] || ""));
    const trace = (f) => {
      const key = JSON.stringify(["board", spec, base.n, base.seed, base.strata, f]);
      if (!ctx.cache.has(key)) {
        const p = Engine.call("race", { spec, flags: f, n: base.n, strata: base.strata, seed: base.seed, points: 64 });
        p.catch(() => ctx.cache.delete(key));
        ctx.cache.set(key, p);
        if (ctx.cache.size > 40) ctx.cache.delete(ctx.cache.keys().next().value);
      }
      return ctx.cache.get(key);
    };
    try {
      const [mine, plain] = await Promise.all([trace(sel), sel ? trace(0) : null]);
      if (!ctx.alive()) return;
      galton.setTrace(mine, word(sel));
      galton.setCompare(sel ? plain : null);
      if (galton.count === 0) run(base.n >= 2000 ? 2000 : 1000); // an empty board teaches nothing: fill it
    } catch (e) { if (e.message !== "stale") throw e; }
  }

  // ------------------------------------------------------------------ convergence
  let zoom = false, shift = 0;
  function runsOf(ctx, f) {
    const { spec, base } = ctx, count = isFlat(spec.product) ? 64 : 48, key = JSON.stringify(["race", spec, base.n, base.seed, base.strata, f, shift]);
    let e = ctx.cache.get(key);
    if (!e) {
      e = { got: new Array(count), list: [] };
      for (let i = 0; i < count; i++) {
        const p = Engine.call("race", { spec, flags: f, n: base.n, strata: base.strata, points: 64, seed: (base.seed * 2654435761 + 104729 * (i + 1) + 7919 * shift) >>> 0 });
        p.then((r) => { e.got[i] = r; }, () => ctx.cache.delete(key));
        e.list.push(p);
      }
      ctx.cache.set(key, e);
      if (ctx.cache.size > 40) ctx.cache.delete(ctx.cache.keys().next().value);
    }
    return e;
  }

  async function race(ctx) {
    show("plot");
    ctx.wait("");
    const { spec, sel, base, results, ref } = ctx, W = Ink.width, H = Ink.height, small = W < 640;
    const B = { x: small ? 50 : 70, y: 30, w: W - (small ? 50 : 70) - (small ? 64 : 128), h: H - 30 - 46 };
    const N = base.n, p = results.get(0), c = results.get(sel), z = zoom && sel;
    const plain = runsOf(ctx, 0), mine = sel ? runsOf(ctx, sel) : null;
    // start where every estimator exists: a stratified run needs a path in every stratum first
    const first = await Promise.race([Promise.all([plain.list[0], mine ? mine.list[0] : null]), new Promise((r) => setTimeout(() => r(null), 4000))]);
    if (!ctx.alive()) return;
    const n0 = Math.max(N / 32, ...(first || []).filter(Boolean).map((r) => r[0][0]));
    const half = 2.6 * (z ? c.real : p.real) * Math.sqrt(N / n0), mid = biasedMid(ctx, c);
    const X = (n) => B.x + (Math.log(n / n0) / Math.log(N / n0)) * B.w;
    const Y = (v) => B.y + B.h / 2 - ((v - mid) / half) * (B.h / 2);
    const clampY = (y) => Math.max(B.y - 40, Math.min(B.y + B.h + 40, y));
    const line = (r, color, alpha, width) => {
      const pts = [];
      for (const [n, v] of r) if (n >= n0 * 0.97) pts.push(X(n), clampY(Y(v)));
      return { pts, color, alpha, width };
    };
    const band = sel ? (2 * 1.96 * c.real / half) * (B.h / 2) : 99, thin = band < 28, both = mine ? [[plain, GREY, z ? 0.14 : 0.3, 1], [mine, INK, thin ? 0.13 : 0.5, thin ? 0.7 : 1.15]] : [[plain, INK, 0.36, 1.1]];
    const ready = [];
    both.forEach(([e, col, a, w]) => e.got.forEach((r) => { if (r) ready.push(line(r, col, a, w)); }));
    const morph = ctx.mode === "zoom" && both.every(([e]) => e.got.every(Boolean));
    Ink.draw(ready, { key: `race${sel}-${ready.length}`, morph: morph ? 700 : 0, instant: true, reveal: 900, clip: [B.x, B.y - 1, B.w + 2, B.h + 2] });
    let pending = 0;
    both.forEach(([e, col, a, w]) => e.list.forEach((pr, i) => {
      if (e.got[i]) return;
      pending++;
      pr.then((r) => { if (!ctx.alive()) return; Ink.add([{ ...line(r, col, a, w), delay: 0 }]); const t = document.getElementById("runs-lab"); if (t) t.textContent = label(); }, () => {});
    }));

    // marks
    let s = `<defs><clipPath id="box"><rect x="${B.x}" y="${B.y}" width="${B.w}" height="${B.h}"/></clipPath></defs>`;
    const ty = ticks(mid - half, mid + half, small ? 4 : 6), d = ty.length > 1 ? decimals(ty[1] - ty[0]) : 2;
    for (const v of ty) { const y = Y(v); if (y < B.y - 1 || y > B.y + B.h + 1) continue; s += `<line class="grid" x1="${B.x}" x2="${B.x + B.w}" y1="${y}" y2="${y}"/>`; if (Math.abs(y - Y(ref)) > 13) s += text(B.x - 10, y + 4, fmt(v, d), "tick", "end"); }
    const xs = []; for (let e = Math.floor(Math.log10(n0)); e <= Math.log10(N) + 1; e++) for (const m of [1, 2, 5]) { const n = m * 10 ** e; if (n >= n0 * 0.999 && n <= N * 1.001) xs.push(n); }
    if (!xs.includes(N)) xs.push(N);
    xs.forEach((n, i) => { const x = X(n); if (i < xs.length - 1 && X(N) - x < (small ? 74 : 40)) return; s += `<line class="grid" x1="${x}" x2="${x}" y1="${B.y}" y2="${B.y + B.h}"/>` + text(x, B.y + B.h + 20, n.toLocaleString("en") + (n === N ? " paths" : ""), "tick", n === N ? "end" : "middle"); });
    const env = (sd, cls) => {
      const k = Array.from({ length: 48 }, (_, i) => n0 * (N / n0) ** (i / 47)), e = (n) => 1.959964 * sd * Math.sqrt(N / n);
      return `<path class="${cls}" clip-path="url(#box)" d="${path(k.map((n) => [X(n), Y(ref + e(n))]))}${path(k.map((n) => [X(n), Y(ref - e(n))]))}"/>`;
    };
    s += env(p.real, "env plain") + (sel ? env(c.real, "env mine") : "");
    s += `<line class="exact" x1="${B.x}" x2="${B.x + B.w}" y1="${Y(ref)}" y2="${Y(ref)}"/>` + text(B.x - 10, Y(ref) + 4, fmt(ref, Math.max(2, d + 1)), "tick b", "end");
    const R = B.x + B.w + 10, labels = [{ y: Y(ref), t: `exact`, sub: KIND[spec.product], cls: "b" }];
    labels.push({ y: clampY(Y(ref + 1.959964 * p.real)), t: `Plain ±${(1.96 * p.real).toPrecision(2)}`, sub: "95% at full length", cls: "g" });
    if (sel) labels.push({ y: clampY(Y(ref - 1.959964 * c.real)), t: `${word(sel)} ±${(1.96 * c.real).toPrecision(2)}`, sub: "", cls: "b" });
    labels.sort((a, b) => a.y - b.y).forEach((l, i, a) => { if (i) l.y = Math.max(l.y, a[i - 1].y + (a[i - 1].sub ? 32 : 18)); });
    if (small) { labels.forEach((l) => { l.t = l.t.replace(/^.* (±\S+)$/, "$1"); l.sub = ""; }); labels.forEach((l, i, a) => { if (i) l.y = Math.max(l.y, a[i - 1].y + 16); }); }
    for (const l of labels) if (l.y > B.y - 2 && l.y < B.y + B.h + 2) s += text(R, l.y + 4, esc(l.t), "lab " + l.cls) + (l.sub ? text(R, l.y + 18, esc(l.sub), "lab sub") : "");
    const total = both.reduce((t, [e]) => t + e.list.length, 0), label = () => { const k = both.reduce((t, [e]) => t + e.got.filter(Boolean).length, 0); return `Running estimate of ${plain.got.length} independent runs${sel ? " of each" : ""}` + (k < total ? `, ${k} of ${total} landed` : ""); };
    s += `<text id="runs-lab" x="${B.x}" y="${B.y - 12}" class="lab sub">${label()}</text>`;
    s += `<g id="cursor" class="cursor" hidden><line y1="${B.y}" y2="${B.y + B.h}"/><g class="readout"><rect rx="6" height="${sel ? 58 : 40}"/><text class="r0" y="17"></text><text class="r1" y="35"></text><text class="r2" y="52"></text></g></g><rect class="hover" x="${B.x}" y="${B.y}" width="${B.w}" height="${B.h}"/>`;
    svg().innerHTML = s;
    const cur = document.getElementById("cursor"), at = (e, n) => { // the spread seen across the runs near n paths
      const v = [];
      for (const r of e.got) { if (!r) continue; let best = r[0]; for (const q of r) if (Math.abs(Math.log(q[0] / n)) < Math.abs(Math.log(best[0] / n))) best = q; v.push(best[1] - ref); }
      return v.length > 2 ? 1.96 * Math.sqrt(v.reduce((a, b) => a + b * b, 0) / v.length) : NaN;
    };
    svg().querySelector(".hover").onpointermove = (ev) => {
      const box = svg().getBoundingClientRect(), x = Math.max(B.x, Math.min(B.x + B.w, ev.clientX - box.left)), n = n0 * (N / n0) ** ((x - B.x) / B.w);
      cur.removeAttribute("hidden");
      cur.querySelector("line").setAttribute("x1", x); cur.querySelector("line").setAttribute("x2", x);
      const t = cur.querySelectorAll("text"), g = cur.querySelector(".readout"), sp = at(plain, n);
      t[0].textContent = `${Math.round(n).toLocaleString("en")} paths: 95% of runs within`;
      t[1].textContent = `Plain ±${sp.toPrecision(2)}   (theory ±${(1.96 * p.real * Math.sqrt(N / n)).toPrecision(2)})`;
      t[2].textContent = sel ? `${word(sel)} ±${at(mine, n).toPrecision(2)}   (theory ±${(1.96 * c.real * Math.sqrt(N / n)).toPrecision(2)})` : "";
      const w = Math.max(...[...t].map((el) => el.getComputedTextLength())) + 22, gx = x + 12 + w > B.x + B.w ? x - 12 - w : x + 12;
      g.setAttribute("transform", `translate(${gx} ${B.y + 6})`); g.querySelector("rect").setAttribute("width", w); t.forEach((el) => el.setAttribute("x", 11));
    };
    svg().querySelector(".hover").onpointerleave = () => cur.setAttribute("hidden", "");

    ctx.tools(`<button type="button" class="tool" id="t-zoom" aria-pressed="${Boolean(z)}"${sel ? "" : " disabled"}>Magnify ${sel ? Math.max(1, Math.round(p.real / c.real)) + "×" : ""}</button><button type="button" class="tool" id="t-again">New runs</button>`);
    document.getElementById("t-zoom").onclick = () => { zoom = !zoom; race({ ...ctx, mode: "zoom" }); };
    document.getElementById("t-again").onclick = () => { shift++; race({ ...ctx, mode: "fresh" }); };
    const who = sel ? `${plain.got.length} plain runs in grey and ${plain.got.length} ${word(sel)} runs in ink` : `${plain.got.length} plain runs`;
    ctx.caption(`Each line is one run of ${N.toLocaleString("en")} paths, its estimate redrawn as paths are added: ${who}. Dashed curves are ±1.96 standard errors, which shrink like 1/√n; about 95% of the lines should end inside them. Variance reduction narrows the funnel and keeps its shape.${mid !== ref ? " " + biasNote(ctx) : ""}`);
  }
  // Biased estimators converge to their own mean; centre the plot between that and the exact price.
  function biasedMid(ctx, c) { return ctx.spec.product === "american" || (ctx.spec.product === "barrier" && ctx.spec.mode !== "bridge") ? (ctx.ref + c.mean) / 2 : ctx.ref; }
  function biasNote(ctx) { return ctx.spec.product === "american" ? "The lines settle slightly below the lattice price: a fitted exercise rule is never better than the best one." : "The lines settle away from the exact price: a grid of dates misses crossings between them."; }

  // ------------------------------------------------------------------ paths
  const NP = 2048;
  let P = null; // simulated normals, kept so that a drag only rescales

  async function simulate(ctx) {
    const { spec, sel, base } = ctx, m = isFlat(spec.product) ? 64 : Math.min(64, spec.m), seed = base.seed;
    const anti = sel & 1, half = anti ? NP / 2 : NP, strat = sel & 4;
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
  const zOf = (p) => { const t = Math.sqrt(-2 * Math.log(Math.min(p, 1 - p))), v = t - (2.515517 + 0.802853 * t + 0.010328 * t * t) / (1 + 1.432788 * t + 0.189269 * t * t + 0.001308 * t ** 3); return p < 0.5 ? -v : v; };
  function develop(spec) { // log(S/S0) for every path from the stored normals and the current parameters
    const { z, jn, m, half } = P.raw, dt = spec.T / m, sd = spec.sigma * Math.sqrt(dt), k = spec.lam ? Math.exp(spec.muJ + spec.delta ** 2 / 2) - 1 : 0;
    const drift = (spec.r - spec.q - spec.sigma ** 2 / 2 - (spec.lam || 0) * k) * dt, X = new Float32Array(NP * (m + 1)), cut = spec.lam ? spec.lam * dt : 0, thr = cut ? zOf(1 - cut) : 9;
    for (let i = 0; i < NP; i++) {
      const src = i < half ? i : i - half, sg = i < half ? 1 : -1;
      let x = 0;
      for (let j = 0; j < m; j++) {
        x += drift + sd * sg * z[src * m + j];
        if (cut && jn[2 * (i * m + j)] > thr) x += spec.muJ + spec.delta * jn[2 * (i * m + j) + 1];
        X[i * (m + 1) + j + 1] = x;
      }
    }
    return X;
  }

  async function paths(ctx) {
    show("plot");
    const { spec, sel, base } = ctx, key = JSON.stringify([spec.product, spec.m, spec.lam ? 1 : 0, base.seed, sel & 5, spec.product === "american" ? spec : 0]);
    if (!P || P.key !== key || ctx.mode === "fresh") {
      const raw = await simulate(ctx);
      if (!ctx.alive()) return;
      P = { raw, key };
    }
    ctx.wait("");
    const { m, pol, anti, strat, half } = P.raw, X = develop(spec), W = Ink.width, H = Ink.height, small = W < 640;
    const hist = Math.max(64, W * 0.17), B = { x: small ? 50 : 70, y: 26, w: W - (small ? 50 : 70) - hist - 18, h: H - 26 - 46 };
    const end = Float32Array.from({ length: NP }, (_, i) => X[i * (m + 1) + m]).sort(), marks = [spec.S0, spec.K].concat(spec.H || []);
    if (ctx.mode !== "drag" || !P.scale) P.scale = { lo: Math.min(spec.S0 * Math.exp(end[Math.floor(NP * 0.005)]), ...marks.map((v) => v * 0.985)), hi: Math.max(spec.S0 * Math.exp(end[Math.floor(NP * 0.995)]), ...marks.map((v) => v * 1.015)) };
    const { lo, hi } = P.scale, Y = (v) => B.y + B.h * (1 - (v - lo) / (hi - lo)), inv = (y) => lo + (hi - lo) * (1 - (y - B.y) / B.h);
    const kind = new Uint8Array(NP), stop = new Int16Array(NP), set = [];
    const bins = 44, load = [new Int32Array(bins), new Int32Array(bins), new Int32Array(bins)];
    let paid = 0, dead = 0, early = 0;
    for (let i = 0; i < NP; i++) {
      const o = i * (m + 1), pts = [];
      let avg = 0, hit = false, ex = 0;
      for (let j = 0; j <= m; j++) {
        const s = spec.S0 * Math.exp(X[o + j]);
        if (!ex) pts.push(B.x + (B.w * j) / m, Math.max(B.y - 60, Math.min(B.y + B.h + 60, Y(s))));
        if (j) avg += s;
        if (spec.product === "barrier" && (spec.down ? s <= spec.H : s >= spec.H)) hit = true;
        if (pol && j && j < m && !ex) { const x = s / spec.K, q = 4 * (j - 1); if (x < 1 && 1 - x > pol[q] + x * (pol[q + 1] + x * (pol[q + 2] + x * pol[q + 3]))) ex = j; }
      }
      const sT = spec.S0 * Math.exp(X[o + m]), v = spec.product === "asian" ? avg / m : sT, pays = ex || (spec.call ? v > spec.K : v < spec.K), live = spec.product !== "barrier" || hit === spec.knockIn;
      stop[i] = ex;
      kind[i] = !live ? 2 : pays ? 1 : 0;
      if (ex) early++;
      if (kind[i] === 1) paid++;
      if (kind[i] === 2) dead++;
      if (!ex) { const b = Math.max(0, Math.min(bins - 1, Math.floor(((Y(sT) - B.y) / B.h) * bins))); load[kind[i]][b]++; }
      set.push({ pts, color: kind[i] === 2 ? RED : kind[i] === 1 ? INK : PALE, alpha: kind[i] === 1 ? 0.04 : kind[i] === 2 ? 0.09 : 0.075, width: 0.9, delay: (i % 97) * 2.4 });
    }
    if (anti) { const i = Math.floor(half * 0.37); for (const j of [i, i + half]) set.push({ pts: set[j].pts, color: [0.086, 0.341, 0.788], alpha: 1, width: 2.2, delay: 260 }); }
    Ink.draw(set, { clip: [0, B.y - 2, B.x + B.w + 1, B.h + 4], key: "paths" + key + set.length, morph: ctx.mode === "drag" ? 90 : ctx.mode === "still" ? 350 : 0, reveal: 1100 });

    let s = "";
    for (const v of ticks(lo, hi, small ? 5 : 7)) { const y = Y(v); s += `<line class="grid" x1="${B.x}" x2="${B.x + B.w}" y1="${y}" y2="${y}"/>`; if (Math.abs(y - Y(spec.S0)) > 24) s += text(B.x - 10, y + 4, v.toLocaleString("en"), "tick", "end"); }
    for (const t of ticks(0, spec.T, small ? 3 : 6)) s += text(B.x + (B.w * t) / spec.T, B.y + B.h + 20, t ? +t.toFixed(2) + (Math.abs(t - spec.T) < 1e-9 ? " yr" : "") : "today", "tick", t && Math.abs(t - spec.T) < 1e-9 ? "end" : "middle");
    // terminal distribution, split by outcome
    const peak = Math.max(1, ...Array.from({ length: bins }, (_, b) => load[0][b] + load[1][b] + load[2][b])), hx = B.x + B.w + 14, hw = hist - 8, bh = B.h / bins;
    for (let b = 0; b < bins; b++) {
      let x = hx;
      for (const [k, cls] of [[1, "h-pay"], [0, "h-no"], [2, "h-out"]]) { const w = (load[k][b] / peak) * hw; if (w > 0) s += `<rect class="${cls}" x="${x.toFixed(1)}" y="${(B.y + b * bh + 0.5).toFixed(1)}" width="${w.toFixed(1)}" height="${Math.max(0.5, bh - 1).toFixed(1)}"/>`; x += w; }
    }
    s += `<line class="axis" x1="${hx - 4}" x2="${hx - 4}" y1="${B.y}" y2="${B.y + B.h}"/>`;
    if (strat) for (let h = 1; h < 32; h++) { const y = Y(spec.S0 * Math.exp(end[Math.floor((NP * h) / 32)])); s += `<line class="strata" x1="${hx - 10}" x2="${hx + 2}" y1="${y}" y2="${y}"/>`; }
    const cone = (sg) => path(Array.from({ length: 31 }, (_, i) => { const t = (spec.T * i) / 30; return [B.x + (B.w * i) / 30, Y(spec.S0 * Math.exp(sg * spec.sigma * Math.sqrt(t)))]; }));
    s += `<path class="cone" d="${cone(1)}${cone(-1)}"/>`;
    s += `<line class="level" x1="${B.x}" x2="${B.x + B.w}" y1="${Y(spec.K)}" y2="${Y(spec.K)}"/>`;
    if (spec.H) s += `<line class="barrier" x1="${B.x}" x2="${B.x + B.w}" y1="${Y(spec.H)}" y2="${Y(spec.H)}"/>`;
    const tab = (id, x, v, label, name, val, align) => { const y = Y(v), w = label.length * 6.9 + 18, x0 = align === "end" ? x - w : x; return `<g class="grab" id="g-${id}" tabindex="0" role="slider" aria-orientation="vertical" aria-label="${name}" aria-valuenow="${val}" transform="translate(0 ${y.toFixed(1)})"><rect class="hit" x="${x0 - 8}" y="-18" width="${w + 16}" height="36"/><rect class="tab" x="${x0}" y="-11" width="${w}" height="22" rx="4"/><text x="${x0 + w / 2}" y="4" text-anchor="middle">${label}</text></g>`; };
    const volY = Math.min(hi, spec.S0 * Math.exp(spec.sigma * Math.sqrt(spec.T)));
    s += tab("sigma", B.x + B.w - 6, volY, `vol ${(100 * spec.sigma).toFixed(1)}%`, "Volatility", (100 * spec.sigma).toFixed(1), "end") + tab("K", B.x + B.w - 6, spec.K, `strike ${spec.K}`, "Strike", spec.K, "end") + tab("S0", 4, spec.S0, `spot ${spec.S0}`, "Spot", spec.S0, "start");
    if (spec.H) s += tab("H", B.x + B.w - 6, spec.H, `barrier ${spec.H}`, "Barrier", spec.H, "end");
    svg().innerHTML = s;
    handles(ctx, inv);
    ctx.tools(`<button type="button" class="tool" id="t-redraw">New paths</button>`);
    document.getElementById("t-redraw").onclick = () => { const el = document.getElementById("i-seed"); el.value = (Number(el.value) + 1) % 2147483647; el.dispatchEvent(new Event("input", { bubbles: true })); };

    const say = [];
    if (anti) say.push(`<b class="A">A</b> the blue pair are mirror images, and every path has a partner like that`);
    if (strat) say.push(`<b class="S">S</b> the Brownian end points are spread evenly, one to each of 32 slices (green ticks)`);
    if (sel & 2) say.push({ european: `<b class="C">C</b> the discounted spot is tracked on the same paths and its known error subtracted`, merton: `<b class="C">C</b> a quantity with a known mean is tracked on the same paths`, asian: `<b class="C">C</b> the geometric average of each path is priced exactly and its error subtracted`, barrier: `<b class="C">C</b> the vanilla option on the same paths has an exact price, and its error is subtracted`, american: `<b class="C">C</b> the European put is tracked at the moment of exercise` }[spec.product]);
    if (sel & 8) say.push(spec.product === "merton" ? `<b class="K">K</b> the estimator does not need these paths: it draws the jump count and integrates the rest` : `<b class="K">K</b> each path is weighted by its chance of surviving between dates`);
    const count = spec.product === "barrier" ? `${dead.toLocaleString("en")} ${spec.knockIn ? "never knock in" : "are knocked out"} (red), ${paid.toLocaleString("en")} pay (ink).` : spec.product === "american" ? `${early.toLocaleString("en")} are exercised early and stop where they were exercised.` : `${paid.toLocaleString("en")} finish in the money (ink).`;
    ctx.caption(`${NP.toLocaleString("en")} paths on ${m} dates from the engine’s own generator. ${count} Drag the tabs to move spot, strike${spec.H ? ", barrier" : ""} and volatility.${say.length ? " " + say.join("; ") + "." : ""}`);
  }

  function handles(ctx, inv) {
    for (const id of ["K", "S0", "H", "sigma"]) {
      const g = document.getElementById("g-" + id);
      if (!g) continue;
      const set = (v, end) => ctx.drag(id, v, end);
      g.onkeydown = (e) => {
        const d = { ArrowUp: 1, ArrowRight: 1, ArrowDown: -1, ArrowLeft: -1 }[e.key];
        if (!d) return;
        e.preventDefault();
        const s = ctx.spec;
        set(id === "sigma" ? s.sigma + 0.005 * d : s[id] + d * Math.max(0.01, s.S0 * 0.0025), true);
        requestAnimationFrame(() => document.getElementById("g-" + id)?.focus());
      };
      g.onpointerdown = (e) => {
        e.preventDefault();
        const box = svg().getBoundingClientRect(), s0 = ctx.spec.S0, T = ctx.spec.T, scale = { ...P.scale };
        const from = (ev) => { const v = inv(ev.clientY - box.top); return id === "sigma" ? Math.log(Math.max(v, s0 * 1.005) / s0) / Math.sqrt(T) : v; };
        g.classList.add("held");
        const move = (ev) => { P.scale = scale; set(from(ev), false); };
        const up = (ev) => { removeEventListener("pointermove", move); removeEventListener("pointerup", up); removeEventListener("pointercancel", up); set(from(ev), true); };
        addEventListener("pointermove", move);
        addEventListener("pointerup", up);
        addEventListener("pointercancel", up);
      };
    }
  }

  // ------------------------------------------------------------------ market
  let expiry = null;
  async function market(ctx) {
    show("plot");
    ctx.wait("");
    Ink.clear();
    const m = ctx.market, W = Ink.width, H = Ink.height, small = W < 760, S = m.smiles;
    const cur = S.find((q) => q.expiry === expiry) || S.reduce((a, b) => (Math.abs(b.T - 0.33) < Math.abs(a.T - 0.33) ? b : a));
    expiry = cur.expiry;
    const A = small ? { x: 50, y: 34, w: W - 70, h: H * 0.5 - 60 } : { x: 64, y: 34, w: W * 0.58 - 64, h: H - 34 - 48 };
    const Bx = small ? 50 : A.x + A.w + 72, Bw = small ? W - 70 : W - Bx - 28, Bt = small ? A.y + A.h + 64 : 34, Bh = small ? H - Bt - 40 : (H - 34 - 48 - 56) / 2, Ct = Bt + Bh + 56;
    // smile
    const mk = cur.K.map((v) => v / cur.forward), ilo = Math.max(0, Math.min(...cur.iv, cur.atm) * 0.86), ihi = Math.max(...cur.iv) * 1.06, xlo = Math.min(...mk) - 0.01, xhi = Math.max(...mk) + 0.01;
    const X = (v) => A.x + ((v - xlo) / (xhi - xlo)) * A.w, Y = (v) => A.y + A.h - ((v - ilo) / (ihi - ilo)) * A.h;
    let s = text(A.x, A.y - 14, `Implied volatility, ${cur.expiry} expiry, ${cur.K.length} quotes`, "lab sub");
    for (const v of ticks(ilo, ihi, 5)) { const y = Y(v); if (y < A.y || y > A.y + A.h) continue; s += `<line class="grid" x1="${A.x}" x2="${A.x + A.w}" y1="${y}" y2="${y}"/>` + text(A.x - 10, y + 4, Math.round(100 * v) + "%", "tick", "end"); }
    for (const v of ticks(xlo, xhi, small ? 4 : 6)) s += text(X(v), A.y + A.h + 20, v.toFixed(2), "tick", "middle");
    s += text(A.x + A.w, A.y + A.h + 38, "strike ÷ forward", "tick", "end");
    const fit = cur.model.map((v, i) => [X(mk[i]), Y(v)]).filter((q) => Number.isFinite(q[1]));
    s += `<line class="flat" x1="${A.x}" x2="${A.x + A.w}" y1="${Y(cur.atm)}" y2="${Y(cur.atm)}"/>` + text(A.x + 6, Y(cur.atm) - 8, "one volatility (Black–Scholes)", "lab sub halo", "start");
    s += `<path class="fit" d="${path(fit)}"/>`;
    s += `<g id="quotes">` + cur.K.map((_, i) => `<circle class="q" cx="${X(mk[i]).toFixed(1)}" cy="${Y(cur.iv[i]).toFixed(1)}" r="3.2"/>`).join("") + `</g>`;
    // two years of closes
    const cl = m.close, n = cl.length, clo = Math.min(...cl), chi = Math.max(...cl), CX = (i) => Bx + (i / (n - 1)) * Bw, CY = (v) => Bt + Bh - ((v - clo) / (chi - clo)) * Bh;
    s += text(Bx, Bt - 14, `${m.ticker}, ${n} daily closes`, "lab sub");
    for (const v of ticks(clo, chi, 3)) { const y = CY(v); if (y < Bt || y > Bt + Bh) continue; s += `<line class="grid" x1="${Bx}" x2="${Bx + Bw}" y1="${y}" y2="${y}"/>` + text(Bx - 8, y + 4, Math.round(v).toLocaleString("en"), "tick", "end"); }
    s += `<path class="close" d="${path(cl.map((v, i) => [CX(i), CY(v)]))}"/>` + text(Bx, Bt + Bh + 18, m.dates[0], "tick") + text(Bx + Bw, Bt + Bh + 18, m.dates[n - 1], "tick", "end");
    // daily returns against a normal
    const r = cl.slice(1).map((c, i) => Math.log(c / cl[i])), mu = r.reduce((a, b) => a + b, 0) / r.length, sd = Math.sqrt(r.reduce((a, b) => a + (b - mu) ** 2, 0) / r.length), zs = r.map((v) => (v - mu) / sd), kurt = zs.reduce((a, v) => a + v ** 4, 0) / zs.length - 3;
    if (!small) {
      const bins = 40, lo = -6, hi = 6, cnt = new Int32Array(bins); zs.forEach((v) => cnt[Math.max(0, Math.min(bins - 1, Math.floor(((v - lo) / (hi - lo)) * bins)))]++);
      const peak = Math.max(...cnt, (r.length * ((hi - lo) / bins)) / Math.sqrt(2 * Math.PI)), RX = (v) => Bx + ((v - lo) / (hi - lo)) * Bw, RH = (c) => (c / peak) * Bh;
      s += text(Bx, Ct - 14, `Daily returns in standard deviations; the curve is a normal`, "lab sub");
      for (let b = 0; b < bins; b++) if (cnt[b]) { const x0 = RX(lo + (b * (hi - lo)) / bins), w = Bw / bins - 1, h = RH(cnt[b]), tail = Math.abs(lo + ((b + 0.5) * (hi - lo)) / bins) > 3; s += `<rect class="${tail ? "h-out" : "h-no"}" x="${x0.toFixed(1)}" y="${(Ct + Bh - h).toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}"/>`; }
      const curve = Array.from({ length: 121 }, (_, i) => lo + (i * (hi - lo)) / 120).map((v) => [RX(v), Ct + Bh - RH((r.length * ((hi - lo) / bins) * Math.exp((-v * v) / 2)) / Math.sqrt(2 * Math.PI))]);
      s += `<path class="normal" d="${path(curve)}"/><line class="axis" x1="${Bx}" x2="${Bx + Bw}" y1="${Ct + Bh}" y2="${Ct + Bh}"/>`;
      for (const v of [-4, -2, 0, 2, 4]) s += text(RX(v), Ct + Bh + 18, v ? minus(String(v)) : "0", "tick", "middle");
    }
    svg().innerHTML = s;
    ctx.tools(`<label class="tool sel"><span class="vh">Expiry</span><select id="t-exp">${S.map((q) => `<option${q === cur ? " selected" : ""}>${q.expiry}</option>`).join("")}</select></label><button type="button" class="tool primary" id="t-fit">Price with this fit</button>`);
    document.getElementById("t-exp").onchange = (e) => { expiry = e.target.value; market({ ...ctx, mode: "fresh" }); };
    document.getElementById("t-fit").onclick = () => ctx.useFit(cur);
    const head = `${m.source === "SNAPSHOT" ? `${m.ticker} at the close of ${m.asof}, from Yahoo Finance; the rate is the three-month Treasury from FRED.` : "A simulated market drawn in your browser, not real data."} Excess kurtosis of daily returns ${kurt.toFixed(1)} (a normal has 0). Merton fit for this expiry: diffusion ${(100 * cur.fit.sigma).toFixed(1)}%, ${cur.fit.lam.toFixed(2)} jumps a year of ${minus((100 * cur.fit.mu_j).toFixed(0))}% ± ${(100 * cur.fit.delta).toFixed(0)}%. It misses the smile by ${(100 * cur.rmse).toFixed(1)} vol points; one volatility misses by ${(100 * cur.rmse_flat).toFixed(1)}.`;
    ctx.caption(head + " Checking each quote against Monte Carlo with the fit…");
    const base = { n: 20000, seed: 7, strata: 64, flags: 15 };
    const inside = await Promise.all(cur.K.map((k, i) => Engine.call("estimate", { ...base, spec: { product: "merton", call: Boolean(cur.call[i]), S0: m.spot, K: k, T: cur.T, r: m.rate, q: cur.q, m: 1, sigma: cur.fit.sigma, lam: cur.fit.lam, muJ: cur.fit.mu_j, delta: cur.fit.delta } }).then((e) => e.price >= cur.bid[i] && e.price <= cur.ask[i]))).catch(() => null);
    if (!inside || !ctx.alive() || expiry !== cur.expiry) return;
    const dots = document.querySelectorAll("#quotes circle");
    inside.forEach((ok, i) => dots[i]?.classList.toggle("miss", !ok));
    const k = inside.filter(Boolean).length;
    ctx.caption(`${head} Priced by Monte Carlo with the fit, ${k} of ${cur.K.length} quotes land between bid and ask (ink) and ${cur.K.length - k} fall outside (red).`);
  }

  // ------------------------------------------------------------------ method notes
  function notes(ctx) {
    show("sheet");
    Ink.clear();
    ctx.wait("");
    ctx.tools("");
    document.getElementById("sheet").innerHTML = `<p class="lead">${NOTES.product[ctx.spec.product]}</p>` + NOTES.html;
    ctx.caption("");
  }

  return { board, race, paths, market, notes };
})();
