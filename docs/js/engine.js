// The C++ engine in Web Workers. `workerMain` is turned into a Blob worker so the page also runs from file://.
"use strict";

function workerMain() {
  let X, mem; // wasm exports and memory
  const PRODUCT = { european: 0, merton: 1, asian: 2, barrier: 3, american: 4 };
  const MODE = { bridge: 0, naive: 1, shifted: 2 };
  let scratch = 0;
  const handles = new Map(); // key -> {ptr, plan}, most recent last

  const f64 = (p, n) => new Float64Array(mem.buffer, p, n);

  function init(module) {
    const wasi = { fd_close: () => 0, fd_seek: () => 0, fd_write: () => 0 };
    X = new WebAssembly.Instance(module, { wasi_snapshot_preview1: wasi }).exports;
    mem = X.memory;
    X._initialize();
    scratch = X.malloc(4096);
  }

  function open(spec, flags, n, strata, block) {
    const key = JSON.stringify([spec, flags, n, strata, block]);
    if (handles.has(key)) {
      const h = handles.get(key);
      handles.delete(key);
      handles.set(key, h);
      return h;
    }
    const v = new DataView(mem.buffer, scratch, 256);
    const ints = [PRODUCT[spec.product], flags, spec.call ? 1 : 0, spec.down ? 1 : 0, spec.knockIn ? 1 : 0, MODE[spec.mode || "bridge"], spec.m || 1, 20000];
    ints.forEach((x, i) => v.setInt32(4 * i, x, true));
    v.setUint32(32, 20221, true);
    v.setUint32(36, 0, true);
    [spec.S0, spec.K, spec.T, spec.r, spec.q, spec.sigma, spec.lam || 0, spec.muJ || 0, spec.delta || 0, spec.H || 0]
      .forEach((x, i) => v.setFloat64(40 + 8 * i, x, true));
    const pPlan = scratch + 128, pOut = scratch + 168;
    const code = X.vr_open(scratch, n, strata, 0.05, block || 0, pPlan, pOut);
    if (code) throw new Error("The path budget is too small for this combination.");
    const w = new DataView(mem.buffer, scratch, 256); // memory may have grown
    const plan = {
      ppu: w.getInt32(128, true), H: w.getInt32(132, true), rounds: Number(w.getBigInt64(136, true)),
      pilot: Number(w.getBigInt64(144, true)), block: Number(w.getBigInt64(152, true)),
    };
    plan.paths = (plan.rounds + plan.pilot) * plan.H * plan.ppu;
    plan.blocks = Math.ceil(plan.rounds / plan.block);
    const h = { ptr: w.getUint32(168, true), plan };
    handles.set(key, h);
    if (handles.size > 24) {
      const [k, old] = handles.entries().next().value;
      X.vr_destroy(old.ptr);
      handles.delete(k);
    }
    return h;
  }

  function pilot(h, seed, flags) {
    const b = [0, 0];
    if (flags & 2) {
      X.vr_pilot(h.ptr, seed, scratch + 256);
      const a = f64(scratch + 256, 2);
      b[0] = a[0]; b[1] = a[1];
    }
    return b;
  }

  function run(h, seed, beta, b0, b1) {
    const H = h.plan.H, p = X.malloc(8 * (3 + 2 * H));
    f64(p, 2).set(beta);
    X.vr_run(h.ptr, seed, p, b0, b1, p + 16, p + 24, p + 24 + 8 * H);
    const out = { n: f64(p + 16, 1)[0], mean: f64(p + 24, H).slice(), m2: f64(p + 24 + 8 * H, H).slice() };
    X.free(p);
    return out;
  }

  const fresh = (H) => ({ n: 0, mean: new Float64Array(H), m2: new Float64Array(H) });
  function merge(a, b) {
    const tot = a.n + b.n;
    for (let i = 0; i < a.mean.length; i++) {
      const d = b.mean[i] - a.mean[i];
      a.mean[i] += d * (b.n / tot);
      a.m2[i] += b.m2[i] + d * d * (a.n * b.n / tot);
    }
    a.n = tot;
  }
  function summary(a, plan) {
    const H = a.mean.length;
    let m = 0, s = 0;
    for (let i = 0; i < H; i++) { m += a.mean[i]; s += a.m2[i]; }
    return { price: m / H, se: a.n > 1 ? Math.sqrt(s / (a.n - 1) / a.n) / H : NaN, paths: (a.n + plan.pilot) * H * plan.ppu };
  }

  const ops = {
    estimate({ spec, flags, n, seed, strata }) {
      const t0 = performance.now();
      const h = open(spec, flags, n, strata);
      const beta = pilot(h, seed, flags), acc = run(h, seed, beta, 0, h.plan.blocks);
      return { ...summary(acc, h.plan), flags, ms: performance.now() - t0 };
    },
    // Running estimate on a log-spaced grid, posted as it is computed.
    race({ spec, flags, n, seed, strata, points, paced }, post) {
      const probe = open(spec, flags, n, strata).plan;
      const block = Math.max(1, Math.floor(Math.max(16, n / 60000) / probe.H)); // small blocks, so early marks exist
      const h = open(spec, flags, n, strata, block), beta = pilot(h, seed, flags), acc = fresh(h.plan.H);
      const marks = [];
      for (let i = 0; i < points; i++) {
        const b = Math.max(1, Math.round(h.plan.blocks ** (i / (points - 1))));
        if (b !== marks[marks.length - 1]) marks.push(b);
      }
      let done = 0, batch = [], last = performance.now();
      for (const b1 of marks) {
        merge(acc, run(h, seed, beta, done, b1));
        done = b1;
        const s = summary(acc, h.plan);
        if (Number.isFinite(s.se)) batch.push([s.paths, s.price, s.se]);
        if (paced && performance.now() - last > 40) { post(batch); batch = []; last = performance.now(); }
      }
      return batch;
    },
    replicate({ spec, flags, n, reps, seed, strata }) {
      const t0 = performance.now();
      const h = open(spec, flags, n, strata), p = X.malloc(16 * reps);
      X.vr_replicate(h.ptr, seed, reps, p, p + 8 * reps);
      const out = { flags, paths: h.plan.paths, ms: performance.now() - t0, price: f64(p, reps).slice(), se: f64(p + 8 * reps, reps).slice() };
      X.free(p);
      return out;
    },
    reference({ spec }) {
      const h = open(spec, 0, 1000, 64), p = X.malloc(8);
      X.vr_reference(h.ptr, p);
      const v = f64(p, 1)[0];
      X.free(p);
      return v;
    },
    policy({ spec }) {
      const h = open(spec, 0, 1000, 64), p = X.malloc(32 * spec.m);
      const m = X.vr_policy(h.ptr, p), out = f64(p, 4 * m).slice();
      X.free(p);
      return out;
    },
    // Standard normals (or uniforms) for drawing, from the same generator.
    normals({ seed, n, uniform }) {
      const p = X.malloc(8 * n);
      X.vr_uniforms(seed, 9, 0, n, p);
      if (!uniform) X.vr_inv_normal(n, p, p);
      const out = f64(p, n).slice();
      X.free(p);
      return out;
    },
    impliedNormals({ u }) { // the engine's own inverse normal
      const n = u.length, p = X.malloc(8 * n);
      f64(p, n).set(u);
      X.vr_inv_normal(n, p, p);
      const out = f64(p, n).slice();
      X.free(p);
      return out;
    },
    blackScholes: ({ rows }) => rows.map((a) => X.vr_black_scholes(...a)),
    merton: ({ rows }) => rows.map((a) => X.vr_merton(...a)),
    // Implied volatility by bisection; rows are [price, S, K, T, r, q, call].
    impliedVol: ({ rows }) => rows.map(([p, S, K, T, r, q, call]) => {
      let lo = 1e-3, hi = 5;
      const at = (v) => X.vr_black_scholes(S, K, T, r, q, v, call);
      if (p <= at(lo) || p >= at(hi)) return NaN;
      for (let i = 0; i < 60; i++) { const mid = 0.5 * (lo + hi); if (at(mid) > p) hi = mid; else lo = mid; }
      return 0.5 * (lo + hi);
    }),
  };

  onmessage = (e) => {
    const { id, op, args, module } = e.data;
    try {
      if (op === "init") return init(module), postMessage({ id, result: true });
      const result = ops[op](args, (part) => postMessage({ id, part }));
      postMessage({ id, result });
    } catch (err) {
      postMessage({ id, error: String(err.message || err) });
    }
  };
}

