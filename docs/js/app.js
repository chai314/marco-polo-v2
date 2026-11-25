// State, the term sheet, the pricing every view draws on, and the result rail.
"use strict";

const $ = (id) => document.getElementById(id);
const LETTERS = ["A", "C", "S", "K"], BIT = { A: 1, C: 2, S: 4, K: 8 };
const NAME = { A: "Antithetic", C: "Control variate", S: "Stratified", K: "Conditional" };
const ALLOWED = { european: 7, merton: 15, asian: 7, barrier: 15, american: 3 };
const START = { european: 7, merton: 12, asian: 2, barrier: 14, american: 3 };
const KIND = { european: "Black–Scholes", merton: "Merton series", asian: "quadrature", barrier: "Reiner–Rubinstein", american: "lattice" };
const flat = (p) => p === "european" || p === "merton";

const state = { product: "european", pick: {}, seeded: {}, gen: 0, view: "race", results: new Map(), ref: NaN, market: null, touchedN: false, engine: "", cache: new Map() };
const letters = (f) => LETTERS.filter((l) => f & BIT[l]);
const dots = (f) => letters(f).map((l) => `<i class="dot ${l}">${l}</i>`).join("");
const word = (f) => letters(f).join("+") || "Plain";
const big = (x) => (x >= 1e6 ? (x / 1e6).toPrecision(3) + " million" : x >= 100 ? Number(x.toPrecision(3)).toLocaleString("en") : x >= 10 ? x.toFixed(0) : x.toFixed(1));
const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;
const minus = (s) => String(s).replace(/^-/, "−");
const fail = (msg) => { $("error").textContent = msg; $("error").hidden = !msg; };
const quiet = (e) => { if (e.message !== "stale") { console.error(e); fail(e.message); } };

// ---------------------------------------------------------------- market and the term sheet
async function loadMarket(force) {
  const m = (state.market = await Market.get($("i-ticker").value, $("i-source").value)), f = (x, d) => Number(x.toFixed(d));
  const s = m.smiles.reduce((a, b) => (Math.abs(b.T - 120 / 365) < Math.abs(a.T - 120 / 365) ? b : a));
  const fresh = { S0: f(m.spot, 2), K: Math.round(m.spot), H: f(m.spot * ($("i-direction").value === "up" ? 1.15 : 0.85), 0), r: f(100 * m.rate, 2), q: f(100 * m.q, 2), sigma: f(100 * s.atm, 1), sigmaD: f(100 * s.fit.sigma, 1), lam: f(s.fit.lam, 2), muJ: f(100 * s.fit.mu_j, 1), delta: f(100 * s.fit.delta, 1) };
  for (const k in fresh) { const el = $("i-" + k); if (force || el.value === "" || Number(el.value) === state.seeded[k]) el.value = fresh[k]; }
  state.seeded = fresh;
}
const edited = () => Object.keys(state.seeded).some((k) => Number($("i-" + k).value) !== state.seeded[k]);
function badge() {
  const m = state.market, d = new Date(m.asof + "T12:00:00Z").toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
  return (m.source === "SNAPSHOT" ? `${m.ticker} close ${d}` : `Synthetic ${m.ticker}-like market, this visit`) + (edited() ? ", inputs edited" : "");
}

