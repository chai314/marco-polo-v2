// Flat C ABI over the templates, loaded from Python with ctypes (no binding library needed).
#include <cstring>
#include <memory>
#include <string>

#include "vropt/engine.hpp"

#if defined(__wasm__)
#define VR_API extern "C" __attribute__((visibility("default"), used))
#elif defined(_WIN32)
#define VR_API extern "C" __declspec(dllexport)
#else
#define VR_API extern "C" __attribute__((visibility("default")))
#endif

using namespace vropt;

extern "C" {
struct VrSpec {
    std::int32_t product, flags, call, down, knock_in, mode, m, n_fit;
    std::uint32_t fit_seed, pad;
    double S0, K, T, r, q, sigma, lam, mu_j, delta, barrier;
};
struct VrPlan {
    std::int32_t ppu, H;
    std::int64_t rounds, pilot_rounds, block_rounds;
};
}

namespace {
#ifndef VROPT_NO_THREADS
thread_local
#endif
    std::string last_error;

struct Handle {
    AnyProduct product;
    Plan plan;
};

AnyProduct build(const VrSpec& s) {
    const Market mk{s.S0, s.K, s.T, s.r, s.q, s.sigma, s.call ? 1.0 : -1.0};
    switch (s.product) {
        case 0: return EuropeanGBM(mk);
        case 1: return EuropeanMerton(mk, {s.lam, s.mu_j, s.delta});
        case 2: return AsianArithmetic(mk, s.m);
        case 3: return Barrier(mk, s.barrier, s.down ? 1 : -1, s.knock_in != 0, static_cast<Monitor>(s.mode), s.m);
        case 4: return AmericanPut(mk, s.m, s.n_fit, s.fit_seed);
    }
    return EuropeanGBM(mk);  // ids are validated by the callers
}

// Exceptions must not cross the C boundary.
template <class F>
int guarded(F&& f) {
#if defined(__cpp_exceptions)
    try {
        f();
        return 0;
    } catch (const std::exception& e) {
        last_error = e.what();
    } catch (...) {
        last_error = "unknown C++ exception";
    }
    return 1;
#else
    f();
    return 0;
#endif
}
}  // namespace

VR_API const char* vr_error() { return last_error.c_str(); }
VR_API int vr_threads() { return thread_limit(); }
VR_API void vr_set_threads(int n) { thread_limit() = std::max(1, n); }

VR_API int vr_create(const VrSpec* s, const VrPlan* p, void** out) {
    return guarded([&] {
        Plan plan;
        plan.flags = Flags(s->flags);
        plan.ppu = p->ppu, plan.H = p->H;
        plan.rounds = p->rounds, plan.pilot_rounds = p->pilot_rounds, plan.block_rounds = p->block_rounds;
        *out = std::make_unique<Handle>(Handle{build(*s), plan}).release();
    });
}
// Same, with the budget split worked out here. block_rounds <= 0 keeps the default. Returns 2 if the budget is too small.
VR_API int vr_open(const VrSpec* s, double n_paths, int strata, double pilot_frac, int block_rounds, VrPlan* out,
                   void** handle) {
    int too_small = 0;
    const int code = guarded([&] {
        AnyProduct product = build(*s);
        const Dims d = std::visit([&](const auto& p) { return p.dims(Flags(s->flags)); }, product);
        Plan plan = make_plan(d, Flags(s->flags), std::int64_t(n_paths), strata, pilot_frac);
        if (!plan.valid()) {
            too_small = 1;
            return;
        }
        if (block_rounds > 0) plan.block_rounds = block_rounds;
        *out = {plan.ppu, plan.H, plan.rounds, plan.pilot_rounds, plan.block_rounds};
        *handle = std::make_unique<Handle>(Handle{std::move(product), plan}).release();
    });
    return code ? code : 2 * too_small;
}
VR_API void vr_destroy(void* h) { delete static_cast<Handle*>(h); }

VR_API int vr_pilot(void* h, std::uint32_t seed, double* beta) {
    return guarded([&] {
        const auto& x = *static_cast<Handle*>(h);
        const Beta b = std::visit([&](const auto& p) { return pilot(p, x.plan, seed); }, x.product);
        beta[0] = b[0], beta[1] = b[1];
    });
}

VR_API int vr_run(void* h, std::uint32_t seed, const double* beta, int b0, int b1, double* n, double* mean,
                  double* m2) {
    return guarded([&] {
        const auto& x = *static_cast<Handle*>(h);
        const auto acc =
            std::visit([&](const auto& p) { return run_blocks(p, x.plan, seed, {beta[0], beta[1]}, b0, b1); }, x.product);
        *n = acc.front().n;
        for (std::size_t i = 0; i < acc.size(); ++i) mean[i] = acc[i].mean, m2[i] = acc[i].m2;
    });
}

VR_API int vr_replicate(void* h, std::uint32_t seed, int reps, double* price_out, double* se_out) {
    return guarded([&] {
        const auto& x = *static_cast<Handle*>(h);
        std::visit(
            [&](const auto& p) {
                parallel_for(reps, [&](int i) {
                    const Result r = price(p, x.plan, seed + 1u + std::uint32_t(i), false);
                    price_out[i] = r.price, se_out[i] = r.se;
                });
            },
            x.product);
    });
}

VR_API int vr_reference(void* h, double* out) {
    return guarded([&] {
        *out = std::visit([](const auto& p) { return double(p.reference()); }, static_cast<Handle*>(h)->product);
    });
}

// Longstaff-Schwartz coefficients, 4 per date; returns the number of dates (0 if not American).
VR_API int vr_policy(void* h, double* out) {
    if (const auto* p = std::get_if<AmericanPut>(&static_cast<Handle*>(h)->product)) {
        int n = 0;
        for (const auto& row : p->policy())
            for (double c : row) out[n++] = c;
        return n / 4;
    }
    return 0;
}
VR_API double vr_black_scholes(double S, double K, double T, double r, double q, double sigma, int call) {
    return black_scholes(S, K, T, r, q, sigma, call ? 1.0 : -1.0);
}
VR_API double vr_merton(double S, double K, double T, double r, double q, double sigma, double lam, double mu_j,
                        double delta, int call) {
    return merton_series(S, K, T, r, q, sigma, {lam, mu_j, delta}, call ? 1.0 : -1.0);
}
VR_API void vr_uniforms(std::uint32_t seed, std::uint32_t stream, std::uint32_t block, int n, double* out) {
    Pcg64 g(seed, stream, block);
    for (int i = 0; i < n; ++i) out[i] = g.uniform();
}
VR_API void vr_inv_normal(int n, const double* in, double* out) {
    for (int i = 0; i < n; ++i) out[i] = inv_normal(in[i]);
}
