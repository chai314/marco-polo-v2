"""Closed forms against independent numerics, every method combination against a deterministic
price, and the C++ engine against NumPy path for path."""
import math

import numpy as np
import pytest
from scipy.integrate import quad
from scipy.special import ndtri
from scipy.stats import norm

import vropt as v
from vropt import analytic as an
from vropt import engine, native, rng

HAVE_CPP = native.ensure()
needs_cpp = pytest.mark.skipif(not HAVE_CPP, reason="no C++ toolchain")
EIGHT = [(d, k, o) for d in ("down", "up") for k in ("in", "out") for o in ("call", "put")]

GBM = v.EuropeanGBM(S0=100, strike=105, T=0.75, r=0.04, q=0.01, sigma=0.25, kind="put")
MERTON = v.EuropeanMerton(S0=100, strike=105, T=0.75, r=0.04, q=0.01, sigma=0.2, lam=1.0, mu_j=-0.08, delta=0.12)
ASIAN = v.AsianArithmetic(S0=100, strike=102, T=1, r=0.04, q=0.01, sigma=0.3, m=12)
DOWN = v.Barrier(S0=100, strike=100, T=1, r=0.04, q=0.01, sigma=0.25, barrier=88, m=10)
UP = v.Barrier(S0=100, strike=100, T=1, r=0.04, q=0.01, sigma=0.25, barrier=125, direction="up", m=10)
UPIN = v.Barrier(S0=100, strike=100, T=1, r=0.04, q=0.01, sigma=0.25, barrier=115, direction="up", knock="in",
                 kind="put", m=10)
NAIVE = v.Barrier(S0=100, strike=100, T=1, sigma=0.25, barrier=88, m=10, mode="naive")
SHIFTED = v.Barrier(S0=100, strike=100, T=1, sigma=0.25, barrier=88, m=10, mode="shifted")
AMER = v.AmericanPut(S0=100, strike=105, T=0.75, r=0.05, q=0.0, sigma=0.25, m=10)
UNBIASED = [GBM, MERTON, ASIAN, DOWN, UP, UPIN]
EVERY = UNBIASED + [NAIVE, SHIFTED, AMER]


def name(p):
    return f"{p.product}-{getattr(p, 'mode', '')}-{getattr(p, 'direction', '')}{getattr(p, 'knock', '')}-{p.kind}"


def grid(problems):
    return [pytest.param(p, c, id=f"{name(p)}-{v.label(c)}") for p in problems
            for c in [frozenset()] + v.combinations(p)]


# ------------------------------------------------------------------ closed forms
def test_black_scholes_value_and_parity():
    assert an.black_scholes(100, 100, 1, 0.05, 0, 0.2) == pytest.approx(10.450583572185565, abs=1e-12)
    c, p = (an.black_scholes(100, 90, 2, 0.03, 0.02, 0.4, k) for k in ("call", "put"))
    assert c - p == pytest.approx(100 * math.exp(-0.04) - 90 * math.exp(-0.06), abs=1e-10)


def test_tree_converges_to_black_scholes():
    exact = an.black_scholes(100, 105, 1, 0.04, 0.01, 0.25, "put")
    assert an.binomial(100, 105, 1, 0.04, 0.01, 0.25, "put", "european", 4000) == pytest.approx(exact, abs=5e-3)


def test_american_ordering_and_no_dividend_call():
    args = (100, 105, 1, 0.05, 0.0, 0.25)
    e = an.binomial(*args, "put", "european", 1000)
    b = an.binomial(*args, "put", "bermudan", 1000, dates=4)
    a = an.binomial(*args, "put", "american", 1000)
    assert e < b < a
    # without dividends early exercise of a call is worthless
    assert an.binomial(*args, "call", "american", 1000) == pytest.approx(an.binomial(*args, "call", "european", 1000), abs=1e-9)


@pytest.mark.parametrize("S,sigma,T,fd", [(36, .2, 1, 4.478), (36, .4, 2, 8.508), (40, .2, 1, 2.314), (44, .4, 2, 5.647)])
def test_tree_matches_longstaff_schwartz_table1(S, sigma, T, fd):
    # Table 1's finite-difference column: 50 exercise dates a year
    assert an.binomial(S, 40, T, 0.06, 0, sigma, "put", "bermudan", 2000, dates=50 * T) == pytest.approx(fd, abs=0.012)


