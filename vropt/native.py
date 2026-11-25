"""Bridge to the C++ engine (cpp/). Optional: everything works without it, only slower.

`python -m vropt.native` compiles it with whatever compiler is on PATH (g++, clang++ or cl).
The library name carries a hash of the sources, so editing the C++ triggers a rebuild and a
stale binary is never loaded.
"""
from __future__ import annotations

import ctypes as ct
import hashlib
import os
import shutil
import subprocess
import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
CPP = ROOT / "cpp"
OUT = Path(__file__).resolve().parent / "_native"
PRODUCT_IDS = {"european": 0, "merton": 1, "asian": 2, "barrier": 3, "american": 4}
BITS = {"A": 1, "C": 2, "S": 4, "K": 8}

_lib = None
_error = ""


class _Spec(ct.Structure):
    _fields_ = [(n, ct.c_int32) for n in "product flags call down knock_in mode m n_fit".split()] + \
               [("fit_seed", ct.c_uint32), ("pad", ct.c_uint32)] + \
               [(n, ct.c_double) for n in "S0 K T r q sigma lam mu_j delta barrier".split()]


class _Plan(ct.Structure):
    _fields_ = [("ppu", ct.c_int32), ("H", ct.c_int32)] + \
               [(n, ct.c_int64) for n in ("rounds", "pilot_rounds", "block_rounds")]


def _sources():
    return sorted((CPP / "include").rglob("*.hpp")) + [CPP / "src" / "capi.cpp"]


def library_path() -> Path:
    h = hashlib.sha256()
    for f in _sources():
        h.update(f.read_bytes().replace(b"\r\n", b"\n"))
    ext = {"win32": ".dll", "darwin": ".dylib"}.get(sys.platform, ".so")
    return OUT / f"vropt_core-{h.hexdigest()[:12]}{ext}"


def compiler():
    for name in (os.environ.get("CXX"), "g++", "clang++", "cl"):
        if name and shutil.which(name):
            return name
    return None


def build(verbose=False) -> bool:
    """Compile the engine. Returns False, with the reason in `error()`, if that is not possible."""
    global _error
    if not CPP.exists():
        _error = "cpp/ sources not found"
        return False
    cxx, lib = compiler(), library_path()
    if cxx is None:
        _error = "no C++ compiler on PATH"
        return False
    OUT.mkdir(exist_ok=True)
    tmp = lib.with_name(f"{lib.stem}.{os.getpid()}{lib.suffix}")
    src, inc = str(CPP / "src" / "capi.cpp"), str(CPP / "include")
    if Path(cxx).stem == "cl":
        cmd = [cxx, "/nologo", "/std:c++20", "/O2", "/EHsc", "/LD", f"/I{inc}", src, f"/Fe:{tmp}"]
    else:
        cmd = [cxx, "-std=c++20", "-O3", "-ffp-contract=off", "-shared", "-fvisibility=hidden", f"-I{inc}", src, "-o", str(tmp)]
        if sys.platform == "win32":
            cmd += ["-static"]  # no MinGW runtime DLLs needed at load time
        else:
            cmd += ["-fPIC", "-pthread"]
    if verbose:
        print(" ".join(cmd))
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=240, cwd=OUT)
    except (OSError, subprocess.TimeoutExpired) as e:
        _error = f"{type(e).__name__}: {e}"
        return False
    if proc.returncode:
        _error = (proc.stderr or proc.stdout).strip()[-2000:]
        return False
    os.replace(tmp, lib)
    for old in OUT.glob("vropt_core-*"):
        if old != lib:
            try:
                old.unlink()
            except OSError:
                pass  # still loaded by another process
    return True


