"""Random streams. PCG64 seeded through SeedSequence, one independent stream per block.

The C++ engine ports both algorithms bit for bit, so a (seed, stream, block) triple
names the *same* uniforms in either language and results do not depend on thread count.
"""
import numpy as np

MAIN, PILOT, POLICY = 0, 1, 2  # stream ids: pricing paths, pilot paths, LSM policy fit

_TINY, _ONE = 1e-300, 1.0 - 2.0**-53


def generator(seed: int, stream: int, block: int) -> np.random.Generator:
    return np.random.Generator(np.random.PCG64(np.random.SeedSequence(int(seed), spawn_key=(stream, block))))


def clip(u):
    """Keep uniforms strictly inside (0, 1) so the inverse normal stays finite."""
    return np.clip(u, _TINY, _ONE)