def test_merton_series_limits_and_parity():
    base = dict(S=100, K=95, T=.5, r=.03, q=.01, sigma=.25)
    assert an.merton_series(**base, lam=0, mu_j=-.1, delta=.2) == pytest.approx(an.black_scholes(**base), abs=1e-12)
    jump = dict(lam=1.3, mu_j=-.1, delta=.2)
    c, p = (an.merton_series(**base, **jump, kind=k) for k in ("call", "put"))
    assert c - p == pytest.approx(100 * math.exp(-.005) - 95 * math.exp(-.015), abs=1e-10)


def test_merton_series_against_characteristic_function():
    S, K, T, r, q, s, lam, mu, d = 100, 95, .5, .03, .01, .25, 1.3, -.1, .2
    k = an.merton_k(mu, d)

    def cf(u):  # of log(S_T/S)
        drift = (r - q - .5 * s * s - lam * k) * T
        return np.exp(1j * u * drift - .5 * s * s * u * u * T + lam * T * (np.exp(1j * u * mu - .5 * d * d * u * u) - 1))

    lk = math.log(K / S)
    p2 = .5 + quad(lambda u: (np.exp(-1j * u * lk) * cf(u) / (1j * u)).real, 1e-9, 200, limit=500)[0] / math.pi
    p1 = .5 + quad(lambda u: (np.exp(-1j * u * lk) * cf(u - 1j) / (1j * u * cf(-1j))).real, 1e-9, 200, limit=500)[0] / math.pi
    price = S * math.exp(-q * T) * p1 - K * math.exp(-r * T) * p2
    assert an.merton_series(S, K, T, r, q, s, lam, mu, d) == pytest.approx(price, abs=1e-6)


@pytest.mark.parametrize("direction,knock,kind", EIGHT)
@pytest.mark.parametrize("K", [80, 100, 125])
def test_barrier_formula_against_killed_density(direction, knock, kind, K):
    """Reiner-Rubinstein versus direct integration of the method-of-images density."""
    S, T, r, q, s = 100, .8, .04, .015, .25
    H = 90 if direction == "down" else 115
    mu, h, sd = r - q - .5 * s * s, math.log(H / S), s * math.sqrt(T)

    def density(x):
        return norm.pdf(x, mu * T, sd) - math.exp(2 * mu * h / s**2) * norm.pdf(x, 2 * h + mu * T, sd)

    lo, hi = (h, 12 * sd) if direction == "down" else (-12 * sd, h)
    phi = 1 if kind == "call" else -1
    kink = [math.log(K / S)] if lo < math.log(K / S) < hi else None
    out = math.exp(-r * T) * quad(lambda x: max(phi * (S * math.exp(x) - K), 0) * density(x), lo, hi, points=kink, limit=400)[0]
    want = out if knock == "out" else an.black_scholes(S, K, T, r, q, s, kind) - out
    assert an.barrier_price(S, K, H, T, r, q, s, direction, knock, kind) == pytest.approx(want, abs=1e-7)


def test_bgk_constant():
    from scipy.special import zeta
    # zeta(1/2) through the Dirichlet eta function, summed with Euler averaging
    n = np.arange(1, 4001)
    partial = np.cumsum((-1.0) ** (n - 1) / np.sqrt(n))
    for _ in range(12):
        partial = .5 * (partial[1:] + partial[:-1])
    half = partial[-1] / (1 - 2**0.5)
    assert an.BGK_BETA == pytest.approx(-half / math.sqrt(2 * math.pi), abs=1e-9)
    assert zeta(2) == pytest.approx(math.pi**2 / 6)


