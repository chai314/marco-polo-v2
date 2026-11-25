"""Deterministic prices: every Monte Carlo number in the app is checked against one of these.

Nothing here simulates. Closed forms where they exist, a one-dimensional
quadrature recursion for the discretely monitored arithmetic Asian (which has no
closed form), and a lattice for early exercise.
"""
from __future__ import annotations

import math

import numpy as np
from scipy.interpolate import CubicSpline
from scipy.special import ndtr

BGK_BETA = 0.5825971579390106  # -zeta(1/2)/sqrt(2*pi), Broadie-Glasserman-Kou (1997)


# --------------------------------------------------------------------- vanilla
def black_scholes(S, K, T, r, q, sigma, kind="call"):
    """European price. Vectorised in every argument; T=0 and sigma=0 are handled."""
    S, K, T, r, q, sigma = np.broadcast_arrays(*(np.asarray(a, float) for a in (S, K, T, r, q, sigma)))
    phi = 1.0 if kind == "call" else -1.0
    sd = sigma * np.sqrt(T)
    fwd_s = S * np.exp(-q * T)
    disc_k = K * np.exp(-r * T)
    safe = np.where(sd > 0, sd, 1.0)
    d1 = np.log(fwd_s / disc_k) / safe + 0.5 * safe
    value = phi * (fwd_s * ndtr(phi * d1) - disc_k * ndtr(phi * (d1 - safe)))
    out = np.where(sd > 0, value, np.maximum(phi * (fwd_s - disc_k), 0.0))
    return float(out) if out.ndim == 0 else out


def merton_k(mu_j, delta):
    """Expected relative jump size, E[e^J] - 1."""
    return math.exp(mu_j + 0.5 * delta * delta) - 1.0


def merton_conditional(S, K, T, r, q, sigma, lam, mu_j, delta, n, kind="call"):
    """Discounted price *given* n jumps. This is the conditional expectation that the
    'conditioning' method averages, and also the summand of Merton's series."""
    n = np.asarray(n, float)
    k = merton_k(mu_j, delta)
    vol_n = np.sqrt(sigma * sigma + n * delta * delta / T)
    # given n jumps, the forward is multiplied by (1+k)^n e^{-lam k T}
    spot_n = S * np.exp(-lam * k * T + n * math.log1p(k))
    return black_scholes(spot_n, K, T, r, q, vol_n, kind)


def poisson_table(mean, tol=1e-17):
    """(pmf, cdf) truncated once the upper tail is below double precision."""
    pmf, n = [], 0
    p = math.exp(-mean)
    while True:
        pmf.append(p)
        n += 1
        p *= mean / n
        if (n > mean and p < tol) or n > 1000:
            break
    pmf = np.array(pmf)
    return pmf, np.cumsum(pmf)


def merton_series(S, K, T, r, q, sigma, lam, mu_j, delta, kind="call"):
    pmf, _ = poisson_table(lam * T)
    vals = merton_conditional(S, K, T, r, q, sigma, lam, mu_j, delta, np.arange(len(pmf)), kind)
    return float(np.dot(pmf, np.atleast_1d(vals)))


# ----------------------------------------------------------------------- Asian
def geometric_asian(S, K, T, r, q, sigma, m, kind="call"):
    """Geometric average over t_i = iT/m, i = 1..m. Lognormal, hence Black-Scholes-like."""
    dt = T / m
    mean = math.log(S) + (r - q - 0.5 * sigma**2) * dt * (m + 1) / 2.0
    var = sigma**2 * dt * (m + 1) * (2 * m + 1) / (6.0 * m)
    sd = math.sqrt(var)
    phi = 1.0 if kind == "call" else -1.0
    fwd = math.exp(mean + 0.5 * var)
    d1 = (mean - math.log(K) + var) / sd
    return float(math.exp(-r * T) * phi * (fwd * ndtr(phi * d1) - K * ndtr(phi * (d1 - sd))))