function syncInputs() {
  const p = state.product, on = new Set([p, p === "european" && $("i-model").value === "merton" ? "merton" : "diffusion"]);
  if (p !== "american") on.add("strata");
  document.querySelectorAll("[data-for]").forEach((el) => { el.hidden = !el.dataset.for.split(" ").some((x) => on.has(x)); });
  document.querySelectorAll("[data-product]").forEach((b) => { b.setAttribute("aria-selected", b.dataset.product === p); b.tabIndex = b.dataset.product === p ? 0 : -1; });
}
function summarise(spec) {
  const what = { european: "European", merton: "European", asian: "Asian", barrier: "Barrier", american: "American" }[spec.product];
  $("summary").innerHTML = `<b>${what} ${spec.call ? "call" : "put"}</b> on ${$("i-ticker").value}, strike ${spec.K}, ${spec.T} yr · ${Number($("i-n").value).toLocaleString("en")} paths a run`;
}
function readSpec() {
  const num = (k, what) => {
    const el = $("i-" + k), v = Number(el.value);
    if (el.value === "" || !Number.isFinite(v) || (el.min !== "" && v < Number(el.min)) || (el.max !== "" && v > Number(el.max))) {
      el.setAttribute("aria-invalid", "true");
      throw new Error(`${what} must be ${el.max ? `between ${minus(el.min)} and ${el.max}` : "above zero"}.`);
    }
    el.removeAttribute("aria-invalid");
    return v;
  };
  const p = state.product, product = p === "european" ? ($("i-model").value === "merton" ? "merton" : "european") : p;
  const spec = { product, call: p !== "american" && $("i-kind").value === "call", S0: num("S0", "Spot"), K: num("K", "The strike"), T: num("T", "Years to expiry"), r: num("r", "The rate") / 100, q: num("q", "The dividend yield") / 100, sigma: (product === "merton" ? num("sigmaD", "Volatility") : num("sigma", "Volatility")) / 100, m: Number($("i-m").value) };
  if (product === "merton") Object.assign(spec, { lam: num("lam", "Jumps a year"), muJ: num("muJ", "The mean jump") / 100, delta: num("delta", "Jump volatility") / 100 });
  if (product === "american") spec.m = Number($("i-dates").value);
  if (product === "barrier") {
    Object.assign(spec, { H: num("H", "The barrier level"), down: $("i-direction").value === "down", knockIn: $("i-knock").value === "in", mode: $("i-mode").value });
    if (spec.down ? spec.H >= spec.S0 : spec.H <= spec.S0) { $("i-H").setAttribute("aria-invalid", "true"); throw new Error(`With spot at ${spec.S0}, ${spec.down ? "a down barrier must sit below it" : "an up barrier must sit above it"}. Move the level or switch the direction.`); }
  }
  return spec;
}
const allowed = (s) => (s.product === "barrier" && s.mode !== "bridge" ? 7 : ALLOWED[s.product]);
const pick = (s) => (state.pick[s.product] ?? START[s.product]) & allowed(s);
const whyNot = (s, l) => (l === "K" ? { european: "Conditioning would just return Black–Scholes", asian: "No closed form to condition on", barrier: "Needs Brownian-bridge monitoring", american: "No closed form with early exercise" }[s.product] : "Not used with early exercise");

// ---------------------------------------------------------------- pricing
async function recompute(mode) {
  const gen = ++state.gen;
  Engine.reset();
  let spec;
  try { syncInputs(); spec = readSpec(); fail(""); } catch (e) { return fail(e.message); }
  state.spec = spec;
  if (!state.touchedN) $("i-n").value = flat(spec.product) ? "2000" : "1000";
  state.base = { spec, n: Number($("i-n").value), seed: Number($("i-seed").value) >>> 0, strata: Number($("i-strata").value) };
  summarise(spec);
  drawKeys();
  document.body.classList.add("busy");
  if (state.view === "paths") show(mode || "fresh"); // paths need no prices
  else if (state.view === "race" && mode === "fresh" && state.priced?.product !== spec.product) { // another product: the old funnel would mislead
    Ink.clear(); $("marks").innerHTML = ""; $("tools").innerHTML = ""; $("caption").textContent = "";
    $("wait").textContent = "Pricing every combination"; $("wait").hidden = false;
  }
  const flags = [];
  for (let f = 0; f < 16; f++) if (!(f & ~allowed(spec))) flags.push(f);
  const work = flags.length * state.base.n * (flat(spec.product) ? 2 : spec.m), reps = Math.max(40, Math.min(384, Math.floor(1e8 / work)));
  try {
    const [ref, ...got] = await Promise.all([Engine.call("reference", { spec }), ...flags.map((f) => Engine.call("replicate", { ...state.base, flags: f, reps }))]);
    if (gen !== state.gen) return;
    state.ref = ref;
    state.results = new Map();
    state.priced = spec;
    got.forEach((g) => {
      const price = [...g.price], mu = mean(price), reported = mean([...g.se].map((v) => v * v)), seen = price.reduce((s, v) => s + (v - mu) ** 2, 0) / (price.length - 1);
      // the spread that occurred wins over the reported error only when it is clearly larger
      const short = seen > Math.max(1.25, 1 + 3.2 * Math.sqrt(2 / reps)) * reported, v = Math.max(short ? seen : reported, 1e-30);
      state.results.set(g.flags, { price, se: [...g.se], mean: mu, real: Math.sqrt(v), short, calib: Math.sqrt(reported / Math.max(seen, 1e-30)), cov: price.filter((x, i) => Math.abs(x - ref) <= 1.959964 * g.se[i]).length / reps, paths: g.paths, ms: g.ms / reps, reps });
    });
    const p = state.results.get(0);
    state.results.forEach((e) => { e.vrf = (p.real ** 2 * p.paths) / (e.real ** 2 * e.paths); });
    rail();
    if (state.view !== "paths") show(mode);
  } catch (e) { if (gen === state.gen) quiet(e); } finally { if (gen === state.gen) document.body.classList.remove("busy"); }
}