def test_asian_recursion():
    # one fixing is a European; two fixings by brute-force quadrature; and above the geometric price
    assert an.arithmetic_asian(100, 102, 1, .04, .01, .3, 1) == pytest.approx(an.black_scholes(100, 102, 1, .04, .01, .3), abs=1e-9)
    S, K, T, r, q, s = 100, 102, 1, .04, .01, .3
    dt, mu, sd = T / 2, (r - q - .5 * s * s) * T / 2, s * math.sqrt(T / 2)

    def inner(z):
        s1 = S * math.exp(mu + sd * z)
        k = 2 * K - s1
        call = an.black_scholes(s1, k, dt, r, q, s) * math.exp(r * dt) if k > 0 else s1 * math.exp((r - q) * dt) - k
        return call * norm.pdf(z)

    want = math.exp(-r * T) / 2 * quad(inner, -9, 9, limit=400, epsabs=1e-11)[0]
    assert an.arithmetic_asian(S, K, T, r, q, s, 2) == pytest.approx(want, abs=1e-6)
    for m in (4, 50, 252):
        assert an.arithmetic_asian(S, K, T, r, q, s, m) > an.geometric_asian(S, K, T, r, q, s, m)
    c, p = (an.arithmetic_asian(S, K, T, r, q, s, 12, k) for k in ("call", "put"))
    mean = S * np.mean(np.exp((r - q) * np.arange(1, 13) / 12))
    assert c - p == pytest.approx(math.exp(-r * T) * (mean - K), abs=1e-9)


@pytest.mark.parametrize("m", [5, 50, 252])
def test_asian_recursion_is_converged(m):
    a = an.arithmetic_asian(100, 102, 1, .04, .01, .3, m)
    assert a == pytest.approx(an.arithmetic_asian(100, 102, 1, .04, .01, .3, m, n_grid=3000, n_quad=64), abs=2e-5)


# ------------------------------------------------------------------- estimators
def test_combination_counts():
    assert [len(v.combinations(p)) for p in (GBM, MERTON, ASIAN, DOWN, NAIVE, AMER)] == [7, 15, 7, 15, 7, 3]


@pytest.mark.parametrize("problem,methods", grid(UNBIASED))
def test_unbiased_and_calibrated(problem, methods):
    """300 independent runs: the mean hits the deterministic price, and the reported standard
    error matches the spread actually observed."""
    x, se = v.replicate(problem, methods, 6000, 300, seed=2024)
    spread = x.std(ddof=1)
    assert abs(x.mean() - problem.reference()) < 4.2 * spread / math.sqrt(300) + 1e-12
    assert 0.6 < se.mean() / spread < 1.25


@pytest.mark.parametrize("problem", [GBM, MERTON, ASIAN, DOWN], ids=name)
def test_coverage_of_95_percent_intervals(problem):
    for methods in [(), ("A",), ("C",), ("S",)]:
        x, se = v.replicate(problem, methods, 4000, 600, seed=5)
        assert 0.91 <= v.coverage(x, se, problem.reference()) <= 0.98


def test_vrf_direction():
    """The headline claims, with generous margins."""
    def f(p, m):
        return v.vrf(v.estimate(p, (), 60000), v.estimate(p, m, 60000))

    assert f(GBM, "A") > 1.5 and f(GBM, "S") > 20
    assert f(ASIAN, "C") > 100
    assert f(MERTON, "K") > 5
    assert f(AMER, "C") > 20
    assert 0.5 < f(DOWN, "K") / f(DOWN, "") < 5


def test_antithetic_hurts_a_symmetric_payoff():
    """Without monotonicity the pair is positively correlated: a straddle is the textbook case."""
    z = np.random.Generator(np.random.PCG64(3)).standard_normal(200000)
    pay = lambda x: np.abs(100 * np.exp(-.02 + .2 * x) - 100)  # noqa: E731
    pair = .5 * (pay(z) + pay(-z))
    assert 2 * pair.var() > 1.5 * pay(z).var()


def test_bridge_removes_the_monitoring_bias():
    truth = DOWN.reference()
    from dataclasses import replace
    est = {m: v.estimate(replace(DOWN, mode=m), "C", 400000) for m in ("naive", "shifted", "bridge")}
    assert est["naive"].price - truth > 20 * est["naive"].se     # misses crossings between dates
    assert abs(est["bridge"].price - truth) < 4 * est["bridge"].se
    assert abs(est["shifted"].price - truth) < 0.2 * (est["naive"].price - truth)


