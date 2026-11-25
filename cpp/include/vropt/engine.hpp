// Estimator engine: antithetic pairing, proportional stratification, pilot-fitted control
// variates, block-parallel and deterministic. Mirrors vropt/engine.py.
#pragma once
#include <cstdint>
#include <string>

#include "products.hpp"

namespace vropt {

enum Stream : std::uint32_t { kMain = 0, kPilot = 1 };

struct Plan {
    Flags flags = 0;
    int ppu = 1, H = 1;
    std::int64_t rounds = 0, pilot_rounds = 0, block_rounds = 1;
    bool valid() const { return rounds >= 2 && (pilot_rounds == 0 || pilot_rounds * H >= 8); }
    std::int64_t paths() const { return (rounds + pilot_rounds) * H * ppu; }
    int blocks(bool pilot = false) const {
        return int(((pilot ? pilot_rounds : rounds) + block_rounds - 1) / block_rounds);
    }
    std::int64_t rounds_in(int b, bool pilot = false) const {
        return std::min(block_rounds, (pilot ? pilot_rounds : rounds) - b * block_rounds);
    }
};

inline Plan make_plan(Dims d, Flags f, std::int64_t n_paths, int strata = 64, double pilot_frac = 0.05) {
    Plan p;
    p.flags = f;
    p.ppu = f & kAnti ? 2 : 1;
    const std::int64_t units = n_paths / p.ppu;
    p.H = f & kStrat ? int(std::max<std::int64_t>(2, std::min<std::int64_t>(strata, units / 16))) : 1;
    const std::int64_t per = units / p.H;
    if (f & kControl) {
        p.pilot_rounds = std::max<std::int64_t>(std::int64_t(std::ceil(pilot_frac * double(per))), p.H > 1 ? 4 : 100);
        p.pilot_rounds = std::min(p.pilot_rounds, per / 2);
    }
    p.rounds = per - p.pilot_rounds;
    p.block_rounds = std::max(1, std::min(4096, (1 << 17) / (d.normals + d.uniforms)) / p.H);
    return p;
}

// Welford/Chan accumulator for one stratum.
struct Moments {
    double n = 0, mean = 0, m2 = 0;
    void add(double x) {
        n += 1;
        const double d = x - mean;
        mean += d / n;
        m2 += d * (x - mean);
    }
    void merge(const Moments& o) {
        if (o.n == 0) return;
        const double tot = n + o.n, d = o.mean - mean;
        mean += d * (o.n / tot);
        m2 += o.m2 + d * d * (n * o.n / tot);
        n = tot;
    }
};

struct Result {
    double price = 0, se = 0;
    std::int64_t paths = 0;
};

using Beta = std::array<double, 2>;

inline Beta solve_beta(double s00, double s01, double s11, double y0, double y1) {
    if (s00 > 0 && s11 > 0) {
        const double det = s00 * s11 - s01 * s01;
        if (det > 1e-9 * s00 * s11) return {(s11 * y0 - s01 * y1) / det, (s00 * y1 - s01 * y0) / det};
        if (y0 * y0 * s11 >= y1 * y1 * s00) return {y0 / s00, 0.0};
        return {0.0, y1 / s11};
    }
    if (s00 > 0) return {y0 / s00, 0.0};
    if (s11 > 0) return {0.0, y1 / s11};
    return {0.0, 0.0};
}

// Run one block and hand every unit to sink(stratum, sample).
template <Product P, class Sink>
void simulate_block(const P& product, const Plan& plan, std::uint32_t seed, Stream stream, int block,
                    std::int64_t rounds, Sink&& sink) {
    const Dims d = product.dims(plan.flags);
    const int total = d.normals + d.uniforms;
    const bool anti = plan.flags & kAnti, strat = plan.flags & kStrat;
    Pcg64 g(seed, stream, std::uint32_t(block));
    std::vector<double> x(total), mirror(total);
    for (std::int64_t r = 0; r < rounds; ++r)
        for (int h = 0; h < plan.H; ++h) {
            for (int j = 0; j < total; ++j) {
                double u = g.uniform();
                if (strat && j == 0) {
                    u = (h + u) / plan.H;
                    if (anti) u *= 0.5;  // a pair is symmetric in z: stratify half the line
                }
                u = clip_uniform(u);
                x[j] = j < d.normals ? inv_normal(u) : u;
            }
            Sample s = product.path(x.data(), x.data() + d.normals, plan.flags, nullptr);
            if (anti) {
                for (int j = 0; j < total; ++j) mirror[j] = j < d.normals ? -x[j] : 1.0 - x[j];
                const Sample t = product.path(mirror.data(), mirror.data() + d.normals, plan.flags, nullptr);
                s = {0.5 * (s.y + t.y), {0.5 * (s.c[0] + t.c[0]), 0.5 * (s.c[1] + t.c[1])}};
            }
            sink(h, s);
        }
}

template <Product P>
Beta pilot(const P& product, const Plan& plan, std::uint32_t seed) {
    // pooled within-stratum cross products, accumulated with running means
    struct Cross {
        double n = 0, my = 0, m0 = 0, m1 = 0, s00 = 0, s01 = 0, s11 = 0, y0 = 0, y1 = 0;
    };
    std::vector<Cross> acc(plan.H);
    for (int b = 0; b < plan.blocks(true); ++b)
        simulate_block(product, plan, seed, kPilot, b, plan.rounds_in(b, true), [&](int h, const Sample& s) {
            Cross& a = acc[h];
            a.n += 1;
            const double dy = s.y - a.my, d0 = s.c[0] - a.m0, d1 = s.c[1] - a.m1;
            a.my += dy / a.n, a.m0 += d0 / a.n, a.m1 += d1 / a.n;
            const double e0 = s.c[0] - a.m0, e1 = s.c[1] - a.m1;
            a.s00 += d0 * e0, a.s01 += d0 * e1, a.s11 += d1 * e1, a.y0 += dy * e0, a.y1 += dy * e1;
        });
    Cross t;
    for (const Cross& a : acc) t.s00 += a.s00, t.s01 += a.s01, t.s11 += a.s11, t.y0 += a.y0, t.y1 += a.y1;
    return solve_beta(t.s00, t.s01, t.s11, t.y0, t.y1);
}

template <Product P>
std::vector<Moments> run_blocks(const P& product, const Plan& plan, std::uint32_t seed, const Beta& beta, int b0,
                                int b1, bool parallel = true) {
    const auto mu = product.control_means(plan.flags);
    const bool control = plan.flags & kControl;
    std::vector<std::vector<Moments>> per(b1 - b0, std::vector<Moments>(plan.H));
    auto job = [&](int i) {
        auto& acc = per[i];
        simulate_block(product, plan, seed, kMain, b0 + i, plan.rounds_in(b0 + i), [&](int h, const Sample& s) {
            double y = s.y;
            if (control) y -= beta[0] * (s.c[0] - mu[0]) + beta[1] * (s.c[1] - mu[1]);
            acc[h].add(y);
        });
    };
    if (parallel)
        parallel_for(b1 - b0, job);
    else
        for (int i = 0; i < b1 - b0; ++i) job(i);
    std::vector<Moments> out(plan.H);
    for (const auto& block : per)  // in block order, so the sum is reproducible
        for (int h = 0; h < plan.H; ++h) out[h].merge(block[h]);
    return out;
}

inline Result summarise(const std::vector<Moments>& m, const Plan& plan) {
    double mean = 0, m2 = 0;
    for (const auto& s : m) mean += s.mean, m2 += s.m2;
    const double H = double(m.size()), n = m.front().n;
    return {mean / H, std::sqrt(m2 / (n - 1) / n) / H, plan.paths()};
}

template <Product P>
Result price(const P& product, const Plan& plan, std::uint32_t seed, bool parallel = true) {
    const Beta beta = plan.flags & kControl ? pilot(product, plan, seed) : Beta{0.0, 0.0};
    return summarise(run_blocks(product, plan, seed, beta, 0, plan.blocks(), parallel), plan);
}

inline std::string method_label(Flags f) {
    std::string s;
    for (auto [bit, ch] : {std::pair{kAnti, 'A'}, {kControl, 'C'}, {kStrat, 'S'}, {kCond, 'K'}})
        if (f & bit) (s += s.empty() ? "" : "+") += ch;
    return s.empty() ? "Plain" : s;
}

}  // namespace vropt