// ---------------------------------------------------------------- the rail
function rail() {
  const spec = state.spec, sel = pick(spec), e = state.results.get(sel), p = state.results.get(0), ref = state.ref;
  drawKeys();
  $("status-text").textContent = `${badge()} · ${state.engine}`;
  const d = sel ? `<span class="dots">${dots(sel)}</span>` : "";
  // a biased estimator keeps its bias however many paths it gets, so only the variance factor is claimed
  const gap = Math.abs(e.mean - ref);
  $("finding").innerHTML = !sel ? "Plain Monte Carlo, the yardstick" : biased(spec) && e.vrf >= 1.08 ? `${d} cuts the variance <b>${big(e.vrf)}×</b>, but a bias of ${gap.toPrecision(2)} stays` : e.vrf < 0.95 ? `${d} is worse than plain here` : e.vrf < 1.08 ? `${d} makes no real difference here` : `${d} needs <b>${big(e.vrf)}×</b> fewer paths for the same error`;
  const dig = Math.max(2, Math.min(6, 2 - Math.floor(Math.log10(Math.max(e.real, 1e-9)))));
  const row = (cls, name, x) => `<tr class="${cls}"><th scope="row">${name}</th><td>${x.price[0].toFixed(dig)}</td><td>±${(1.96 * x.real).toPrecision(2)}</td></tr>`;
  $("result").innerHTML = `<thead><tr><th></th><th scope="col">Price</th><th scope="col">95% error</th></tr></thead><tbody>` + row("", "One plain run", p) + (sel ? row("sel", `One ${word(sel)} run`, e) : "") + `<tr class="exact"><th scope="row">Exact, ${KIND[spec.product]}</th><td>${ref.toFixed(dig)}</td><td></td></tr></tbody>`;
  const runs = `${e.reps} runs of ${state.base.n.toLocaleString("en")} paths`;
  $("check").innerHTML = biased(spec) ? `Measured over ${runs}. This estimator is biased, so its error is measured about its own average; the bias is below.` : `Over ${runs}, its 95% intervals held the exact price <b>${Math.round(100 * e.cov)}%</b> of the time (±${Math.round(196 * Math.sqrt(0.0475 / e.reps))} from noise), and the error it reports is <b>${Math.round(100 * e.calib)}%</b> of the spread actually seen.`;
  const rows = [...state.results].sort((a, b) => b[1].vrf - a[1].vrf), top = Math.max(...rows.map(([, r]) => r.vrf));
  const span = Math.log(Math.max(top, 1.5));
  $("rank-note").textContent = biased(spec) ? `${rows.length}, by variance reduction` : `${rows.length}, fewest paths first`;
  $("ranking").innerHTML = rows.map(([f, r]) => {
    const w = r.vrf >= 1 ? Math.max(0.6, (100 * Math.log(r.vrf)) / span) : 0;
    return `<li><button type="button" data-f="${f}" aria-pressed="${f === sel}" aria-label="${word(f)}: ${f ? big(r.vrf) + " times fewer paths" : "the yardstick"}"><span class="dots">${f ? dots(f) : '<i class="dot P">–</i>'}</span><span class="name">${f ? word(f) : "Plain"}</span><span class="track"><i style="width:${w.toFixed(1)}%"></i></span><span class="x${r.vrf < 0.95 ? " worse" : ""}">${f ? (r.vrf < 0.95 ? "worse" : big(r.vrf) + "×") : "1×"}</span></button></li>`;
  }).join("");
  $("ranking").querySelectorAll("button").forEach((b) => {
    const f = Number(b.dataset.f), r = state.results.get(f);
    b.onclick = () => choose(f);
    b.onpointerenter = (ev) => tip(ev, `${f ? word(f) : "Plain"}: ${f ? big(r.vrf) + "× fewer paths" : "the yardstick"}\nOne run: ${r.mean.toFixed(4)} on average, ±${(1.96 * r.real).toPrecision(2)} at 95%\nIntervals held the exact price ${Math.round(100 * r.cov)}% of the time\n${r.ms.toFixed(2)} ms a run on one thread (noisy)`);
    b.onpointermove = (ev) => tip(ev, $("tip").textContent);
    b.onpointerleave = () => tip(null);
  });
  const c = [trouble(), bias()].filter(Boolean).join(" ");
  $("caveat").innerHTML = c ? `<b>Read this.</b> ${c}` : "";
  $("caveat").hidden = !c;
  const sel_ = $("ranking").querySelector('[aria-pressed="true"]'), rl = document.querySelector(".rail");
  if (sel_ && matchMedia("(min-width: 921px)").matches) sel_.scrollIntoView({ block: "nearest" });
  rl.classList.toggle("more", rl.scrollHeight - rl.scrollTop > rl.clientHeight + 4);
}
const biased = (s) => s.product === "american" || (s.product === "barrier" && s.mode !== "bridge");
function bias() {
  const spec = state.spec, e = state.results.get(pick(spec));
  if (!e) return "";
  if (spec.product === "american") return `The runs centre ${Math.abs(100 * (e.mean / state.ref - 1)).toFixed(2)}% ${e.mean < state.ref ? "below" : "above"} the lattice: a fitted exercise rule cannot beat the best one.`;
  if (spec.product === "barrier" && spec.mode !== "bridge") return `The runs centre ${(e.mean - state.ref >= 0 ? "+" : "−") + Math.abs(e.mean - state.ref).toPrecision(2)} from the continuously monitored price: ${spec.mode === "naive" ? "a grid misses crossings between its dates" : "the shift repairs most, not all, of the grid’s bias"}.`;
  return "";
}
function trouble() {
  const low = [...state.results].filter(([, r]) => r.short), e = state.results.get(pick(state.spec));
  const off = e && !biased(state.spec) && e.cov < 0.95 - 1.96 * Math.sqrt(0.0475 / e.reps) ? `Its intervals held the exact price only ${Math.round(100 * e.cov)}% of the time, below 95% by more than noise, so its runs may be slightly off centre. ` : "";
  return off + (low.length ? `Reported errors are too small for ${low.map(([f, r]) => `${word(f)} (${Math.round(100 * r.calib)}% of the real spread)`).join(", ")}, so the spread that actually occurred is used${state.spec.product === "merton" ? ": jumps are too rare for a short run to see" : ""}.` : "");
}