def test_lsm_is_low_biased_but_close():
    x, _ = v.replicate(AMER, "AC", 20000, 50, seed=3)
    ref = AMER.reference()
    assert -0.02 * ref < x.mean() - ref < 0.001 * ref


def test_pilot_beta_is_independent_of_pricing_paths():
    plan = v.make_plan(ASIAN, "C", 20000)
    a, _ = engine.draw_block(ASIAN, plan, 7, rng.MAIN, 0, 10)
    b, _ = engine.draw_block(ASIAN, plan, 7, rng.PILOT, 0, 10)
    assert not np.allclose(a, b)
    assert plan.paths <= 20000  # the pilot is paid for out of the same budget


def test_budget_is_respected_and_errors_are_clear():
    for p in EVERY:
        for c in v.combinations(p):
            plan = v.make_plan(p, c, 10000)
            assert 9500 <= plan.paths <= 10000
    with pytest.raises(ValueError, match="not applicable"):
        v.estimate(ASIAN, "K")
    with pytest.raises(ValueError, match="too small"):
        v.estimate(ASIAN, "C", 10)
    with pytest.raises(ValueError, match="live side"):
        v.Barrier(S0=100, barrier=120, direction="down")


def test_stream_and_trace_end_where_estimate_does():
    e = v.estimate(MERTON, "ACS", 30000, backend="numpy")
    *_, last = v.stream(MERTON, "ACS", 30000, backend="numpy")
    assert (last.price, last.se) == pytest.approx((e.price, e.se), rel=1e-12)
    t = v.trace(MERTON, "ACS", 30000)
    assert t[-1, 1:] == pytest.approx([e.price, e.se], rel=1e-12)


def test_collinear_controls_do_not_explode():
    beta = engine.solve_beta(np.array([[1.0, 2.0], [2.0, 4.0]]), np.array([3.0, 6.0]))
    assert beta == pytest.approx([3.0, 0.0])
    assert engine.solve_beta(np.zeros((2, 2)), np.zeros(2)) == pytest.approx([0.0, 0.0])


# -------------------------------------------------------------- C++ versus NumPy
@needs_cpp
def test_cpp_rng_is_numpy_rng():
    for key in [(0, 0, 0), (7, 1, 3), (4294967295, 2, 100)]:
        assert np.array_equal(native.uniforms(*key, 5000), rng.generator(*key).random(5000))


@needs_cpp
def test_cpp_inverse_normal():
    u = np.concatenate([np.logspace(-300, -1, 500), np.linspace(1e-3, 1 - 1e-12, 5000)])
    np.testing.assert_allclose(native.inv_normal(u), ndtri(u), rtol=3e-14, atol=1e-15)


@needs_cpp
@pytest.mark.parametrize("problem,methods", grid(EVERY))
def test_cpp_equals_numpy(problem, methods):
    a = v.estimate(problem, methods, 12000, seed=31, backend="cpp")
    b = v.estimate(problem, methods, 12000, seed=31, backend="numpy")
    assert a.price == pytest.approx(b.price, rel=1e-9)
    assert a.se == pytest.approx(b.se, rel=1e-6)
    assert a.paths == b.paths


@needs_cpp
@pytest.mark.parametrize("problem,tol", [(p, 1e-9) for p in (GBM, MERTON, DOWN, UP, UPIN, AMER)] + [(ASIAN, 1e-5)],
                         ids=lambda x: name(x) if hasattr(x, "product") else "")
def test_cpp_reference(problem, tol):
    h = native.Handle(problem, v.make_plan(problem, (), 1000))
    assert h.reference() == pytest.approx(problem.reference(), rel=tol)


@needs_cpp
@pytest.mark.parametrize("m", [2, 12, 50, 252])
@pytest.mark.parametrize("kind", ["call", "put"])
def test_cpp_asian_recursion(m, kind):
    """Two independent discretisations of the same recursion (different grids, splines and quadrature)."""
    p = v.AsianArithmetic(S0=719, strike=700, T=.5, r=.043, q=.01, sigma=.2, m=m, kind=kind)
    h = native.Handle(p, v.make_plan(p, (), 1000))
    assert h.reference() == pytest.approx(p.reference(), rel=2e-5)
