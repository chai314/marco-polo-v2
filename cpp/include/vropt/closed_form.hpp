// Closed forms needed as control means and as test oracles.
#pragma once
#include <algorithm>
#include <cmath>
#include <vector>

#include "random.hpp"

namespace vropt {

inline constexpr double kBgkBeta = 0.5825971579390106;  // -zeta(1/2)/sqrt(2 pi)

inline double black_scholes(double S, double K, double T, double r, double q, double sigma, double phi) {
    const double sd = sigma * std::sqrt(T), fs = S * std::exp(-q * T), dk = K * std::exp(-r * T);
    if (!(sd > 0.0)) return std::max(phi * (fs - dk), 0.0);
    const double d1 = std::log(fs / dk) / sd + 0.5 * sd;
    return phi * (fs * norm_cdf(phi * d1) - dk * norm_cdf(phi * (d1 - sd)));
}

struct Poisson {
    std::vector<double> pmf, cdf;
    explicit Poisson(double mean) {
        double p = std::exp(-mean), total = 0.0;
        for (int n = 0;;) {
            pmf.push_back(p);
            cdf.push_back(total += p);
            p *= mean / ++n;
            if ((n > mean && p < 1e-17) || n > 1000) break;
        }
    }
    int invert(double u) const {  // smallest n with cdf[n] >= u
        const int last = static_cast<int>(cdf.size()) - 1;
        int n = 0;
        while (n < last && cdf[n] < u) ++n;
        return n;
    }
};

struct Jumps {
    double lam = 0.0, mu = 0.0, delta = 0.0;
    double k() const { return std::exp(mu + 0.5 * delta * delta) - 1.0; }
};

// Discounted Merton price given n jumps.
inline double merton_conditional(double S, double K, double T, double r, double q, double sigma, const Jumps& j,
                                 int n, double phi) {
    const double vol = std::sqrt(sigma * sigma + n * j.delta * j.delta / T);
    const double spot = S * std::exp(-j.lam * j.k() * T + n * std::log1p(j.k()));
    return black_scholes(spot, K, T, r, q, vol, phi);
}

inline double merton_series(double S, double K, double T, double r, double q, double sigma, const Jumps& j,
                            double phi) {
    const Poisson pois(j.lam * T);
    double v = 0.0;
    for (std::size_t n = 0; n < pois.pmf.size(); ++n)
        v += pois.pmf[n] * merton_conditional(S, K, T, r, q, sigma, j, static_cast<int>(n), phi);
    return v;
}

inline double geometric_asian(double S, double K, double T, double r, double q, double sigma, int m, double phi) {
    const double dt = T / m;
    const double mean = std::log(S) + (r - q - 0.5 * sigma * sigma) * dt * (m + 1) / 2.0;
    const double var = sigma * sigma * dt * (m + 1) * (2.0 * m + 1) / (6.0 * m);
    const double sd = std::sqrt(var), fwd = std::exp(mean + 0.5 * var);
    const double d1 = (mean - std::log(K) + var) / sd;
    return std::exp(-r * T) * phi * (fwd * norm_cdf(phi * d1) - K * norm_cdf(phi * (d1 - sd)));
}

// Nodes and weights for E[f(Z)], Z standard normal (probabilists' Gauss-Hermite).
inline void gauss_hermite(int n, std::vector<double>& x, std::vector<double>& w) {
    x.assign(n, 0.0), w.assign(n, 0.0);
    const double h = std::sqrt(double(n));
    // orthonormal recurrence; returns He_n and He_{n-1}
    auto eval = [n](double t, double& prev) {
        double p0 = 1.0, p1 = t;
        for (int k = 1; k < n; ++k) {
            const double p2 = (t * p1 - std::sqrt(double(k)) * p0) / std::sqrt(double(k + 1));
            p0 = p1, p1 = p2;
        }
        prev = p0;
        return p1;
    };
    // bracket roots on a fine grid, then bisect: robust, and only done once per pricing
    const double hi = 2.0 * h + 1.0, step = 0.02 / (1.0 + h * 0.02);
    int found = 0;
    double a = -hi, prev, fa = eval(a, prev);
    while (a < hi && found < n) {
        const double b = a + step, fb = eval(b, prev);
        if ((fa < 0.0) != (fb < 0.0)) {
            double lo = a, up = b, flo = fa;
            for (int i = 0; i < 60; ++i) {
                const double mid = 0.5 * (lo + up), fm = eval(mid, prev);
                if ((fm < 0.0) == (flo < 0.0)) lo = mid, flo = fm; else up = mid;
            }
            const double t = 0.5 * (lo + up);
            eval(t, prev);
            x[found] = t;
            w[found++] = 1.0 / (n * prev * prev);
        }
        a = b, fa = fb;
    }
    double total = 0.0;
    for (double v : w) total += v;
    for (double& v : w) v /= total;
}

// Arithmetic Asian, discretely monitored: backward induction in xi = (mK - running sum)/S, which is
// one-dimensional by homogeneity. v(xi) is linear for xi <= 0; elsewhere a clamped cubic spline.
inline double arithmetic_asian(double S, double K, double T, double r, double q, double sigma, int m, double phi,
                               int n_grid = 1200, int n_quad = 32) {
    const double dt = T / m, mu = (r - q - 0.5 * sigma * sigma) * dt, sd = sigma * std::sqrt(dt);
    const double growth = std::exp((r - q) * dt), xi0 = m * K / S;
    const double hi = std::max(3.0 * m, 2.5 * xi0) * std::exp(3.0 * sigma * std::sqrt(T));
    std::vector<double> node, weight;
    gauss_hermite(n_quad, node, weight);
    std::vector<double> ex(n_quad);
    for (int j = 0; j < n_quad; ++j) ex[j] = std::exp(mu + sd * node[j]), weight[j] *= ex[j];
    auto future = [&](int k) {
        double s = 0.0, g = 1.0;
        for (int j = 1; j <= m - k; ++j) s += g *= growth;
        return s;
    };
    auto last_step = [&](double xi) {
        if (xi <= 0.0) return growth - xi;
        const double d1 = (mu + sd * sd - std::log(xi)) / sd;
        return growth * norm_cdf(d1) - xi * norm_cdf(d1 - sd);
    };
    // The grid is uniform in s = (xi/hi)^(1/2), so a point is located without searching.
    const int n = n_grid;
    std::vector<double> xi(n), v(n), m2(n), diag(n), rhs(n), next(n);
    for (int i = 0; i < n; ++i) {
        const double s = double(i) / (n - 1);
        xi[i] = hi * s * s;
        v[i] = last_step(xi[i]);
    }
    auto fit = [&] {  // second derivatives, end slopes v'(0) = -1 and v'(hi) = 0
        auto rise = [&](int i) { return (v[i + 1] - v[i]) / (xi[i + 1] - xi[i]); };
        diag[0] = 2 * (xi[1] - xi[0]), rhs[0] = 6 * (rise(0) + 1.0);
        for (int i = 1; i < n; ++i) {
            const double left = xi[i] - xi[i - 1], f = left / diag[i - 1];
            const bool end = i == n - 1;
            diag[i] = 2 * (end ? left : xi[i + 1] - xi[i - 1]) - f * left;
            rhs[i] = 6 * ((end ? 0.0 : rise(i)) - rise(i - 1)) - f * rhs[i - 1];
        }
        m2[n - 1] = rhs[n - 1] / diag[n - 1];
        for (int i = n - 2; i >= 0; --i) m2[i] = (rhs[i] - (xi[i + 1] - xi[i]) * m2[i + 1]) / diag[i];
    };
    auto spline = [&](double t) {
        if (t >= hi) return 0.0;
        int i = std::min(int(std::sqrt(t / hi) * (n - 1)), n - 2);
        if (t < xi[i]) --i;
        else if (t > xi[i + 1] && i < n - 2) ++i;
        const double h = xi[i + 1] - xi[i], a = (xi[i + 1] - t) / h, b = 1.0 - a;
        return a * v[i] + b * v[i + 1] + ((a * a * a - a) * m2[i] + (b * b * b - b) * m2[i + 1]) * h * h / 6.0;
    };
    double call;
    if (m == 1) {
        call = last_step(xi0);
    } else {
        for (int k = m - 2; k >= 0; --k) {
            fit();
            const double fut = future(k + 1);
            for (int i = 0; i < n; ++i) {
                double sum = 0.0;
                for (int j = 0; j < n_quad; ++j) {
                    const double t = xi[i] / ex[j] - 1.0;
                    sum += weight[j] * (t <= 0.0 ? fut - t : spline(t));
                }
                next[i] = std::max(sum, 0.0);
            }
            v.swap(next);
        }
        fit();
        call = spline(xi0);
    }
    const double df = std::exp(-r * T);
    call *= S * df / m;
    return phi > 0 ? call : call - df * (S * future(0) / m - K);
}

// Reiner-Rubinstein, continuous monitoring, no rebate. dir: +1 down, -1 up.
inline double barrier_price(double S, double K, double H, double T, double r, double q, double sigma, int dir,
                            bool knock_in, double phi) {
    const double vanilla = black_scholes(S, K, T, r, q, sigma, phi);
    if (dir > 0 ? S <= H : S >= H) return knock_in ? vanilla : 0.0;
    const double eta = dir, sd = sigma * std::sqrt(T);
    const double mu = (r - q - 0.5 * sigma * sigma) / (sigma * sigma), shift = (1.0 + mu) * sd;
    const double ds = S * std::exp(-q * T), dk = K * std::exp(-r * T);
    const double p1 = std::pow(H / S, 2 * (mu + 1)), p2 = std::pow(H / S, 2 * mu);
    auto direct = [&](double x) { return phi * (ds * norm_cdf(phi * x) - dk * norm_cdf(phi * (x - sd))); };
    auto image = [&](double y) { return phi * (ds * p1 * norm_cdf(eta * y) - dk * p2 * norm_cdf(eta * (y - sd))); };
    const double A = direct(std::log(S / K) / sd + shift), B = direct(std::log(S / H) / sd + shift);
    const double C = image(std::log(H * H / (S * K)) / sd + shift), D = image(std::log(H / S) / sd + shift);
    double in;
    const bool high = K >= H;
    if (dir > 0)
        in = phi > 0 ? (high ? C : A - B + D) : (high ? B - C + D : A);
    else
        in = phi > 0 ? (high ? A : B - C + D) : (high ? A - B + D : C);
    in = std::min(std::max(in, 0.0), vanilla);
    return knock_in ? in : vanilla - in;
}

// Cox-Ross-Rubinstein put; exercise allowed on `dates` equally spaced times (dates == steps: American).
inline double bermudan_put(double S, double K, double T, double r, double q, double sigma, int dates, int steps) {
    steps = dates * std::max(1, (steps + dates - 1) / dates);
    const int every = steps / dates;
    const double dt = T / steps, lu = sigma * std::sqrt(dt), u = std::exp(lu), d = 1.0 / u;
    const double p = (std::exp((r - q) * dt) - d) / (u - d), disc = std::exp(-r * dt);
    std::vector<double> v(steps + 1), ladder(2 * steps + 1);
    for (int j = -steps; j <= steps; ++j) ladder[j + steps] = S * std::exp(lu * j);
    for (int j = 0; j <= steps; ++j) v[j] = std::max(K - ladder[2 * j], 0.0);
    for (int i = steps - 1; i >= 0; --i)
        for (int j = 0; j <= i; ++j) {
            v[j] = disc * (p * v[j + 1] + (1.0 - p) * v[j]);
            if (i > 0 && i % every == 0) v[j] = std::max(v[j], K - ladder[steps - i + 2 * j]);
        }
    return v[0];
}

}  // namespace vropt
