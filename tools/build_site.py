"""Build the two generated files the static site needs.

    python tools/build_site.py             # both, from committed data
    python tools/build_site.py --refresh   # fetch new market data first (yfinance, FRED)
    python tools/build_site.py --data-only # skip the WebAssembly compile

docs/js/engine.wasm.js   the C++ engine compiled to WebAssembly, base64 so it also works from file://
docs/js/market.js        prices, quotes and Merton fits for the six tickers
"""
from __future__ import annotations

import argparse
import base64
import json
import math
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
OUT = ROOT / "docs" / "js"


def build_wasm():
    """Needs `pip install ziglang` (a self-contained clang with a WebAssembly libc++)."""
    with tempfile.TemporaryDirectory() as tmp:
        wasm = Path(tmp) / "vropt.wasm"
        cmd = [sys.executable, "-m", "ziglang", "c++", "-target", "wasm32-wasi", "-std=c++20", "-O3", "-fno-exceptions",
               "-fno-rtti", "-DVROPT_NO_THREADS", "-mexec-model=reactor", f"-I{ROOT / 'cpp' / 'include'}",
               str(ROOT / "cpp" / "src" / "capi.cpp"), "-o", str(wasm), "-Wl,--export=malloc", "-Wl,--export=free",
               "-Wl,--export-dynamic", "-Wl,--strip-all"]
        subprocess.run(cmd, check=True)
        raw = wasm.read_bytes()
    (OUT / "engine.wasm.js").write_text(f'window.VROPT_WASM="{base64.b64encode(raw).decode()}";\n', encoding="ascii", newline="\n")
    print(f"engine.wasm.js: {len(raw) / 1024:.0f} KB of WebAssembly")


def num(x, d=6):
    x = float(x)
    return None if not math.isfinite(x) else round(x, d)


def build_data():
    from vropt import calibrate, data

    out = {}
    for t in data.TICKERS:
        m = data.load(t, "snapshot")
        if m.source != data.SNAPSHOT:
            raise SystemExit(f"{t}: no committed snapshot ({'; '.join(m.notes)})")
        smiles = []
        for e in m.expiries():
            s = calibrate.build_smile(m, e)
            if s is None:
                continue
            f = calibrate.fit_merton(s, m)
            q = s.table
            smiles.append({"expiry": e, "T": num(s.T), "forward": num(s.forward, 4), "q": num(s.q_implied), "atm": num(s.atm_iv),
                           "fit": {"sigma": num(f.sigma), "lam": num(f.lam), "mu_j": num(f.mu_j), "delta": num(f.delta)},
                           "rmse": num(f.rmse_iv), "rmse_flat": num(f.rmse_flat),
                           "K": [num(x, 4) for x in q["strike"]], "call": [int(x == "call") for x in q["type"]],
                           "bid": [num(x, 4) for x in q["bid"]], "ask": [num(x, 4) for x in q["ask"]],
                           "iv": [num(x) for x in q["iv"]], "model": [num(x) for x in f.model_iv]})
        out[t] = {"asof": m.asof, "spot": num(m.spot, 4), "rate": num(m.rate), "q": num(m.div_yield), "vol": num(m.realised_vol()),
                  "dates": list(m.prices["date"]), "close": [num(x, 2) for x in m.prices["close"]], "smiles": smiles}
    (OUT / "market.js").write_text("window.MARKET=" + json.dumps(out, separators=(",", ":")) + ";\n", encoding="ascii", newline="\n")
    print(f"market.js: {(OUT / 'market.js').stat().st_size / 1024:.0f} KB")


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--refresh", action="store_true")
    ap.add_argument("--data-only", action="store_true")
    args = ap.parse_args()
    OUT.mkdir(parents=True, exist_ok=True)
    if args.refresh:
        from vropt import data

        data.refresh_snapshot()
    build_data()
    if not args.data_only:
        build_wasm()