def _load():
    global _lib, _error
    if _lib is not None:
        return _lib
    path = library_path() if CPP.exists() else None
    if path is None or not path.exists():
        _error = _error or "not built"
        return None
    try:
        lib = ct.CDLL(str(path))
    except OSError as e:
        _error = str(e)
        return None
    d, u32 = ct.POINTER(ct.c_double), ct.c_uint32
    lib.vr_error.restype = ct.c_char_p
    lib.vr_create.argtypes = [ct.POINTER(_Spec), ct.POINTER(_Plan), ct.POINTER(ct.c_void_p)]
    lib.vr_destroy.argtypes = [ct.c_void_p]
    lib.vr_destroy.restype = None
    lib.vr_pilot.argtypes = [ct.c_void_p, u32, d]
    lib.vr_run.argtypes = [ct.c_void_p, u32, d, ct.c_int, ct.c_int, d, d, d]
    lib.vr_replicate.argtypes = [ct.c_void_p, u32, ct.c_int, d, d]
    lib.vr_reference.argtypes = [ct.c_void_p, d]
    lib.vr_uniforms.argtypes = [u32, u32, u32, ct.c_int, d]
    lib.vr_uniforms.restype = None
    lib.vr_inv_normal.argtypes = [ct.c_int, d, d]
    lib.vr_inv_normal.restype = None
    lib.vr_set_threads.argtypes = [ct.c_int]
    lib.vr_set_threads.restype = None
    _lib = lib
    return lib


def available() -> bool:
    return os.environ.get("VROPT_BACKEND", "").lower() != "numpy" and _load() is not None


def ensure() -> bool:
    """Load the engine, building it first if needed. Never raises."""
    if available():
        return True
    if os.environ.get("VROPT_BACKEND", "").lower() == "numpy":
        return False
    return build() and available()


def error() -> str:
    return _error


def threads() -> int:
    return _load().vr_threads() if available() else 1


def _ptr(a):
    return a.ctypes.data_as(ct.POINTER(ct.c_double))


class Handle:
    """One (product, method plan) pair living on the C++ side."""

    def __init__(self, problem, plan):
        self.lib, self.H = _load(), plan.H
        g = lambda name, default=0: getattr(problem, name, default)  # noqa: E731
        spec = _Spec(PRODUCT_IDS[problem.product], sum(BITS[f] for f in plan.flags), problem.kind == "call",
                     g("direction") == "down", g("knock") == "in",
                     ("bridge", "naive", "shifted").index(g("mode", "bridge")), g("m", 1), g("n_fit"),
                     g("fit_seed"), 0, problem.S0, problem.strike, problem.T, problem.r, problem.q, problem.sigma,
                     g("lam", 0.0), g("mu_j", 0.0), g("delta", 0.0), g("barrier", 0.0))
        cplan = _Plan(plan.ppu, plan.H, plan.rounds, plan.pilot_rounds, plan.block_rounds)
        self.ptr = ct.c_void_p()
        self._check(self.lib.vr_create(ct.byref(spec), ct.byref(cplan), ct.byref(self.ptr)))
        self.p = len(problem.control_means(plan.flags))

    def _check(self, code):
        if code:
            raise RuntimeError("C++ engine: " + self.lib.vr_error().decode())

    def __del__(self):
        if getattr(self, "ptr", None):
            self.lib.vr_destroy(self.ptr)
            self.ptr = None

    def pilot(self, seed):
        beta = np.zeros(2)
        self._check(self.lib.vr_pilot(self.ptr, seed, _ptr(beta)))
        return beta[: self.p]

    def run(self, seed, beta, b0, b1):
        full = np.zeros(2)
        if beta is not None:
            full[: len(beta)] = beta
        n, mean, m2 = np.zeros(1), np.empty(self.H), np.empty(self.H)
        self._check(self.lib.vr_run(self.ptr, seed, _ptr(full), b0, b1, _ptr(n), _ptr(mean), _ptr(m2)))
        return int(n[0]), mean, m2

    def replicate(self, seed, reps):
        price, se = np.empty(reps), np.empty(reps)
        self._check(self.lib.vr_replicate(self.ptr, seed, reps, _ptr(price), _ptr(se)))
        return price, se

    def reference(self):
        out = np.zeros(1)
        self._check(self.lib.vr_reference(self.ptr, _ptr(out)))
        return float(out[0])


def uniforms(seed, stream, block, n):
    out = np.empty(n)
    _load().vr_uniforms(seed, stream, block, n, _ptr(out))
    return out


def inv_normal(p):
    p = np.ascontiguousarray(p, float)
    out = np.empty_like(p)
    _load().vr_inv_normal(len(p), _ptr(p), _ptr(out))
    return out


if __name__ == "__main__":
    ok = build(verbose=True)
    print(f"built {library_path().name}" if ok and available() else f"build failed: {error()}")
    sys.exit(0 if ok else 1)
