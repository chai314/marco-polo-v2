"""From a quoted chain to model parameters: implied volatilities and a Merton smile fit."""
from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np
import pandas as pd
from scipy.optimize import least_squares

from . import analytic as an


def implied_vol(price, S, K, T, r, q, kind, lo=1e-3, hi=5.0):
    """Vectorised bisection. NaN where the price violates the no-arbitrage bounds."""
    price, K = np.broadcast_arrays(np.asarray(price, float), np.asarray(K, float))
    a, b = np.full(price.shape, lo), np.full(price.shape, hi)
    bad = (price <= an.black_scholes(S, K, T, r, q, lo, kind)) | (price >= an.black_scholes(S, K, T, r, q, hi, kind))
    for _ in range(60):
        mid = .5 * (a + b)
        high = an.black_scholes(S, K, T, r, q, mid, kind) > price
        a, b = np.where(high, a, mid), np.where(high, mid, b)
    return np.where(bad, np.nan, .5 * (a + b))


@dataclass
class Smile:
    expiry: str
    T: float
    forward: float
    q_implied: float   # carry that reproduces the parity forward
    table: pd.DataFrame  # strike, type, bid, ask, mid, iv
    atm_iv: float


def build_smile(market, expiry) -> Smile | None:
    """Out-of-the-money quotes around a put-call-parity forward. Single-name and ETF options are
    American; the early-exercise premium of OTM quotes is small and is ignored here."""
    T = market.years_to(expiry)
    df = market.chain[market.chain["expiry"] == expiry]
    df = df[(df["bid"] > 0) & (df["ask"] > df["bid"])].copy()
    if df.empty:
        return None
    df["mid"] = .5 * (df["bid"] + df["ask"])
    both = df.pivot_table(index="strike", columns="type", values="mid")
    fwd = market.spot * math.exp((market.rate - market.div_yield) * T)
    if {"call", "put"} <= set(both.columns):
        both = both.dropna()
        near = both.iloc[np.argsort(np.abs(both.index.to_numpy() - market.spot))[:7]]
        if len(near) >= 3:
            implied = near.index.to_numpy() + math.exp(market.rate * T) * (near["call"] - near["put"]).to_numpy()
            guess = float(np.median(implied))
            if abs(guess / fwd - 1) < .05:
                fwd = guess
    q_imp = market.rate - math.log(fwd / market.spot) / T
    df = df[((df["type"] == "call") & (df["strike"] >= fwd)) | ((df["type"] == "put") & (df["strike"] < fwd))]
    df = df[(df["ask"] - df["bid"]) <= .5 * df["mid"]]
    iv = np.full(len(df), np.nan)
    for side in ("call", "put"):
        mask = (df["type"] == side).to_numpy()
        if mask.any():
            iv[mask] = implied_vol(df["mid"].to_numpy()[mask], market.spot, df["strike"].to_numpy()[mask], T,
                                   market.rate, q_imp, side)
    df["iv"] = iv
    df = df.dropna(subset=["iv"]).sort_values("strike")
    if len(df):
        # keep the region the market actually quotes: within 4 ATM standard deviations
        atm = float(df["iv"].iloc[int(np.argmin(np.abs(df["strike"].to_numpy() - fwd)))])
        df = df[np.abs(np.log(df["strike"] / fwd)) <= 4 * atm * math.sqrt(T)]
    if len(df) < 5:
        return None
    return Smile(expiry, T, fwd, q_imp, df[["strike", "type", "bid", "ask", "mid", "iv"]].reset_index(drop=True), atm)


def merton_strip(S, K, T, r, q, sigma, lam, mu_j, delta, n_max=40):
    """Call prices for a vector of strikes."""
    n = np.arange(n_max)
    log_fact = np.cumsum(np.log(np.maximum(n, 1)))
    mean = max(lam * T, 1e-12)
    pmf = np.exp(-mean + n * math.log(mean) - log_fact)
    vals = an.merton_conditional(S, np.asarray(K, float)[:, None], T, r, q, sigma, lam, mu_j, delta, n[None, :])
    return vals @ pmf


@dataclass
class MertonFit:
    sigma: float
    lam: float
    mu_j: float
    delta: float
    rmse_iv: float       # in volatility points (0.01 = 1 vol)
    rmse_flat: float     # same for the best single volatility, i.e. GBM
    model_iv: np.ndarray


def fit_merton(smile: Smile, market) -> MertonFit:
    """Least squares in implied-volatility units, using price error over vega as a linear proxy."""
    t = smile.table
    K, iv, T, S, r, q = t["strike"].to_numpy(), t["iv"].to_numpy(), smile.T, market.spot, market.rate, smile.q_implied
    target = an.black_scholes(S, K, T, r, q, iv)
    d1 = np.log(smile.forward / K) / (iv * math.sqrt(T)) + .5 * iv * math.sqrt(T)
    vega = np.maximum(S * math.exp(-q * T) * np.exp(-.5 * d1**2) / math.sqrt(2 * math.pi) * math.sqrt(T), 1e-3 * S * math.sqrt(T))

    def resid(p):
        return (merton_strip(S, K, T, r, q, *p) - target) / vega

    lo, hi = [.02, .0, -.6, .01], [1.5, 6.0, .3, .5]
    best = None
    for guess in ([.8 * smile.atm_iv, .5, -.15, .1], [.9 * smile.atm_iv, 2.0, -.05, .06], [.6 * smile.atm_iv, .2, -.3, .15]):
        res = least_squares(resid, np.clip(guess, np.array(lo) + 1e-6, np.array(hi) - 1e-6), bounds=(lo, hi),
                            x_scale=[.1, 1, .1, .1], max_nfev=200, loss="soft_l1", f_scale=.02)
        if best is None or res.cost < best.cost:
            best = res
    fitted = implied_vol(merton_strip(S, K, T, r, q, *best.x), S, K, T, r, q, "call")
    return MertonFit(*map(float, best.x), float(np.sqrt(np.nanmean((fitted - iv) ** 2))), float(iv.std()), fitted)