function drawKeys() {
  const spec = state.spec, sel = pick(spec), ok = allowed(spec), host = $("keys");
  if (!host.children.length) {
    host.innerHTML = LETTERS.map((l) => `<button type="button" class="key" data-m="${l}" style="--c:var(--${l})" title="${NAME[l]} (${l.toLowerCase()})"><span class="disc">${l}</span><span class="nm">${NAME[l]}</span><span class="alone"></span></button>`).join("");
    host.onclick = (e) => { const b = e.target.closest("button"); if (b && b.getAttribute("aria-disabled") !== "true") choose(pick(state.spec) ^ BIT[b.dataset.m]); };
  }
  for (const b of host.children) {
    const bit = BIT[b.dataset.m], can = Boolean(ok & bit), r = state.results.get(bit);
    b.setAttribute("aria-disabled", !can);
    b.setAttribute("aria-pressed", Boolean(sel & bit));
    b.querySelector(".alone").textContent = !can ? whyNot(spec, b.dataset.m) : r && state.results.size ? (r.vrf < 0.95 ? "worse alone" : `${big(r.vrf)}× alone`) : "";
  }
}

// ---------------------------------------------------------------- views
function context(mode) {
  const gen = state.gen, view = state.view, spec = state.spec, sel = pick(spec);
  return {
    spec, sel, mode, ref: state.ref, base: state.base, results: state.results, market: state.market, cache: state.cache, word, dots, big, choose, useFit, tip, recompute,
    alive: () => gen === state.gen && view === state.view && sel === pick(state.spec),
    caption: (t) => { $("caption").innerHTML = t; },
    tools: (t) => { $("tools").innerHTML = t; },
    wait: (t) => { $("wait").textContent = t || ""; $("wait").hidden = !t; },
    drag(id, v, end) {
      const el = $("i-" + (id === "sigma" && spec.product === "merton" ? "sigmaD" : id)), min = Number(el.min), max = el.max ? Number(el.max) : Infinity;
      el.value = id === "sigma" ? Math.max(min, Math.min(max, 100 * v)).toFixed(1) : +Math.max(min, v).toFixed(v > 50 ? 0 : 2);
      if (end) return recompute("still");
      try { state.spec = readSpec(); fail(""); } catch (e) { return fail(e.message); }
      state.base = { ...state.base, spec: state.spec };
      state.gen++;
      Views.paths(context("drag")).catch(quiet);
    },
  };
}
function show(mode) {
  if (!state.spec || !state.market) return;
  const v = state.view;
  document.querySelectorAll("[data-view]").forEach((b) => { b.setAttribute("aria-selected", b.dataset.view === v); b.tabIndex = b.dataset.view === v ? 0 : -1; });
  document.body.dataset.view = v;
  if (v === "race" && state.priced !== state.spec) return; // prices for this contract are still coming
  Promise.resolve(Views[v](context(mode))).catch(quiet);
}
function tip(e, msg) {
  const t = $("tip");
  t.hidden = !e;
  if (!e) return;
  t.textContent = msg;
  t.style.left = Math.max(6, Math.min(innerWidth - t.offsetWidth - 6, e.clientX + 14)) + "px";
  t.style.top = Math.max(6, e.clientY - t.offsetHeight - 12) + "px";
}

