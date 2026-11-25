// Market data for the page: the committed snapshot, or a synthetic market drawn in the browser.
"use strict";

const Market = (() => {
  const VOL = { SPY: 0.16, QQQ: 0.2, IWM: 0.22, AAPL: 0.27, MSFT: 0.24, NVDA: 0.42 };
  const cache = new Map();
  const session = Math.floor(Math.random() * 1e6);

  const snapshot = (t) => ({ ...window.MARKET[t], ticker: t, source: "SNAPSHOT", label: `SNAPSHOT, ${t} ${window.MARKET[t].asof}` });

  // Two years of Merton daily closes and a chain priced by the series, different in every session.
  async function synthetic(t) {
    if (cache.has(t)) return cache.get(t);
    const base = window.MARKET[t], sigma = VOL[t] || 0.25, lam = 1.5, mu = -0.04, dl = 0.05, r = 0.04, q = 0.01, days = 504, dt = 1 / 252;
    const seed = session + [...t].reduce((a, c) => a + c.charCodeAt(0), 0);
    const z = await Engine.call("normals", { seed, n: 2 * days }), u = await Engine.call("normals", { seed: seed + 1, n: days, uniform: true });
    const k = Math.exp(mu + (dl * dl) / 2) - 1, close = [], dates = [];
    let x = Math.log(base.spot);
    for (let i = 0; i < days; i++) {
      const jumps = u[i] < 1 - Math.exp(-lam * dt) ? 1 : 0; // at most one jump a day: the chance of two is about 2e-5
      x += (0.07 - (sigma * sigma) / 2 - lam * k) * dt + sigma * Math.sqrt(dt) * z[i] + jumps * (mu + dl * z[days + i]);
      close.push(+Math.exp(x).toFixed(2));
    }
    const day = new Date();
    while (dates.length < days) {
      if (day.getDay() % 6) dates.unshift(day.toISOString().slice(0, 10));
      day.setDate(day.getDate() - 1);
    }
    const spot = close[days - 1], smiles = [];
    for (const d of [30, 60, 120, 240]) {
      const T = d / 365, fwd = spot * Math.exp((r - q) * T), width = Math.min(0.45, 3.2 * Math.sqrt(sigma * sigma + lam * (mu * mu + dl * dl)) * Math.sqrt(T));
      const K = [], call = [];
      for (let i = 0; i <= 40; i++) { const s = +(fwd * Math.exp(width * (i / 20 - 1) * (i < 20 ? 1 : 0.7))).toFixed(1); K.push(s); call.push(s >= fwd ? 1 : 0); }
      const mid = await Engine.call("merton", { rows: K.map((s, i) => [spot, s, T, r, q, sigma, lam, mu, dl, call[i]]) });
      const iv = await Engine.call("impliedVol", { rows: K.map((s, i) => [mid[i], spot, s, T, r, q, call[i]]) });
      const keep = K.map((_, i) => i).filter((i) => Number.isFinite(iv[i]) && mid[i] > 0.02), pick = (a) => keep.map((i) => a[i]);
      const expiry = new Date(Date.now() + d * 864e5).toISOString().slice(0, 10), kept = pick(iv), near = pick(K).reduce((b, s, i, a) => (Math.abs(s - fwd) < Math.abs(a[b] - fwd) ? i : b), 0);
      const half = (m) => Math.max(0.01, 0.004 * m), mean = kept.reduce((a, b) => a + b, 0) / kept.length;
      smiles.push({ expiry, T, forward: fwd, q, atm: kept[near], fit: { sigma, lam, mu_j: mu, delta: dl }, rmse: 0, rmse_flat: Math.sqrt(kept.reduce((a, b) => a + (b - mean) ** 2, 0) / kept.length),
        K: pick(K), call: pick(call), bid: pick(mid).map((m) => +(m - half(m)).toFixed(3)), ask: pick(mid).map((m) => +(m + half(m)).toFixed(3)), iv: kept, model: kept });
    }
    let s = 0, m = 0;
    const ret = close.slice(1).map((c, i) => Math.log(c / close[i]));
    ret.forEach((v) => { m += v / ret.length; });
    ret.forEach((v) => { s += (v - m) ** 2; });
    const out = { ticker: t, source: "SYNTHETIC", asof: dates[days - 1], label: `SYNTHETIC, ${t}-like, this session`, spot, rate: r, q, vol: Math.sqrt((s / (ret.length - 1)) * 252), dates, close, smiles };
    cache.set(t, out);
    return out;
  }
  return { get: async (t, source) => (source === "synthetic" ? synthetic(t) : snapshot(t)) };
})();
