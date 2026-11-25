// The story: scroll-driven chapters that steer the Galton board, fill the live numbers and run the little widgets.
// It reuses helpers from app.js (big, word, dots) and talks to the engine on its own channel, "story", so the lab's
// recompute never cancels it.
"use strict";

(() => {
  const $ = (id) => document.getElementById(id);
  const all = (sel, root = document) => [...root.querySelectorAll(sel)];
  const fixed = (x, d) => Number(x.toFixed(d));
  const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;
  const MINUS = (s) => String(s).replace(/-/g, "−");
  const eng = (op, args) => Engine.call(op, args, undefined, "story");
  const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

  // ---------------------------------------------------------------- the story's own contracts, from the snapshot
  const M = window.MARKET.SPY;
  const smile = M.smiles.reduce((a, b) => (Math.abs(b.T - 120 / 365) < Math.abs(a.T - 120 / 365) ? b : a));
  const S0 = fixed(M.spot, 2), K = Math.round(M.spot), T = 0.5, r = fixed(100 * M.rate, 2) / 100, q = fixed(100 * M.q, 2) / 100;
  const GBM = { product: "european", call: true, S0, K, T, r, q, sigma: fixed(100 * smile.atm, 1) / 100, m: 1 };
  const JUMP = { product: "merton", call: true, S0, K, T, r, q, sigma: fixed(100 * smile.fit.sigma, 1) / 100, lam: fixed(smile.fit.lam, 2), muJ: fixed(100 * smile.fit.mu_j, 1) / 100, delta: fixed(100 * smile.fit.delta, 1) / 100, m: 1 };
  const SPECS = { GBM, JUMP };
  const BIT = { A: 1, C: 2, S: 4, K: 8 };
  const N = 2000, STRATA = 32;
  let mixSel = 12;

  // step -> [spec, sel]
  const CONFIG = (step) => { const c = ({ A: ["GBM", 1], S: ["GBM", 4], C: ["GBM", 2], K: ["JUMP", 8], mix: ["JUMP", mixSel] })[step] || ["GBM", 0]; return off[step] ? [c[0], 0] : c; };

  // ---------------------------------------------------------------- numbers that need no engine
  const live = (key, text) => all(`[data-live="${key}"]`).forEach((el) => { el.textContent = text; });
  live("ticker", "SPY");
  live("S0", S0.toLocaleString("en", { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
  live("K", K.toLocaleString("en"));
  live("T", T === 0.5 ? "half a year" : `${T} years`);
  live("N", N.toLocaleString("en"));
  live("lam", JUMP.lam.toFixed(2));
  live("muJ", `${Math.abs(Math.round(100 * JUMP.muJ))}%`);

  // ---------------------------------------------------------------- honest errors (the lab's rule, in app.js recompute)
  function honest(g) {
    const price = [...g.price], reps = price.length, mu = mean(price), reported = mean([...g.se].map((v) => v * v));
    const seen = price.reduce((s, v) => s + (v - mu) ** 2, 0) / (reps - 1);
    const short = seen > Math.max(1.25, 1 + 3.2 * Math.sqrt(2 / reps)) * reported;
    return { real: Math.sqrt(Math.max(short ? seen : reported, 1e-30)), paths: g.paths };
  }
  const memo = new Map();
  const once = (key, make) => { if (!memo.has(key)) memo.set(key, make()); return memo.get(key); };
  const exactOf = (name) => once("exact" + name, () => eng("reference", { spec: SPECS[name] }));
  const errOf = (name, flags, reps = 200) => once(`err${name}${flags}${reps}`, () => eng("replicate", { spec: SPECS[name], flags, n: N, strata: STRATA, seed: 101, reps }).then(honest));
  const pm = (e) => `±${(1.96 * e.real).toPrecision(2)}`;
  // one format for every factor: 7.8×, 10×, 313×, 3,260×
  const fx = (f) => (f < 9.95 ? f.toFixed(1) : Math.round(f).toLocaleString("en")) + "×";
  const factor = (p, e) => (p.real ** 2 * p.paths) / (e.real ** 2 * e.paths);

  const settled = {}, settledErr = {}; // exact prices and plain 95% errors once known
  const trickBase = {}, trickExtra = {}, off = { A: false, S: false, C: false, K: false };
  const MISS = " This particular run happened to miss by more; the \u00b1 describes a typical run.";
  const renderTrick = (l) => live("trick:" + l, off[l] ? "Showing plain balls for comparison." : (trickBase[l] || "") + (trickExtra[l] || ""));
  exactOf("GBM").then((v) => { settled.GBM = v; live("exact", v.toFixed(2)); }, () => {});
  exactOf("JUMP").then((v) => { settled.JUMP = v; }, () => {});
  for (const name of ["GBM", "JUMP"]) errOf(name, 0).then((e) => { settledErr[name] = 1.96 * e.real; }, () => {});
  errOf("GBM", 0).then((p) => live("err:0", pm(p)), () => {});
  for (const [l, name] of [["A", "GBM"], ["S", "GBM"], ["C", "GBM"], ["K", "JUMP"]]) {
    Promise.all([errOf(name, 0), errOf(name, BIT[l])]).then(([p, e]) => {
      const f = factor(p, e), was = pm(p), now = pm(e);
      trickBase[l] = f < 0.95 ? `Here it makes things worse: ${was} becomes ${now}.` : f < 1.08 ? `Here it barely helps: ${was} becomes ${now}.`
        : `Same ${N.toLocaleString("en")} balls: the error drops from ${was} to ${now}. That is as good as ${fx(f)} more plain balls.`;
      renderTrick(l);
    }, () => {});
  }

  // ---------------------------------------------------------------- the board
  let board = null, cur = null, token = 0, active = "hero", lastDrop = 0;
  const traces = new Map();
  const traceOf = (name, flags) => once(`trace${name}${flags}`, () => eng("race", { spec: SPECS[name], flags, n: N, strata: STRATA, seed: 11, points: 64 }));

  function configure(step) {
    if (!board) return Promise.resolve();
    const [name, sel] = CONFIG(step), key = name + sel;
    if (cur && cur.key === key) return cur.ready;
    const spec = SPECS[name], mine = ++token, exact = settled[name] ?? NaN, E = settledErr[name];
    const cfg = (ex, e) => ({ spec, sel, seed: 7, exact: ex, ...(Number.isFinite(ex) && Number.isFinite(e) ? { gaugeRange: [ex - 1.6 * e, ex + 1.6 * e] } : {}) });
    board.set(cfg(exact, E));
    const c = (cur = { key, name, sel });
    c.ready = Promise.all([exactOf(name), errOf(name, 0), traceOf(name, sel), sel ? traceOf(name, 0) : null]).then(([ex, pe, t, plain]) => {
      if (mine !== token) return;
      if (!(exact === ex && E === 1.96 * pe.real)) board.set(cfg(ex, 1.96 * pe.real));
      board.setTrace(t, word(sel));
      board.setCompare(sel ? plain : null);
    }).catch((e) => { if (e.message !== "stale") console.error(e); });
    return c.ready;
  }

  function setActive(step) {
    if (step !== active && step in off) { off[step] = false; trickExtra[step] = ""; renderTrick(step); toggleLabel(step); }
    active = step;
    all(".step").forEach((s) => s.classList.toggle("on", s.dataset.step === step));
    document.body.dataset.step = step;
    return configure(step);
  }

  // ---------------------------------------------------------------- which chapter is on screen
  function watchSteps() {
    const steps = all(".step"), crossing = new Set();
    const io = new IntersectionObserver((es) => {
      es.forEach((e) => (e.isIntersecting ? crossing.add(e.target) : crossing.delete(e.target)));
      const now = steps.find((s) => crossing.has(s));
      if (now && now.dataset.step !== active) { setActive(now.dataset.step); onEnter(now.dataset.step); }
    }, { rootMargin: "-45% 0px -54% 0px", threshold: 0 });
    steps.forEach((s) => io.observe(s));
  }
  document.body.dataset.step = "hero";
  all(".step").forEach((s) => s.classList.toggle("on", s.dataset.step === "hero"));

  let cloudStarted = false;
  let auto = Promise.resolve(), singles = 0, cleared = false;
  const toggleLabel = (l) => all(`section[data-step="${l}"] [data-act="toggle"] span`).forEach((x) => { x.textContent = `Turn ${l} ${off[l] ? "on" : "off"}`; });
  // a drop the page makes on its own; it never writes the lastBall readout
  function autoDrop(n) {
    auto = (async () => {
      try { await cur.ready; lastDrop = n; await board.drop(n, { pace: "rain" }); } catch (e) { if (e && e.message !== "stale") console.error(e); }
    })();
    return auto;
  }
  function onEnter(step) {
    if (step === "cost" && !cloudStarted) { cloudStarted = true; cloudStart(); }
    if (step === "mix" && board && board.count === 0) autoDrop(2000);
  }

  // ---------------------------------------------------------------- drop buttons
  const gate = window.ready.then(() => true, () => false);
  function wireDrops() {
    all('[data-act="drop"][data-n]').forEach((b) => {
      b.addEventListener("click", async () => {
        if (b.getAttribute("aria-busy") === "true" || !board) return;
        const n = Number(b.dataset.n), step = b.closest(".step").dataset.step;
        b.setAttribute("aria-busy", "true");
        try {
          if (step !== active) await setActive(step); else await cur.ready;
          await auto; // let a drop the page started finish first
          if (n === 1 && !cleared) { cleared = true; board.clear(); } // the first single ball lands on an empty heap
          lastDrop = n;
          if (n === 1) singles++;
          if (step in off) { trickExtra[step] = ""; renderTrick(step); }
          await board.drop(n);
          if (step in off) await verdict(step, n);
        } catch (e) { if (e && e.message !== "stale") console.error(e); } finally { b.removeAttribute("aria-busy"); }
      });
    });
  }

  // after a trick chapter's drop: say so when this run's needle ended farther off than plain's
  async function verdict(step, n) {
    if (n < N || off[step] || step !== active) return;
    const [name, sel] = CONFIG(step), key = cur && cur.key;
    const [mine, plain] = await Promise.all([traceOf(name, sel), traceOf(name, 0)]), ex = settled[name];
    if (step !== active || (cur && cur.key !== key) || !Number.isFinite(ex)) return;
    if (Math.abs(mine[mine.length - 1][1] - ex) > Math.abs(plain[plain.length - 1][1] - ex)) { trickExtra[step] = MISS; renderTrick(step); }
  }
  function wireToggles() {
    all('[data-act="toggle"]').forEach((b) => {
      b.addEventListener("click", async () => {
        if (b.getAttribute("aria-busy") === "true" || !board) return;
        const step = b.closest(".step").dataset.step;
        b.setAttribute("aria-busy", "true");
        try {
          if (step !== active) await setActive(step);
          await auto;
          off[step] = !off[step];
          trickExtra[step] = "";
          toggleLabel(step);
          renderTrick(step);
          await setActive(step);
          await cur.ready;
          lastDrop = N;
          await board.drop(N);
          await verdict(step, N);
        } catch (e) { if (e && e.message !== "stale") console.error(e); } finally { b.removeAttribute("aria-busy"); }
      });
    });
  }

  function wireLanding() {
    board.on("land", (e) => {
      if (lastDrop !== 1 || !e) return;
      const last = (v) => (v != null && typeof v === "object" && "length" in v ? v[v.length - 1] : v);
      const st = last(e.ST);
      if (!Number.isFinite(st)) return;
      const f = (x) => x.toLocaleString("en", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      const ex = settled[cur ? cur.name : "GBM"], wild = singles === 1 && Number.isFinite(ex) ? ` One ball is a wild guess: the true price is ${f(ex)}.` : "";
      live("lastBall", (st > K ? `This ball landed at ${f(st)}, so the option pays ${f(st - K)}.` : `This ball landed at ${f(st)}, below the strike, so the option pays nothing.`) + wild);
    });
  }

  // ---------------------------------------------------------------- the cloud of experiments: four rows, one shared scale
  const NS = "http://www.w3.org/2000/svg", ROWS = [500, 2000, 8000, 32000], PITCH = 46, TOP = 36, CH = 208, LEFT = 74, RIGHT = 52, DOTS = 40;
  const cloud = { W: 0, svg: null, rows: [], data: [], runs: [0, 0, 0, 0], exact: NaN, half: NaN };
  const svgEl = (tag, attrs = {}, parent) => { const el = document.createElementNS(NS, tag); for (const k in attrs) el.setAttribute(k, attrs[k]); if (parent) parent.appendChild(el); return el; };
  const jit = (i) => ((((i + 1) * 2654435761) >>> 0) % 997) / 997;

  function cloudBuild() {
    const host = $("cloud");
    if (!host) return;
    cloud.W = Math.max(240, host.clientWidth);
    host.textContent = "";
    const s = (cloud.svg = svgEl("svg", { width: "100%", height: CH, viewBox: `0 0 ${cloud.W} ${CH}`, role: "img", "aria-label": "Four rows of 40 experiments each" }, host));
    s.style.display = "block";
    s.style.overflow = "visible";
    const tr = reduced() ? "none" : "transform 500ms ease", mid = LEFT + (cloud.W - LEFT - RIGHT) / 2;
    cloud.mid = mid;
    cloud.line = svgEl("line", { x1: mid, x2: mid, y1: 18, y2: CH - 6, stroke: "#f2c200", "stroke-width": 3 }, s);
    cloud.tag = svgEl("text", { x: mid + 7, y: 12, class: "lab" }, s);
    cloud.tag.textContent = "true price";
    cloud.rows = ROWS.map((n, r) => {
      const y = TOP + r * PITCH, g = svgEl("g", {}, s);
      const name = svgEl("text", { x: 0, y: y + 4, class: "lab" }, g);
      name.textContent = `${n.toLocaleString("en")} balls`;
      const dots = Array.from({ length: DOTS }, (_, i) => {
        const c = svgEl("circle", { r: 3.5, cx: 0, cy: 0, fill: "#14171a", "fill-opacity": 0.55 }, g), dy = y - 13 + 22 * jit(i * 7 + r);
        c.style.transition = tr; c.dataset.y = dy; c.style.transform = `translate(${mid}px, ${dy}px)`;
        return c;
      });
      const brk = svgEl("path", { d: "M0 0V6H1V0", fill: "none", stroke: "#14171a", "stroke-width": 1.4, "vector-effect": "non-scaling-stroke" }, g);
      brk.style.transition = tr; brk.style.transform = `translate(${mid}px, ${y + 14}px) scaleX(0)`;
      const lab = svgEl("text", { x: cloud.W, y: y + 18, class: "lab b", "text-anchor": "end" }, g);
      return { n, y, dots, brk, lab };
    });
  }
  function cloudDraw(r) {
    const prices = cloud.data[r];
    if (!cloud.svg || !prices || !Number.isFinite(cloud.half)) return;
    const row = cloud.rows[r], span = (cloud.W - LEFT - RIGHT) / 2 - 4, X = (v) => Math.max(LEFT + 4, Math.min(cloud.W - RIGHT - 4, cloud.mid + ((v - cloud.exact) / cloud.half) * span));
    row.dots.forEach((c, i) => { c.style.transform = `translate(${X(prices[i]).toFixed(1)}px, ${c.dataset.y}px)`; });
    const p = [...prices].sort((a, b) => a - b), at = (f) => { const x = f * (p.length - 1), i = Math.floor(x); return p[i] + (p[Math.min(i + 1, p.length - 1)] - p[i]) * (x - i); };
    const lo = at(0.025), hi = at(0.975), x1 = X(lo), x2 = X(hi), e = (hi - lo) / 2;
    row.brk.style.transform = `translate(${x1.toFixed(1)}px, ${row.y + 14}px) scaleX(${Math.max(1, x2 - x1).toFixed(1)})`;
    row.lab.textContent = `\u00b1${e.toPrecision(2)}`;
    row.err = e;
    cloud.svg.setAttribute("aria-label", "Four rows of 40 experiments: " + cloud.rows.map((q) => (q.err != null ? `${q.n.toLocaleString("en")} balls, the middle 95% within \u00b1${q.err.toPrecision(2)}` : "")).filter(Boolean).join("; ") + ".");
  }
  async function cloudRun(r) {
    const run = ++cloud.runs[r], seed = 202 + r + 1000 * (run - 1);
    try {
      const g = await eng("replicate", { spec: GBM, flags: 0, n: ROWS[r], strata: STRATA, seed, reps: DOTS });
      if (run !== cloud.runs[r]) return;
      cloud.data[r] = [...g.price];
      cloudDraw(r);
    } catch (e) { if (e.message !== "stale") console.error(e); }
  }
  async function cloudStart() {
    if (!cloud.svg) cloudBuild();
    try {
      const [exact, base] = await Promise.all([exactOf("GBM"), errOf("GBM", 0)]);
      cloud.exact = exact;
      cloud.half = 1.6 * 1.96 * base.real * Math.sqrt(N / 500); // one fixed scale: 1.6 times the 95% error at 500 balls
      ROWS.forEach((_, r) => cloudRun(r));
    } catch (e) { if (e.message !== "stale") console.error(e); }
  }
  function cloudPick(i) {
    all('[data-act="cloud"]').forEach((b, k) => { b.setAttribute("aria-checked", k === i); b.tabIndex = k === i ? 0 : -1; });
    if (cloud.svg && Number.isFinite(cloud.half)) cloudRun(i);
  }
  function wireCloud() {
    const radios = all('[data-act="cloud"]');
    radios.forEach((b, i) => {
      b.setAttribute("aria-checked", i === 0);
      b.tabIndex = i === 0 ? 0 : -1;
      b.addEventListener("click", () => cloudPick(i));
      b.addEventListener("keydown", (e) => {
        const d = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
        if (!d) return;
        e.preventDefault();
        const k = (i + d + radios.length) % radios.length;
        radios[k].focus();
        cloudPick(k);
      });
    });
    if ($("cloud")) {
      let last = 0;
      new ResizeObserver(() => { const w = $("cloud").clientWidth; if (!w || Math.abs(w - last) < 2) return; last = w; if (cloud.svg) { cloudBuild(); ROWS.forEach((_, r) => cloudDraw(r)); } }).observe($("cloud"));
    }
  }

  // ---------------------------------------------------------------- the ranking of combinations
  async function ranking() {
    const host = $("story-rank");
    if (!host) return;
    const flags = Array.from({ length: 16 }, (_, f) => f), reps = 120;
    const got = await Promise.all(flags.map((f) => eng("replicate", { spec: JUMP, flags: f, n: N, strata: STRATA, seed: 101, reps }).then(honest)));
    const p = got[0], vrf = got.map((e) => factor(p, e));
    const rows = flags.map((f) => [f, vrf[f]]).sort((a, b) => b[1] - a[1]), top = Math.max(...rows.map((x) => x[1])), span = Math.log(Math.max(top, 1.5));
    host.innerHTML = rows.map(([f, v]) => {
      const w = v >= 1 ? Math.max(0.6, (100 * Math.log(v)) / span) : 0;
      return `<li><button type="button" data-f="${f}" aria-pressed="${f === mixSel}" aria-label="${word(f)}: ${f ? fx(v) + " fewer paths" : "the yardstick"}"><span class="dots">${f ? dots(f) : '<i class="dot P">–</i>'}</span><span class="name">${f ? word(f) : "Plain"}</span><span class="track"><i style="width:${w.toFixed(1)}%"></i></span><span class="x${v < 0.95 ? " worse" : ""}">${f ? (v < 0.95 ? "worse" : fx(v)) : "1×"}</span></button></li>`;
    }).join("");
    host.addEventListener("click", async (e) => {
      const b = e.target.closest("button[data-f]");
      if (!b) return;
      mixSel = Number(b.dataset.f);
      all("button[data-f]", host).forEach((x) => x.setAttribute("aria-pressed", x === b));
      cur = null; // the mix step now means a different combination
      await setActive("mix");
      if (board.count === 0) autoDrop(2000);
    });
  }

  // ---------------------------------------------------------------- go
  watchSteps();
  wireCloud();
  (async () => {
    if (!(await gate)) return;
    board = Board.create($("board"), { gauge: true });
    wireLanding();
    wireDrops();
    wireToggles();
    await setActive(active);
    onEnter(active);
    if (active === "hero") autoDrop(240); // the hero comes alive once per page load (the board handles reduced motion)
    ranking().catch((e) => { if (e.message !== "stale") console.error(e); });
  })();
})();