// ---------------------------------------------------------------- controls
function choose(f) {
  state.pick[state.spec.product] = f;
  tip(null);
  if (state.priced === state.spec) rail(); else drawKeys();
  show("choose");
}
function setProduct(p) {
  if (p === state.product) return;
  state.product = p;
  syncInputs();
  recompute("fresh");
}
function setView(v) {
  if (!Views[v] || v === state.view) return;
  state.view = v;
  try { history.replaceState(null, "", "#" + v); } catch { /* file:// in some browsers */ }
  show("fresh");
}
function useFit(s) {
  const m = state.market, f = (x, d) => Number(x.toFixed(d)), set = { S0: f(m.spot, 2), K: Math.round(m.spot), T: Math.max(0.05, Math.min(3, f(s.T, 2))), r: f(100 * m.rate, 2), q: f(Math.max(0, 100 * s.q), 2), sigma: f(100 * s.atm, 1), sigmaD: f(100 * s.fit.sigma, 1), lam: f(s.fit.lam, 2), muJ: f(100 * s.fit.mu_j, 1), delta: f(100 * s.fit.delta, 1) };
  for (const k in set) $("i-" + k).value = set[k];
  state.product = "european";
  $("i-model").value = "merton";
  state.view = "race";
  try { history.replaceState(null, "", "#race"); } catch { /* ignore */ }
  recompute("fresh");
}
// Drag a field's label sideways to change its number, as in a design tool. Arrow keys step it.
function scrub(input) {
  const label = input.closest("label").querySelector("span"), unit = Number(input.dataset.step) || 1, d = Math.max(0, -Math.floor(Math.log10(unit) + 1e-9));
  const step = () => (["S0", "K", "H"].includes(input.id.slice(2)) ? Math.max(unit, Math.round(Number(input.value) * 0.002)) : unit);
  const clamp = (v) => Math.max(input.min === "" ? -Infinity : Number(input.min), Math.min(input.max === "" ? Infinity : Number(input.max), v));
  const set = (v) => { const next = +clamp(v).toFixed(Math.max(d, 2)); if (Number(input.value) !== next) { input.value = next; input.dispatchEvent(new Event("input", { bubbles: true })); } };
  label.addEventListener("pointerdown", (e) => {
    if (e.button) return;
    e.preventDefault();
    const from = Number(input.value), x0 = e.clientX, s = step();
    document.body.classList.add("scrubbing");
    label.setPointerCapture(e.pointerId);
    const move = (ev) => set(from + Math.round((ev.clientX - x0) / 4) * s);
    const up = (ev) => { document.body.classList.remove("scrubbing"); label.releasePointerCapture(ev.pointerId); label.removeEventListener("pointermove", move); label.removeEventListener("pointerup", up); label.removeEventListener("pointercancel", up); if (Math.abs(ev.clientX - x0) < 3) { input.focus(); input.select(); } };
    label.addEventListener("pointermove", move);
    label.addEventListener("pointerup", up);
    label.addEventListener("pointercancel", up);
  });
  input.addEventListener("keydown", (e) => {
    const k = { ArrowUp: 1, ArrowDown: -1 }[e.key];
    if (!k) return;
    e.preventDefault();
    set(Number(input.value) + k * step() * (e.shiftKey ? 10 : 1));
  });
}
function tabs(host, attr, act) { // arrow keys move between tabs, as the ARIA pattern expects
  host.addEventListener("click", (e) => { const b = e.target.closest(`[${attr}]`); if (b) act(b.getAttribute(attr)); });
  host.addEventListener("keydown", (e) => {
    const all = [...host.querySelectorAll(`[${attr}]`)], i = all.indexOf(document.activeElement), d = { ArrowRight: 1, ArrowLeft: -1 }[e.key];
    if (i < 0 || !d) return;
    const b = all[(i + d + all.length) % all.length];
    b.focus();
    act(b.getAttribute(attr));
  });
}

