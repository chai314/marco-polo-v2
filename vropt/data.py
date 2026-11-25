"""Market data in three modes, tried in order: LIVE, SNAPSHOT, SYNTHETIC.

LIVE       yfinance prices, dividends and option chains; FRED DGS3MO for the rate.
SNAPSHOT   CSV files committed under data/, written by `python -m vropt.data`.
SYNTHETIC  a seeded Merton path and a chain priced off it, so the app works with no data at all.

`load` never raises because of the network: it says which mode it ended up in, and why.
"""
from __future__ import annotations

import io
import math
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import numpy as np
import pandas as pd

from . import analytic as an

TICKERS = ("SPY", "QQQ", "IWM", "AAPL", "MSFT", "NVDA")
DATA = Path(__file__).resolve().parent.parent / "data"
TARGET_DAYS = (30, 60, 120, 240)
FRED_URL = "https://fred.stlouisfed.org/graph/fredgraph.csv"
LIVE, SNAPSHOT, SYNTHETIC = "LIVE", "SNAPSHOT", "SYNTHETIC"
DEADLINE = 30.0
PRICE_COLS = ["date", "open", "high", "low", "close", "dividend"]
CHAIN_COLS = ["expiry", "type", "strike", "bid", "ask", "last", "volume", "open_interest"]
_SYNTH = {"SPY": (700, .16), "QQQ": (620, .20), "IWM": (240, .22), "AAPL": (340, .27), "MSFT": (500, .24), "NVDA": (190, .42)}


@dataclass
class MarketData:
    ticker: str
    source: str
    asof: str
    spot: float
    rate: float          # continuously compounded 3-month Treasury
    div_yield: float     # trailing twelve months, continuously compounded
    prices: pd.DataFrame
    chain: pd.DataFrame
    notes: list = field(default_factory=list)

    @property
    def badge(self):
        return f"{self.source} · {self.asof}"

    @property
    def asof_date(self):
        return date.fromisoformat(self.asof[:10])

    def log_returns(self):
        return np.diff(np.log(self.prices["close"].to_numpy(float)))

    def realised_vol(self, window=None):
        x = self.log_returns()
        x = x[-window:] if window else x
        return float(x.std(ddof=1) * math.sqrt(252))

    def expiries(self):
        return sorted(self.chain["expiry"].unique()) if len(self.chain) else []

    def years_to(self, expiry):
        return max((date.fromisoformat(expiry) - self.asof_date).days, 1) / 365.0


def _ttm_yield(prices, spot):
    last = pd.to_datetime(prices["date"].iloc[-1])
    recent = prices[pd.to_datetime(prices["date"]) > last - pd.Timedelta(days=365)]
    return math.log1p(max(float(recent["dividend"].sum()), 0.0) / spot)


# ------------------------------------------------------------------------ live
def fetch_rate(timeout=8):
    """Latest 3-month constant-maturity yield (bond-equivalent, percent) -> continuous rate."""
    import requests

    start = (date.today() - timedelta(days=45)).isoformat()
    r = requests.get(FRED_URL, params={"id": "DGS3MO", "cosd": start}, timeout=timeout)
    r.raise_for_status()
    s = pd.to_numeric(pd.read_csv(io.StringIO(r.text)).iloc[:, 1], errors="coerce").dropna()
    return 2.0 * math.log1p(float(s.iloc[-1]) / 200.0)


def _pick_expiries(options, today):
    days = {e: (date.fromisoformat(e) - today).days for e in options}
    live = [e for e in options if days[e] >= 7]
    # third-Friday expiries are where the quotes are; fall back to anything
    monthly = [e for e in live if date.fromisoformat(e).weekday() in (3, 4) and 14 <= date.fromisoformat(e).day <= 21]
    pool = monthly or live
    return sorted({min(pool, key=lambda e: abs(days[e] - t)) for t in TARGET_DAYS}) if pool else []


def _fetch_live(ticker):
    import yfinance as yf

    tk = yf.Ticker(ticker)
    h = tk.history(period="2y", auto_adjust=False)
    if len(h) < 60:
        raise RuntimeError("price history is empty")
    h = h.dropna(subset=["Close"])
    prices = pd.DataFrame({"date": [d.date().isoformat() for d in h.index], "open": h["Open"].to_numpy(),
                           "high": h["High"].to_numpy(), "low": h["Low"].to_numpy(),
                           "close": h["Close"].to_numpy(), "dividend": h["Dividends"].to_numpy()})
    spot, notes = float(prices["close"].iloc[-1]), []
    try:
        rate = fetch_rate()
    except Exception as e:  # noqa: BLE001 - any failure means "no live rate"
        rate = _snapshot_rate()
        notes.append(f"FRED unavailable ({type(e).__name__}); rate taken from the snapshot")
    frames = []
    for e in _pick_expiries(tk.options, date.today()):
        ch = tk.option_chain(e)
        for side, df in (("call", ch.calls), ("put", ch.puts)):
            if len(df):
                frames.append(pd.DataFrame({"expiry": e, "type": side, "strike": df["strike"], "bid": df["bid"],
                                            "ask": df["ask"], "last": df["lastPrice"], "volume": df["volume"],
                                            "open_interest": df["openInterest"]}))
    chain = pd.concat(frames, ignore_index=True) if frames else pd.DataFrame(columns=CHAIN_COLS)
    if len(chain):
        chain = chain[chain["strike"].between(0.5 * spot, 1.6 * spot)].fillna(0.0).reset_index(drop=True)
    if not len(chain):
        notes.append("no option chain returned")
    return MarketData(ticker, LIVE, prices["date"].iloc[-1], spot, rate, _ttm_yield(prices, spot), prices, chain, notes)