const Engine = (() => {
  const workers = [], queue = [], waiting = new Map();
  let next = 1, version = 0;

  async function start() {
    const raw = Uint8Array.from(atob(window.VROPT_WASM), (c) => c.charCodeAt(0));
    const module = await WebAssembly.compile(raw);
    const url = URL.createObjectURL(new Blob([`(${workerMain})()`], { type: "text/javascript" }));
    const count = Math.max(2, Math.min(navigator.hardwareConcurrency || 4, 10) - 1);
    const ready = [];
    for (let i = 0; i < count; i++) {
      const w = new Worker(url);
      w.busy = false;
      w.onmessage = ({ data }) => {
        const job = waiting.get(data.id);
        if (!job) return;
        if ("part" in data) return job.onPart && job.onPart(data.part);
        waiting.delete(data.id);
        w.busy = false;
        pump();
        if ("error" in data) job.reject(new Error(data.error));
        else job.resolve(data.result);
      };
      workers.push(w);
      ready.push(send(w, "init", null, { module }));
    }
    await Promise.all(ready);
    return count;
  }

  function send(w, op, args, extra = {}, onPart) {
    return new Promise((resolve, reject) => {
      const id = next++;
      waiting.set(id, { resolve, reject, onPart });
      w.busy = true;
      w.postMessage({ id, op, args, ...extra });
    });
  }

  function pump() {
    for (const w of workers) {
      if (w.busy) continue;
      const job = queue.shift();
      if (!job) return;
      send(w, job.op, job.args, {}, job.onPart).then(job.resolve, job.reject);
    }
  }

  // Queue a call. Calls tagged with an old version are dropped before they start.
  function call(op, args, onPart, channel = "lab") {
    return new Promise((resolve, reject) => {
      const job = { op, args, resolve, reject, onPart, version, channel };
      // the story is what the visitor is looking at: its jobs go ahead of the lab's, in order
      if (channel === "story") { let at = 0; while (at < queue.length && queue[at].channel === "story") at++; queue.splice(at, 0, job); } else queue.push(job);
      pump();
    });
  }

  // Abandon everything still queued: the inputs have changed.
  // Only the jobs of one channel ("lab" by default; the story uses "story") are dropped.
  function reset(channel = "lab") {
    version++;
    for (let i = queue.length - 1; i >= 0; i--) if (queue[i].channel === channel) queue.splice(i, 1)[0].reject(new Error("stale"));
  }

  return { start, call, reset };
})();
