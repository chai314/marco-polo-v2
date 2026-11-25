// PCG64 (XSL-RR 128/64) seeded by NumPy's SeedSequence, ported bit for bit, so that
// Pcg64(seed, stream, block) yields exactly the doubles of
//   numpy.random.Generator(PCG64(SeedSequence(seed, spawn_key=(stream, block)))).random()
#pragma once
#include <array>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <vector>
#if defined(_MSC_VER) && !defined(__clang__)
#include <intrin.h>
#endif

namespace vropt {

struct U128 {
    std::uint64_t hi = 0, lo = 0;
    friend U128 operator+(U128 a, U128 b) {
        U128 r{a.hi + b.hi, a.lo + b.lo};
        r.hi += r.lo < a.lo;
        return r;
    }
    friend U128 operator*(U128 a, U128 b) {  // low 128 bits
        std::uint64_t hi, lo;
#if defined(_MSC_VER) && !defined(__clang__)
        lo = _umul128(a.lo, b.lo, &hi);
#else
        const unsigned __int128 p = static_cast<unsigned __int128>(a.lo) * b.lo;
        hi = static_cast<std::uint64_t>(p >> 64);
        lo = static_cast<std::uint64_t>(p);
#endif
        return {hi + a.hi * b.lo + a.lo * b.hi, lo};
    }
};

// Four 64-bit words from SeedSequence(entropy=seed, spawn_key=(stream, block)), 32-bit inputs.
inline std::array<std::uint64_t, 4> seed_sequence(std::uint32_t seed, std::uint32_t stream, std::uint32_t block) {
    constexpr std::uint32_t kInitA = 0x43b0d7e5u, kMultA = 0x931e8875u, kInitB = 0x8b51f9ddu, kMultB = 0x58f38dedu;
    constexpr std::uint32_t kMixL = 0xca01f9ddu, kMixR = 0x4973f715u;
    const std::array<std::uint32_t, 6> entropy{seed, 0u, 0u, 0u, stream, block};  // padded before spawn key
    std::array<std::uint32_t, 4> pool{};
    std::uint32_t h = kInitA;
    auto hashmix = [&h](std::uint32_t v) {
        v ^= h;
        h *= kMultA;
        v *= h;
        return v ^ (v >> 16);
    };
    auto mix = [](std::uint32_t x, std::uint32_t y) {
        const std::uint32_t r = kMixL * x - kMixR * y;
        return r ^ (r >> 16);
    };
    for (int i = 0; i < 4; ++i) pool[i] = hashmix(entropy[i]);
    for (int s = 0; s < 4; ++s)
        for (int d = 0; d < 4; ++d)
            if (s != d) pool[d] = mix(pool[d], hashmix(pool[s]));
    for (int s = 4; s < 6; ++s)
        for (int d = 0; d < 4; ++d) pool[d] = mix(pool[d], hashmix(entropy[s]));

    std::array<std::uint64_t, 4> out{};
    std::uint32_t g = kInitB;
    for (int i = 0; i < 8; ++i) {
        std::uint32_t v = pool[i % 4];
        v ^= g;
        g *= kMultB;
        v *= g;
        v ^= v >> 16;
        out[i / 2] |= static_cast<std::uint64_t>(v) << (32 * (i % 2));
    }
    return out;
}

class Pcg64 {
public:
    Pcg64(std::uint32_t seed, std::uint32_t stream, std::uint32_t block) {
        const auto w = seed_sequence(seed, stream, block);
        inc_ = {(w[2] << 1) | (w[3] >> 63), (w[3] << 1) | 1u};
        step();
        state_ = state_ + U128{w[0], w[1]};
        step();
    }
    std::uint64_t next() {
        step();
        const unsigned rot = static_cast<unsigned>(state_.hi >> 58);
        const std::uint64_t x = state_.hi ^ state_.lo;
        return (x >> rot) | (x << ((64u - rot) & 63u));
    }
    double uniform() { return static_cast<double>(next() >> 11) * 0x1.0p-53; }

private:
    void step() { state_ = state_ * U128{0x2360ed051fc65da4ull, 0x4385df649fccf645ull} + inc_; }
    U128 state_{}, inc_{};
};

inline double clip_uniform(double u) {
    constexpr double tiny = 1e-300, one = 1.0 - 0x1.0p-53;
    return u < tiny ? tiny : (u > one ? one : u);
}

// Standard normal quantile: Wichura's AS 241 (PPND16), about 1e-16 relative accuracy.
inline double inv_normal(double p) {
    const double q = p - 0.5;
    if (std::fabs(q) <= 0.425) {
        const double r = 0.180625 - q * q;
        return q *
               (((((((2.5090809287301226727e+3 * r + 3.3430575583588128105e+4) * r + 6.7265770927008700853e+4) * r +
                    4.5921953931549871457e+4) * r + 1.3731693765509461125e+4) * r + 1.9715909503065514427e+3) * r +
                 1.3314166789178437745e+2) * r + 3.3871328727963666080e+0) /
               (((((((5.2264952788528545610e+3 * r + 2.8729085735721942674e+4) * r + 3.9307895800092710610e+4) * r +
                    2.1213794301586595867e+4) * r + 5.3941960214247511077e+3) * r + 6.8718700749205790830e+2) * r +
                 4.2313330701600911252e+1) * r + 1.0);
    }
    double r = std::sqrt(-std::log(q < 0.0 ? p : 1.0 - p));
    double x;
    if (r <= 5.0) {
        r -= 1.6;
        x = (((((((7.74545014278341407640e-4 * r + 2.27238449892691845833e-2) * r + 2.41780725177450611770e-1) * r +
                1.27045825245236838258e+0) * r + 3.64784832476320460504e+0) * r + 5.76949722146069140550e+0) * r +
             4.63033784615654529590e+0) * r + 1.42343711074968357734e+0) /
            (((((((1.05075007164441684324e-9 * r + 5.47593808499534494600e-4) * r + 1.51986665636164571966e-2) * r +
                1.48103976427480074590e-1) * r + 6.89767334985100004550e-1) * r + 1.67638483018380384940e+0) * r +
             2.05319162663775882187e+0) * r + 1.0);
    } else {
        r -= 5.0;
        x = (((((((2.01033439929228813265e-7 * r + 2.71155556874348757815e-5) * r + 1.24266094738807843860e-3) * r +
                2.65321895265761230930e-2) * r + 2.96560571828504891230e-1) * r + 1.78482653991729133580e+0) * r +
             5.46378491116411436990e+0) * r + 6.65790464350110377720e+0) /
            (((((((2.04426310338993978564e-15 * r + 1.42151175831644588870e-7) * r + 1.84631831751005468180e-5) * r +
                7.86869131145613259100e-4) * r + 1.48753612908506148525e-2) * r + 1.36929880922735805310e-1) * r +
             5.99832206555887937690e-1) * r + 1.0);
    }
    return q < 0.0 ? -x : x;
}

// exp by Cephes' rational approximation, about 1 ulp. Inlines into the path loops; some
// C runtimes (MinGW's among them) still route std::exp through the x87 unit, 5-10x slower.
inline double fast_exp(double x) {
    if (!(x > -700.0 && x < 700.0)) return std::exp(x);
    constexpr double kRound = 6755399441055744.0;  // 1.5 * 2^52: adding it rounds to an integer
    const double n = (x * 1.4426950408889634 + kRound) - kRound;
    x -= n * 6.93145751953125e-1;
    x -= n * 1.42860682030941723212e-6;
    const double xx = x * x;
    const double p = x * ((1.26177193074810590878e-4 * xx + 3.02994407707441961300e-2) * xx + 9.99999999999999999910e-1);
    const double q = ((3.00198505138664455042e-6 * xx + 2.52448340349684104192e-3) * xx + 2.27265548208155028766e-1) *
                         xx + 2.0;
    const double frac = 1.0 + 2.0 * (p / (q - p));
    const std::uint64_t bits = static_cast<std::uint64_t>(static_cast<std::int64_t>(n) + 1023) << 52;
    double scale;
    std::memcpy(&scale, &bits, sizeof scale);
    return frac * scale;
}

inline double norm_cdf(double x) { return 0.5 * std::erfc(-x * 0.70710678118654752440); }

}  // namespace vropt