(async function main() {
  document.querySelector(".rail").addEventListener("scroll", (e) => { const r = e.target; r.classList.toggle("more", r.scrollHeight - r.scrollTop > r.clientHeight + 4); });
  $("i-ticker").innerHTML = Object.keys(window.MARKET).map((t) => `<option>${t}</option>`).join("");
  document.querySelectorAll(".sheet input[type=number]").forEach(scrub);
  const start = location.hash.slice(1);
  if (Views[start]) state.view = start;
  syncInputs();
  document.querySelectorAll("[data-view]").forEach((b) => b.setAttribute("aria-selected", b.dataset.view === state.view));
  document.body.dataset.view = state.view;
  Ink.mount($("stage"));
  tabs(document.querySelector(".products"), "data-product", setProduct);
  tabs(document.querySelector(".views"), "data-view", setView);
  let timer;
  $("form").addEventListener("input", (e) => {
    const id = e.target.id;
    if (id === "i-n") state.touchedN = true;
    if (id === "i-direction") $("i-H").value = (Number($("i-S0").value) * (e.target.value === "up" ? 1.15 : 0.85)).toFixed(0);
    syncInputs();
    clearTimeout(timer);
    const light = e.target.tagName === "INPUT" && id !== "i-seed";
    timer = setTimeout(async () => {
      try { if (id === "i-ticker" || id === "i-source") await loadMarket(true); } catch (err) { return quiet(err); }
      recompute(light ? "still" : "fresh");
    }, light ? 120 : 10);
  });
  $("form").addEventListener("submit", (e) => e.preventDefault());
  $("b-sheet").onclick = () => { const open = document.body.classList.toggle("sheet-open"); $("b-sheet").setAttribute("aria-expanded", open); };
  $("b-reset").onclick = async () => { await loadMarket(true); recompute("fresh"); };
  addEventListener("keydown", (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey || /INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName) || !state.spec) return;
    const k = e.key.toUpperCase();
    if (BIT[k] && allowed(state.spec) & BIT[k]) { e.preventDefault(); choose(pick(state.spec) ^ BIT[k]); }
    else if ("1234".includes(e.key) && e.key !== " ") setView(["race", "paths", "market", "notes"][Number(e.key) - 1]);
    else if (k === "R") $("b-reset").click();
  });
  addEventListener("hashchange", () => setView(location.hash.slice(1)));
  let rt;
  new ResizeObserver(() => { Ink.size(); clearTimeout(rt); rt = setTimeout(() => show("resize"), 140); }).observe($("stage"));
  try {
    $("wait").hidden = false;
    $("wait").textContent = "Compiling the C++ engine for your browser";
    const n = await Engine.start();
    state.engine = `C++ in WebAssembly on ${n} threads`;
    $("wait").textContent = "Pricing every combination";
    await loadMarket(true);
    await recompute("fresh");
  } catch (e) {
    $("status-text").textContent = "The engine did not start";
    $("wait").hidden = true;
    fail("This browser could not start the WebAssembly engine: " + e.message);
  }
})();
