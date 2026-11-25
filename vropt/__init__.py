"""vropt: variance reduction for option pricing, measured rather than asserted."""
from .engine import (Estimate, combinations, compare, coverage, estimate, label, make_plan, pick_backend,
                     replicate, stream, trace, vrf)
from .problems import (A, ALL_METHODS, AmericanPut, AsianArithmetic, Barrier, C, EuropeanGBM, EuropeanMerton, K,
                       METHOD_NAMES, S)

__all__ = ["A", "ALL_METHODS", "AmericanPut", "AsianArithmetic", "Barrier", "C", "Estimate", "EuropeanGBM",
           "EuropeanMerton", "K", "METHOD_NAMES", "S", "combinations", "compare", "coverage", "estimate", "label",
           "make_plan", "pick_backend", "replicate", "stream", "trace", "vrf"]