# -------------------------------------------------------------------- snapshot
def _read(name):
    return pd.read_csv(DATA / name)


def _snapshot_rate():
    try:
        return float(_read("snapshot_meta.csv")["rate"].iloc[0])
    except Exception:  # noqa: BLE001
        return 0.04


def _load_snapshot(ticker):
    meta = _read("snapshot_meta.csv").set_index("ticker").loc[ticker]
    prices = _read("snapshot_prices.csv").query("ticker == @ticker")[PRICE_COLS].reset_index(drop=True)
    chain = _read("snapshot_chains.csv").query("ticker == @ticker")[CHAIN_COLS].reset_index(drop=True)
    return MarketData(ticker, SNAPSHOT, str(meta["asof"]), float(meta["spot"]), float(meta["rate"]),
                      float(meta["div_yield"]), prices, chain)


def refresh_snapshot(tickers=TICKERS):
    """Fetch everything live and overwrite data/snapshot_*.csv."""
    meta, prices, chains = [], [], []
    for t in tickers:
        m = _fetch_live(t)
        if not len(m.chain):
            raise RuntimeError(f"{t}: no option chain, snapshot left unchanged")
        meta.append({"ticker": t, "asof": m.asof, "spot": m.spot, "rate": m.rate, "div_yield": m.div_yield,
                     "fetched_utc": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M")})
        prices.append(m.prices.round(4).assign(ticker=t)[["ticker"] + PRICE_COLS])
        quoted = m.chain[(m.chain["bid"] > 0) & (m.chain["ask"] > m.chain["bid"])]
        chains.append(quoted.assign(ticker=t)[["ticker"] + CHAIN_COLS])
        print(f"{t}: spot {m.spot:.2f}, {len(m.prices)} days, {len(quoted)} quotes, q {m.div_yield:.4f}, r {m.rate:.4f}")
        time.sleep(1.0)  # be polite
    DATA.mkdir(exist_ok=True)
    for name, df in (("meta", pd.DataFrame(meta)), ("prices", pd.concat(prices)), ("chains", pd.concat(chains))):
        df.to_csv(DATA / f"snapshot_{name}.csv", index=False, lineterminator="\n")


# ------------------------------------------------------------------- synthetic
def synthetic(ticker="SPY", seed=0, days=504):
    """Two years of Merton daily closes plus a chain priced by the series (with a bid-ask spread)."""
    spot0, sigma = _SYNTH.get(ticker, (100, .25))
    lam, mu_j, delta, r, q = 1.5, -.04, .05, .04, .01
    g = np.random.Generator(np.random.PCG64(np.random.SeedSequence(int(seed), spawn_key=(sum(map(ord, ticker)),))))
    dt, k = 1 / 252, an.merton_k(mu_j, delta)
    n = g.poisson(lam * dt, days)
    x = (0.07 - .5 * sigma**2 - lam * k) * dt + sigma * math.sqrt(dt) * g.standard_normal(days) \
        + n * mu_j + np.sqrt(n) * delta * g.standard_normal(days)
    close = spot0 * np.exp(np.cumsum(x))
    open_ = np.concatenate([[spot0], close[:-1]])
    wiggle = sigma * math.sqrt(dt) * np.abs(g.standard_normal((2, days))) * .5
    dates = pd.bdate_range(end=pd.Timestamp(date.today()), periods=days)
    prices = pd.DataFrame({"date": dates.strftime("%Y-%m-%d"), "open": open_, "high": np.maximum(open_, close) * np.exp(wiggle[0]),
                           "low": np.minimum(open_, close) * np.exp(-wiggle[1]), "close": close, "dividend": 0.0})
    spot, today, rows = float(close[-1]), dates[-1].date(), []
    for d in TARGET_DAYS:
        T = d / 365
        step = max(round(spot * .01), 1)
        for K in np.arange(round(spot * .75 / step) * step, spot * 1.25, step):
            for side in ("call", "put"):
                mid = an.merton_series(spot, K, T, r, q, sigma, lam, mu_j, delta, side)
                half = max(.01, .004 * mid)
                if mid - half > .01:
                    rows.append(((today + timedelta(days=d)).isoformat(), side, float(K), mid - half, mid + half, mid, 100, 1000))
    chain = pd.DataFrame(rows, columns=CHAIN_COLS)
    return MarketData(ticker, SYNTHETIC, today.isoformat(), spot, r, q, prices, chain,
                      [f"simulated Merton path, seed {seed}; not market data"])


# ---------------------------------------------------------------------- loader
def load(ticker, mode="auto", seed=0, deadline=DEADLINE) -> MarketData:
    """mode: auto | live | snapshot | synthetic. Falls through LIVE -> SNAPSHOT -> SYNTHETIC."""
    if ticker not in TICKERS:
        raise ValueError(f"unknown ticker {ticker}")
    notes = []
    if mode in ("auto", "live"):
        pool = ThreadPoolExecutor(max_workers=1)
        try:
            return pool.submit(_fetch_live, ticker).result(timeout=deadline)
        except Exception as e:  # noqa: BLE001 - any failure must fall through to the snapshot
            detail = f": {str(e)[:120]}" if str(e) else ""
            notes.append(f"live fetch failed ({type(e).__name__}{detail})")
        finally:
            pool.shutdown(wait=False)
    if mode != "synthetic":
        try:
            m = _load_snapshot(ticker)
            m.notes = notes + m.notes
            return m
        except Exception as e:  # noqa: BLE001
            notes.append(f"snapshot unavailable ({type(e).__name__})")
    m = synthetic(ticker, seed)
    m.notes = notes + m.notes
    return m


if __name__ == "__main__":
    refresh_snapshot()