def arithmetic_asian(S, K, T, r, q, sigma, m, kind="call", n_grid=1500, n_quad=40):
    """Arithmetic average, discretely monitored, by backward induction in one state.

    With Y_k the running sum, xi = (mK - Y_k)/S_k, homogeneity gives
    V_k = S_k v_k(xi) and v_k(xi) = E[e^X v_{k+1}(xi e^{-X} - 1)], X the log return.
    For xi <= 0 the option must finish in the money, so v is known exactly there.
    """
    dt = T / m
    mu, sd = (r - q - 0.5 * sigma**2) * dt, sigma * math.sqrt(dt)
    nodes, weights = np.polynomial.hermite_e.hermegauss(n_quad)
    weights = weights / weights.sum()
    ex = np.exp(mu + sd * nodes)
    growth = math.exp((r - q) * dt)

    def future(k):  # E[sum_{j>k} S_j]/S_k
        return sum(growth**j for j in range(1, m - k + 1))

    xi0 = m * K / S
    hi = max(3.0 * m, 2.5 * xi0) * math.exp(3.0 * sigma * math.sqrt(T))
    # Away from zero put grid points in proportion to xi^(1/2): curvature sits near xi ~ m.
    grid = hi * np.linspace(0.0, 1.0, n_grid) ** 1.5

    def last_step(xi):  # v_{m-1}: one lognormal step, exact
        xi = np.maximum(xi, 1e-300)
        d1 = (mu + sd * sd - np.log(xi)) / sd
        return growth * ndtr(d1) - xi * ndtr(d1 - sd)

    if m == 1:
        call = S * float(last_step(np.array([xi0]))[0])
    else:
        vals = last_step(grid)
        arg = grid[:, None] / ex[None, :] - 1.0
        for k in range(m - 2, -1, -1):
            spline = CubicSpline(grid, vals)
            fut = future(k + 1)
            inside = np.where(arg <= 0, fut - arg, np.where(arg < hi, spline(np.clip(arg, 0, hi)), 0.0))
            vals = np.maximum((inside * (ex * weights)[None, :]).sum(axis=1), 0.0)
        call = S * float(CubicSpline(grid, vals)(xi0))
    call *= math.exp(-r * T) / m
    if kind == "call":
        return call
    return call - math.exp(-r * T) * (S * future(0) / m - K)


# --------------------------------------------------------------------- barrier
def barrier_price(S, K, H, T, r, q, sigma, direction, knock, kind):
    """Continuously monitored single barrier (Reiner-Rubinstein, no rebate)."""
    breached = S <= H if direction == "down" else S >= H
    vanilla = black_scholes(S, K, T, r, q, sigma, kind)
    if breached:
        return vanilla if knock == "in" else 0.0
    phi = 1.0 if kind == "call" else -1.0
    eta = 1.0 if direction == "down" else -1.0
    b, sd = r - q, sigma * math.sqrt(T)
    mu = (b - 0.5 * sigma**2) / sigma**2
    shift = (1.0 + mu) * sd
    x1 = math.log(S / K) / sd + shift
    x2 = math.log(S / H) / sd + shift
    y1 = math.log(H * H / (S * K)) / sd + shift
    y2 = math.log(H / S) / sd + shift
    ds, dk = S * math.exp(-q * T), K * math.exp(-r * T)
    p1, p2 = (H / S) ** (2 * (mu + 1)), (H / S) ** (2 * mu)

    def direct(x):
        return phi * (ds * ndtr(phi * x) - dk * ndtr(phi * (x - sd)))

    def image(y):
        return phi * (ds * p1 * ndtr(eta * y) - dk * p2 * ndtr(eta * (y - sd)))

    A, B, C, D = direct(x1), direct(x2), image(y1), image(y2)
    if direction == "down" and kind == "call":
        value_in = C if K >= H else A - B + D
    elif direction == "up" and kind == "call":
        value_in = A if K >= H else B - C + D
    elif direction == "down":
        value_in = B - C + D if K >= H else A
    else:
        value_in = A - B + D if K >= H else C
    value_in = float(min(max(value_in, 0.0), vanilla))
    return value_in if knock == "in" else vanilla - value_in


def bgk_shift(H, sigma, dt, direction, toward_spot=True):
    """Broadie-Glasserman-Kou shifted barrier.

    toward_spot=True: a grid-monitored simulation with this barrier approximates
    *continuous* monitoring at H. False gives the opposite correction: a continuous
    formula at the shifted barrier approximates *discrete* monitoring at H.
    """
    s = BGK_BETA * sigma * math.sqrt(dt)
    up = direction == "down"  # a down barrier moves up to get closer to spot
    if not toward_spot:
        up = not up
    return H * math.exp(s if up else -s)


# --------------------------------------------------------------------- lattice
def binomial(S, K, T, r, q, sigma, kind="put", style="american", steps=2000, dates=None):
    """Cox-Ross-Rubinstein. style: european | american | bermudan (exercise on `dates`
    equally spaced times; steps is rounded up to a multiple of it)."""
    every = 1
    if style == "bermudan":
        steps = dates * max(1, math.ceil(steps / dates))
        every = steps // dates
    dt = T / steps
    u = math.exp(sigma * math.sqrt(dt))
    d = 1.0 / u
    p = (math.exp((r - q) * dt) - d) / (u - d)
    if not 0.0 < p < 1.0:
        raise ValueError("binomial: too few steps for this drift/volatility")
    disc = math.exp(-r * dt)
    phi = 1.0 if kind == "call" else -1.0
    ladder = S * np.exp(math.log(u) * np.arange(-steps, steps + 1))  # ladder[j + steps] = S u^j
    v = np.maximum(phi * (ladder[::2] - K), 0.0)
    for i in range(steps - 1, -1, -1):
        v = disc * (p * v[1:] + (1.0 - p) * v[:-1])
        if style == "american" or (style == "bermudan" and i > 0 and i % every == 0):
            v = np.maximum(v, phi * (ladder[steps - i : steps + i + 1 : 2] - K))
    return float(v[0])
