"""Estimation engine: turns a Problem plus a set of methods into a price with an honest error bar.

Budget accounting. Everything is charged in simulated *paths*: an antithetic unit costs
two, and pilot paths used to fit the control coefficient come out of the same budget.
The variance-reduction factor is therefore Var(plain)/Var(method) at equal path count.
(The Longstaff-Schwartz policy is fitted once on its own paths, identically for every
method, so it is excluded from the comparison.)
"""
from __future__ import annotations

import itertools
import math
import time
from dataclasses import dataclass

import numpy as np
from scipy.special import ndtri

from . import native, rng
from .problems import ALL_METHODS, A, C, K, S, Problem

Z95 = 1.959963984540054
BLOCK_NUMBERS = 2**17


def canon(methods) -> frozenset:
    f = frozenset(methods)
    if not f <= set(ALL_METHODS):
        raise ValueError(f"unknown methods {f - set(ALL_METHODS)}")
    return f


def label(methods) -> str:
    """'Plain' or e.g. 'A+C+S' in the fixed A, C, S, K order."""
    return "+".join(m for m in ALL_METHODS if m in methods) or "Plain"


def combinations(problem: Problem):
    """All non-empty applicable subsets: 15 for Merton and bridge barriers, 7 Asian, 3 American."""
    ms = problem.methods
    return [frozenset(c) for k in range(1, len(ms) + 1) for c in itertools.combinations(ms, k)]


