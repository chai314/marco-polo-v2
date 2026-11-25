"""The four products as `Problem`s: what to draw, the payoff on those draws, and the controls.

A Problem knows nothing about budgets, strata, pilots or confidence intervals; that is
the engine's job. It declares how many normals and uniforms one path needs and maps
them to (discounted payoff, control values). Coordinate 0 is always the one the engine
stratifies, and the antithetic partner of (z, u) is always (-z, 1-u).
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field

import numpy as np
from scipy.special import ndtri

from . import analytic as an
from . import rng

A, C, S, K = "A", "C", "S", "K"
METHOD_NAMES = {A: "Antithetic", C: "Control variate", S: "Stratification", K: "Conditioning"}
ALL_METHODS = (A, C, S, K)


@dataclass(frozen=True)
class Problem:
    S0: float = 100.0
    strike: float = 100.0
    T: float = 1.0
    r: float = 0.04
    q: float = 0.0
    sigma: float = 0.2
    kind: str = "call"

    product = ""
    methods = (A, C, S)

    def __post_init__(self):
        for name in ("S0", "strike", "T", "sigma"):
            if not getattr(self, name) > 0:
                raise ValueError(f"{name} must be positive")
        if self.kind not in ("call", "put"):
            raise ValueError("kind must be 'call' or 'put'")

    @property
    def phi(self):
        return 1.0 if self.kind == "call" else -1.0

    @property
    def disc(self):
        return math.exp(-self.r * self.T)

    def why_not(self, method):
        """One sentence for the greyed-out toggle."""
        return ""

    def dims(self, flags):
        raise NotImplementedError

    def control_means(self, flags):
        raise NotImplementedError

    def path(self, z, u, flags):
        raise NotImplementedError

    def reference(self):
        raise NotImplementedError


# ------------------------------------------------------------------- European
@dataclass(frozen=True)
class EuropeanGBM(Problem):
    product = "european"
    methods = (A, C, S)

    def why_not(self, method):
        return ("Under GBM, conditioning would integrate out the only random number and return "
                "Black-Scholes. Switch to Merton jumps to use it.") if method == K else ""

    def dims(self, flags):
        return 1, 0

    def control_means(self, flags):
        return np.array([self.S0 * math.exp(-self.q * self.T)])

    def path(self, z, u, flags):
        sT = self.S0 * np.exp((self.r - self.q - 0.5 * self.sigma**2) * self.T
                              + self.sigma * math.sqrt(self.T) * z[:, 0])
        y = self.disc * np.maximum(self.phi * (sT - self.strike), 0.0)
        return y, (self.disc * sT)[:, None]

    def reference(self):
        return an.black_scholes(self.S0, self.strike, self.T, self.r, self.q, self.sigma, self.kind)


@dataclass(frozen=True)
class EuropeanMerton(Problem):
    lam: float = 0.8
    mu_j: float = -0.1
    delta: float = 0.15
    product = "merton"
    methods = ALL_METHODS

    def __post_init__(self):
        super().__post_init__()
        if self.lam < 0 or self.delta < 0:
            raise ValueError("jump intensity and jump volatility must be non-negative")

    @property
    def k(self):
        return an.merton_k(self.mu_j, self.delta)

    @property
    def cdf(self):
        return an.poisson_table(self.lam * self.T)[1]

    def dims(self, flags):
        return (0, 1) if K in flags else (2, 1)

    def control_means(self, flags):
        fwd = self.S0 * math.exp(-self.q * self.T)
        if K in flags:  # controls: conditional discounted forward, and the jump count itself
            return np.array([fwd, self.lam * self.T])
        # controls: discounted spot, and the vanilla on the jump-free part of the same path
        return np.array([fwd, an.black_scholes(self.S0, self.strike, self.T, self.r, self.q, self.sigma, self.kind)])

    def counts(self, u):
        cdf = self.cdf
        return np.minimum(np.searchsorted(cdf, u, side="left"), len(cdf) - 1)

    def path(self, z, u, flags):
        n = self.counts(u[:, 0])
        comp = -self.lam * self.k * self.T
        if K in flags:
            levels = np.arange(len(self.cdf))
            table = an.merton_conditional(self.S0, self.strike, self.T, self.r, self.q, self.sigma,
                                          self.lam, self.mu_j, self.delta, levels, self.kind)
            fwd = self.S0 * np.exp(-self.q * self.T + comp + levels * math.log1p(self.k))
            return table[n], np.column_stack([fwd[n], n.astype(float)])
        base = self.S0 * np.exp((self.r - self.q - 0.5 * self.sigma**2) * self.T
                                + self.sigma * math.sqrt(self.T) * z[:, 0])
        sT = base * np.exp(comp + n * self.mu_j + np.sqrt(n) * self.delta * z[:, 1])
        y = self.disc * np.maximum(self.phi * (sT - self.strike), 0.0)
        smooth = self.disc * np.maximum(self.phi * (base - self.strike), 0.0)
        return y, np.column_stack([self.disc * sT, smooth])

    def reference(self):
        return an.merton_series(self.S0, self.strike, self.T, self.r, self.q, self.sigma,
                                self.lam, self.mu_j, self.delta, self.kind)


# ---------------------------------------------------------------------- Asian
@dataclass(frozen=True)
class AsianArithmetic(Problem):
    m: int = 50
    product = "asian"
    methods = (A, C, S)

    def why_not(self, method):
        return ("No useful conditional expectation is available in closed form for the arithmetic "
                "average; the geometric control does that job.") if method == K else ""

    def weights(self):
        """Unit vector of the geometric average in increment space: the direction that
        explains most of the arithmetic payoff's variance."""
        w = np.arange(self.m, 0, -1, dtype=float)
        return w / math.sqrt(float(np.dot(w, w)))

    def dims(self, flags):
        return self.m + (S in flags), 0

    def control_means(self, flags):
        return np.array([an.geometric_asian(self.S0, self.strike, self.T, self.r, self.q,
                                            self.sigma, self.m, self.kind)])

    def path(self, z, u, flags):
        if S in flags:
            a = self.weights()
            rest = z[:, 1:]
            z = rest + (z[:, 0] - rest @ a)[:, None] * a[None, :]
        dt = self.T / self.m
        x = np.cumsum((self.r - self.q - 0.5 * self.sigma**2) * dt + self.sigma * math.sqrt(dt) * z, axis=1)
        arith = self.S0 * np.exp(x).mean(axis=1)
        geo = self.S0 * np.exp(x.mean(axis=1))
        y = self.disc * np.maximum(self.phi * (arith - self.strike), 0.0)
        c = self.disc * np.maximum(self.phi * (geo - self.strike), 0.0)
        return y, c[:, None]

    def reference(self):
        return an.arithmetic_asian(self.S0, self.strike, self.T, self.r, self.q, self.sigma, self.m, self.kind)


