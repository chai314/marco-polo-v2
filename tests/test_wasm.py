"""The WebAssembly build that the site ships, run under Node, against the native C++ engine.

Both are compiled from the same sources, so with the same seed they must agree to rounding:
the browser numbers are the numbers the rest of the test suite checks.
"""
import json
import math
import shutil
import subprocess
from pathlib import Path

import pytest

import vropt as v
from vropt import native

from test_vropt import EVERY, grid, name

RUNNER = Path(__file__).with_name("wasm_runner.cjs")
needs = pytest.mark.skipif(not shutil.which("node") or not native.ensure(), reason="needs Node and the native engine")
BITS = {"A": 1, "C": 2, "S": 4, "K": 8}
N, SEED, STRATA = 12000, 31, 64


def spec(p):
    """The page's contract object for a Problem."""
    s = {"product": p.product, "call": p.kind == "call", "S0": p.S0, "K": p.strike, "T": p.T, "r": p.r, "q": p.q,
         "sigma": p.sigma, "m": getattr(p, "m", 1)}
    if p.product == "merton":
        s.update(lam=p.lam, muJ=p.mu_j, delta=p.delta)
    if p.product == "barrier":
        s.update(H=p.barrier, down=p.direction == "down", knockIn=p.knock == "in", mode=p.mode)
    return s


def wasm(jobs):
    done = subprocess.run(["node", str(RUNNER)], input=json.dumps(jobs), capture_output=True, text=True, timeout=600)
    assert done.returncode == 0, done.stderr
    return json.loads(done.stdout)


CASES = grid(EVERY)


@pytest.fixture(scope="module")
def browser():
    jobs = [{"op": "estimate", "args": {"spec": spec(p), "flags": sum(BITS[f] for f in c), "n": N, "seed": SEED, "strata": STRATA}}
            for p, c in (case.values for case in CASES)]
    jobs += [{"op": "reference", "args": {"spec": spec(p)}} for p in EVERY]
    out = wasm(jobs)
    return out[: len(CASES)], out[len(CASES):]


@needs
@pytest.mark.parametrize("problem,methods", CASES)
def test_wasm_equals_native(browser, problem, methods):
    got = browser[0][[c.values for c in CASES].index((problem, methods))]
    ref = v.estimate(problem, methods, N, seed=SEED, strata=STRATA, backend="cpp")
    assert got["price"] == pytest.approx(ref.price, rel=1e-9)
    assert got["se"] == pytest.approx(ref.se, rel=1e-6)
    assert got["paths"] == ref.paths


@needs
@pytest.mark.parametrize("problem", EVERY, ids=name)
def test_wasm_reference(browser, problem):
    got = browser[1][EVERY.index(problem)]
    want = native.Handle(problem, v.make_plan(problem, (), 1000)).reference()
    assert math.isfinite(got) and got == pytest.approx(want, rel=1e-9)