@dataclass(frozen=True)
class Plan:
    flags: frozenset
    ppu: int            # paths per unit (2 when antithetic)
    H: int              # strata
    rounds: int         # units per stratum in the pricing run
    pilot_rounds: int   # units per stratum in the pilot
    block_rounds: int

    @property
    def paths(self):
        return (self.rounds + self.pilot_rounds) * self.H * self.ppu

    @property
    def blocks(self):
        return -(-self.rounds // self.block_rounds)

    def rounds_in(self, b, pilot=False):
        total = self.pilot_rounds if pilot else self.rounds
        return min(self.block_rounds, total - b * self.block_rounds)


def make_plan(problem, methods, n_paths, strata=64, pilot_frac=0.05) -> Plan:
    flags = canon(methods)
    bad = flags - set(problem.methods)
    if bad:
        raise ValueError(f"{label(bad)} is not applicable to {problem.product}")
    ppu = 2 if A in flags else 1
    units = n_paths // ppu
    H = max(2, min(strata, units // 16)) if S in flags else 1
    per = units // H
    pilot = 0
    if C in flags:
        pilot = max(math.ceil(pilot_frac * per), 4 if H > 1 else 100)
        pilot = min(pilot, per // 2)
    rounds = per - pilot
    if rounds < 2 or (C in flags and pilot * H < 8):
        raise ValueError("path budget too small for this method combination")
    nz, nu = problem.dims(flags)
    block = max(1, min(4096, BLOCK_NUMBERS // (nz + nu)) // H)
    return Plan(flags, ppu, H, rounds, pilot, block)


# ----------------------------------------------------------- NumPy block kernel
def draw_block(problem, plan, seed, stream, block, rounds):
    """Unit values for one block: Y (rounds, H) and controls (rounds, H, p)."""
    nz, nu = problem.dims(plan.flags)
    n = rounds * plan.H
    u = rng.generator(seed, stream, block).random((n, nz + nu))
    if S in plan.flags:
        u[:, 0] = (np.tile(np.arange(plan.H), rounds) + u[:, 0]) / plan.H
        if A in plan.flags:  # a pair is symmetric in z, so stratifying half the line suffices
            u[:, 0] *= 0.5
    u = rng.clip(u)
    z, v = ndtri(u[:, :nz]), u[:, nz:]
    y, c = problem.path(z, v, plan.flags)
    if A in plan.flags:
        y2, c2 = problem.path(-z, 1.0 - v, plan.flags)
        y, c = 0.5 * (y + y2), 0.5 * (c + c2)
    return y.reshape(rounds, plan.H), c.reshape(rounds, plan.H, -1)


def solve_beta(scc, scy):
    """Control coefficients from pooled within-stratum cross products. One or two controls;
    a degenerate or collinear control is dropped rather than inverted."""
    p = len(scy)
    beta = np.zeros(p)
    ok = [j for j in range(p) if scc[j, j] > 0.0]
    if not ok:
        return beta
    if len(ok) == 2:
        det = scc[0, 0] * scc[1, 1] - scc[0, 1] ** 2
        if det > 1e-9 * scc[0, 0] * scc[1, 1]:
            beta[0] = (scc[1, 1] * scy[0] - scc[0, 1] * scy[1]) / det
            beta[1] = (scc[0, 0] * scy[1] - scc[0, 1] * scy[0]) / det
            return beta
        # collinear: keep the control that explains more
        ok = [0] if scy[0] ** 2 * scc[1, 1] >= scy[1] ** 2 * scc[0, 0] else [1]
    beta[ok[0]] = scy[ok[0]] / scc[ok[0], ok[0]]
    return beta


def _pilot_numpy(problem, plan, seed):
    ys, cs = [], []
    for b in range(-(-plan.pilot_rounds // plan.block_rounds)):
        y, c = draw_block(problem, plan, seed, rng.PILOT, b, plan.rounds_in(b, pilot=True))
        ys.append(y)
        cs.append(c)
    y, c = np.concatenate(ys), np.concatenate(cs)
    dy, dc = y - y.mean(axis=0), c - c.mean(axis=0)
    return solve_beta(np.einsum("rhi,rhj->ij", dc, dc), np.einsum("rhi,rh->i", dc, dy))


def _run_numpy(problem, plan, seed, beta, b0, b1):
    acc = Accumulator(plan.H)
    mu = problem.control_means(plan.flags)
    for b in range(b0, b1):
        y, c = draw_block(problem, plan, seed, rng.MAIN, b, plan.rounds_in(b))
        if beta is not None:
            y = y - (c - mu) @ beta
        acc.merge(len(y), y.mean(axis=0), ((y - y.mean(axis=0)) ** 2).sum(axis=0))
    return acc


class Accumulator:
    """Per-stratum count, mean and sum of squares, merged with Chan's update."""

    def __init__(self, H):
        self.n, self.mean, self.M2 = 0, np.zeros(H), np.zeros(H)

    def merge(self, n, mean, M2):
        if n == 0:
            return
        tot = self.n + n
        d = mean - self.mean
        self.mean = self.mean + d * (n / tot)
        self.M2 = self.M2 + M2 + d * d * (self.n * n / tot)
        self.n = tot

    @property
    def estimate(self):
        return float(self.mean.mean())

    @property
    def se(self):
        if self.n < 2:
            return float("nan")
        H = len(self.mean)
        return math.sqrt(float(self.M2.sum()) / (self.n - 1) / self.n) / H


@dataclass(frozen=True)
class Estimate:
    methods: frozenset
    price: float
    se: float
    paths: int
    seconds: float
    beta: tuple
    backend: str

    @property
    def ci(self):
        return self.price - Z95 * self.se, self.price + Z95 * self.se

    @property
    def var_per_path(self):
        return self.se**2 * self.paths

    @property
    def name(self):
        return label(self.methods)


def vrf(plain: Estimate, other: Estimate) -> float:
    """Variance-reduction factor at equal path budget; inf only if `other` has zero sample variance."""
    return plain.var_per_path / other.var_per_path if other.var_per_path > 0 else float("inf")


# ------------------------------------------------------------------ public API
def pick_backend(backend="auto"):
    if backend == "auto":
        return "cpp" if native.available() else "numpy"
    if backend == "cpp" and not native.available():
        raise RuntimeError("C++ engine is not built: run `python -m vropt.native`")
    return backend


def stream(problem, methods=(), n_paths=40000, seed=7, strata=64, pilot_frac=0.05, backend="auto", updates=40):
    """Yield (rounds_done_paths, Estimate-so-far) as blocks finish: the live convergence feed."""
    plan = make_plan(problem, methods, n_paths, strata, pilot_frac)
    be = pick_backend(backend)
    handle = native.Handle(problem, plan) if be == "cpp" else None
    t0 = time.perf_counter()
    beta = None
    if C in plan.flags:
        beta = handle.pilot(seed) if handle else _pilot_numpy(problem, plan, seed)
    # finer blocks near the start would change the stream; instead group whole blocks
    acc = Accumulator(plan.H)
    step = max(1, math.ceil(plan.blocks / updates))
    for b0 in range(0, plan.blocks, step):
        b1 = min(b0 + step, plan.blocks)
        if handle:
            acc.merge(*handle.run(seed, beta, b0, b1))
        else:
            part = _run_numpy(problem, plan, seed, beta, b0, b1)
            acc.merge(part.n, part.mean, part.M2)
        done = (acc.n + plan.pilot_rounds) * plan.H * plan.ppu
        yield Estimate(plan.flags, acc.estimate, acc.se, done, time.perf_counter() - t0,
                       tuple(beta) if beta is not None else (), be)


def estimate(problem, methods=(), n_paths=40000, seed=7, strata=64, pilot_frac=0.05, backend="auto") -> Estimate:
    last = None
    for last in stream(problem, methods, n_paths, seed, strata, pilot_frac, backend, updates=1):
        pass
    return last


def trace(problem, methods=(), n_paths=40000, seed=7, strata=64, pilot_frac=0.05, points=60):
    """Running estimate and standard error on a log-spaced path grid, from a single stream.

    Uses the NumPy kernel with small blocks so that the early part of the curve is visible."""
    plan = make_plan(problem, methods, n_paths, strata, pilot_frac)
    beta = _pilot_numpy(problem, plan, seed) if C in plan.flags else None
    mu = problem.control_means(plan.flags)
    first = max(2, 64 // plan.H)
    marks = np.unique(np.geomspace(first, plan.rounds, points).astype(int))
    out, acc, buf, k = [], Accumulator(plan.H), [], 0
    for b in range(plan.blocks):
        y, c = draw_block(problem, plan, seed, rng.MAIN, b, plan.rounds_in(b))
        if beta is not None:
            y = y - (c - mu) @ beta
        pos, base = 0, b * plan.block_rounds
        while k < len(marks) and marks[k] <= base + len(y):
            seg = y[pos : marks[k] - base]
            if len(seg):
                acc.merge(len(seg), seg.mean(axis=0), ((seg - seg.mean(axis=0)) ** 2).sum(axis=0))
            pos = marks[k] - base
            out.append(((acc.n + plan.pilot_rounds) * plan.H * plan.ppu, acc.estimate, acc.se))
            k += 1
        seg = y[pos:]
        if len(seg):
            acc.merge(len(seg), seg.mean(axis=0), ((seg - seg.mean(axis=0)) ** 2).sum(axis=0))
    return np.array(out)


def replicate(problem, methods=(), n_paths=2000, reps=400, seed=11, strata=64, pilot_frac=0.05, backend="auto"):
    """`reps` independent estimates: arrays (price, se). Used for histograms and coverage."""
    plan = make_plan(problem, methods, n_paths, strata, pilot_frac)
    be = pick_backend(backend)
    if be == "cpp":
        return native.Handle(problem, plan).replicate(seed, reps)
    price, se = np.empty(reps), np.empty(reps)
    for i in range(reps):
        beta = _pilot_numpy(problem, plan, seed + 1 + i) if C in plan.flags else None
        acc = _run_numpy(problem, plan, seed + 1 + i, beta, 0, plan.blocks)
        price[i], se[i] = acc.estimate, acc.se
    return price, se


def coverage(prices, ses, truth):
    """Share of 95% intervals that contain `truth`."""
    return float(np.mean(np.abs(prices - truth) <= Z95 * ses))


def compare(problem, n_paths=40000, seed=7, strata=64, pilot_frac=0.05, backend="auto"):
    """Plain plus every applicable combination on the same path budget."""
    plain = estimate(problem, (), n_paths, seed, strata, pilot_frac, backend)
    rows = [estimate(problem, c, n_paths, seed, strata, pilot_frac, backend) for c in combinations(problem)]
    return plain, rows