# -------------------------------------------------------------------- barrier
MODES = ("bridge", "naive", "shifted")


@dataclass(frozen=True)
class Barrier(Problem):
    barrier: float = 85.0
    direction: str = "down"
    knock: str = "out"
    mode: str = "bridge"
    m: int = 50
    product = "barrier"

    def __post_init__(self):
        super().__post_init__()
        if self.direction not in ("up", "down") or self.knock not in ("in", "out") or self.mode not in MODES:
            raise ValueError("invalid barrier specification")
        if (self.direction == "down") != (self.barrier < self.S0) or self.barrier == self.S0 or self.barrier <= 0:
            raise ValueError(f"a {self.direction} barrier must start on the live side of spot")

    @property
    def methods(self):
        return ALL_METHODS if self.mode == "bridge" else (A, C, S)

    def why_not(self, method):
        return ("Conditioning replaces the simulated barrier hit by its Brownian-bridge probability, "
                "so it needs the bridge monitoring mode.") if method == K and self.mode != "bridge" else ""

    @property
    def level(self):
        """Barrier used on the grid."""
        if self.mode == "shifted":
            h = an.bgk_shift(self.barrier, self.sigma, self.T / self.m, self.direction, toward_spot=True)
            # a coarse grid can push the shifted barrier through spot; the option is then already hit
            return h
        return self.barrier

    def dims(self, flags):
        return self.m + (S in flags), int(self.mode == "bridge" and K not in flags)

    def control_means(self, flags):
        return np.array([self.S0 * math.exp(-self.q * self.T),
                         an.black_scholes(self.S0, self.strike, self.T, self.r, self.q, self.sigma, self.kind)])

    def path(self, z, u, flags):
        n = len(z)
        if S in flags:  # stratify the terminal Brownian value
            a = 1.0 / math.sqrt(self.m)
            rest = z[:, 1:]
            z = rest + a * (z[:, 0] - a * rest.sum(axis=1))[:, None]
        dt = self.T / self.m
        sd = self.sigma * math.sqrt(dt)
        x = np.cumsum((self.r - self.q - 0.5 * self.sigma**2) * dt + sd * z, axis=1)
        sT = self.S0 * np.exp(x[:, -1])
        sgn = 1.0 if self.direction == "down" else -1.0
        # distance to the barrier in log space, positive while alive
        h = math.log(self.level / self.S0)
        gap = np.empty((n, self.m + 1))
        gap[:, 0] = sgn * -h
        gap[:, 1:] = sgn * (x - h)
        on_grid = (gap > 0.0).all(axis=1)
        if self.mode == "bridge":
            p_hit = np.exp(np.minimum(-2.0 * gap[:, :-1] * gap[:, 1:] / (sd * sd), 0.0))
            surv = np.where(on_grid, np.prod(1.0 - p_hit, axis=1), 0.0)
            if K not in flags:
                surv = (u[:, 0] < surv).astype(float)
        else:
            surv = on_grid.astype(float)
        vanilla = self.disc * np.maximum(self.phi * (sT - self.strike), 0.0)
        y = vanilla * (surv if self.knock == "out" else 1.0 - surv)
        return y, np.column_stack([self.disc * sT, vanilla])

    def reference(self):
        """Continuous-monitoring price: the target of `bridge`, approached by `shifted`,
        and missed by `naive` at any finite m."""
        return an.barrier_price(self.S0, self.strike, self.barrier, self.T, self.r, self.q, self.sigma,
                                self.direction, self.knock, self.kind)


