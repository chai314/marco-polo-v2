"""The data layer must always return something usable and must say where it came from."""
import numpy as np
import pytest

from vropt import analytic as an
from vropt import calibrate, data


def test_synthetic_is_seeded_and_labelled():
    a, b, c = data.synthetic("SPY", 1), data.synthetic("SPY", 1), data.synthetic("SPY", 2)
    assert a.source == data.SYNTHETIC and a.prices.equals(b.prices) and not a.prices["close"].equals(c.prices["close"])
    assert (a.prices["low"] <= a.prices["close"]).all() and (a.prices["high"] >= a.prices["close"]).all()


def test_fallback_order(monkeypatch, tmp_path):
    def boom(_):
        raise ConnectionError("offline")

    monkeypatch.setattr(data, "_fetch_live", boom)
    m = data.load("SPY", "auto")
    assert m.source == data.SNAPSHOT and "ConnectionError" in m.notes[0]
    monkeypatch.setattr(data, "DATA", tmp_path)
    m = data.load("SPY", "auto")
    assert m.source == data.SYNTHETIC and len(m.notes) == 3


def test_hung_network_hits_the_deadline(monkeypatch):
    import time

    monkeypatch.setattr(data, "_fetch_live", lambda t: time.sleep(3))
    t0 = time.time()
    assert data.load("QQQ", "live", deadline=.2).source == data.SNAPSHOT
    assert time.time() - t0 < 2


@pytest.mark.parametrize("ticker", data.TICKERS)
def test_snapshot_complete(ticker):
    m = data.load(ticker, "snapshot")
    assert m.source == data.SNAPSHOT and len(m.prices) > 400 and len(m.chain) > 100
    assert 0 < m.spot and 0 <= m.div_yield < .1 and 0 < m.rate < .15
    assert m.spot == pytest.approx(m.prices["close"].iloc[-1], rel=1e-3)
    smiles = [s for s in (calibrate.build_smile(m, e) for e in m.expiries()) if s is not None]
    assert len(smiles) >= 2 and all(.03 < s.atm_iv < 2 for s in smiles)


def test_implied_vol_round_trip():
    K = np.array([70., 90, 100, 110, 140])
    px = an.black_scholes(100, K, .5, .04, .01, .33, "put")
    assert calibrate.implied_vol(px, 100, K, .5, .04, .01, "put") == pytest.approx(.33, abs=1e-6)
    assert np.isnan(calibrate.implied_vol(150.0, 100, 100.0, .5, .04, .01, "call"))


def test_merton_strip_is_the_series():
    K = np.array([80., 100, 120])
    want = [an.merton_series(100, k, .5, .04, .01, .2, 1.2, -.1, .15) for k in K]
    assert calibrate.merton_strip(100, K, .5, .04, .01, .2, 1.2, -.1, .15) == pytest.approx(want, abs=1e-10)


def test_fit_recovers_a_synthetic_smile():
    m = data.synthetic("SPY", 3)
    smile = calibrate.build_smile(m, m.expiries()[1])
    fit = calibrate.fit_merton(smile, m)
    assert fit.rmse_iv < .002 < fit.rmse_flat