# ------------------------------------------------------------------- American
@dataclass(frozen=True)
class AmericanPut(Problem):
    kind: str = "put"
    m: int = 50
    n_fit: int = 20000
    fit_seed: int = 20221
    _cache: dict = field(default_factory=dict, compare=False, repr=False)
    product = "american"
    methods = (A, C)

    def __post_init__(self):
        super().__post_init__()
        if self.kind != "put":
            raise ValueError("the American module prices puts")

    def why_not(self, method):
        return {S: "Stopping times depend on the whole path, so stratifying one projection buys little; "
                   "left out of v1 by design.",
                K: "No closed-form conditional expectation exists once early exercise is allowed."}.get(method, "")

    def dims(self, flags):
        return self.m, 0

    def control_means(self, flags):
        return np.array([an.black_scholes(self.S0, self.strike, self.T, self.r, self.q, self.sigma, "put")])

    def _paths(self, z):
        dt = self.T / self.m
        return self.S0 * np.exp(np.cumsum((self.r - self.q - 0.5 * self.sigma**2) * dt
                                          + self.sigma * math.sqrt(dt) * z, axis=1))

    def policy(self):
        """Longstaff-Schwartz continuation coefficients, fitted once on their own stream.

        Row i holds the cubic in x = S/K for exercise date i+1; NaN means never exercise.
        Pricing uses fresh paths, so the estimate is low-biased rather than foresight-biased."""
        if "policy" not in self._cache:
            block, out, b = 4096, [], 0
            while b * block < self.n_fit:
                u = rng.generator(self.fit_seed, rng.POLICY, b).random((min(block, self.n_fit - b * block), self.m))
                out.append(self._paths(ndtri(rng.clip(u))))
                b += 1
            s = np.vstack(out)
            x = s / self.strike
            step = math.exp(-self.r * self.T / self.m)
            coef = np.full((self.m, 4), np.nan)
            cash = np.maximum(1.0 - x[:, -1], 0.0)
            for i in range(self.m - 2, -1, -1):
                cash = cash * step
                itm = x[:, i] < 1.0
                if itm.sum() >= 50:
                    xi = x[itm, i]
                    basis = np.column_stack([np.ones_like(xi), xi, xi * xi, xi * xi * xi])
                    beta = np.linalg.lstsq(basis, cash[itm], rcond=None)[0]
                    coef[i] = beta
                    ex = 1.0 - xi
                    cash[itm] = np.where(ex > basis @ beta, ex, cash[itm])
            self._cache["policy"] = coef
        return self._cache["policy"]

    def path(self, z, u, flags):
        coef = self.policy()
        s = self._paths(z)
        n, dt = len(s), self.T / self.m
        stop = np.full(n, self.m - 1)
        alive = np.ones(n, bool)
        for i in range(self.m - 1):
            if np.isnan(coef[i, 0]):
                continue
            x = s[:, i] / self.strike
            cont = coef[i, 0] + x * (coef[i, 1] + x * (coef[i, 2] + x * coef[i, 3]))
            go = alive & (x < 1.0) & (1.0 - x > cont)
            stop[go] = i
            alive &= ~go
        s_tau = s[np.arange(n), stop]
        t = (stop + 1) * dt
        left = np.where(stop == self.m - 1, 0.0, self.T - t)
        d = np.exp(-self.r * t)
        y = d * np.maximum(self.strike - s_tau, 0.0)
        # European put sampled at the exercise time: a stopped martingale with known mean
        c = d * an.black_scholes(s_tau, self.strike, left, self.r, self.q, self.sigma, "put")
        return y, c[:, None]

    def reference(self):
        return an.binomial(self.S0, self.strike, self.T, self.r, self.q, self.sigma, "put", "bermudan",
                           steps=2000, dates=self.m)

    def continuous_reference(self):
        return an.binomial(self.S0, self.strike, self.T, self.r, self.q, self.sigma, "put", "american", steps=2000)
