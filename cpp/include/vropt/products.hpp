// The products. Each maps (z, u) -> (discounted payoff, controls). Coordinate 0 is the one
// the engine stratifies; the antithetic partner of (z, u) is (-z, 1-u).
#pragma once
#include <array>
#include <concepts>
#include <map>
#include <memory>
#include <tuple>
#include <variant>
#ifndef VROPT_NO_THREADS
#include <mutex>
#endif

#include "closed_form.hpp"
#include "parallel.hpp"

namespace vropt {

enum Method : unsigned { kAnti = 1, kControl = 2, kStrat = 4, kCond = 8 };
using Flags = unsigned;

struct Dims { int normals, uniforms; };
struct Sample { double y; std::array<double, 2> c; };

template <class P>
concept Product = requires(const P& p, const double* z, const double* u, Flags f, double* work) {
    { p.dims(f) } -> std::same_as<Dims>;
    { p.controls() } -> std::convertible_to<int>;
    { p.control_means(f) } -> std::same_as<std::array<double, 2>>;
    { p.path(z, u, f, work) } -> std::same_as<Sample>;
    { p.reference() } -> std::convertible_to<double>;
    { P::kMethods } -> std::convertible_to<Flags>;
};

struct Market {
    double S0 = 100, K = 100, T = 1, r = 0.04, q = 0, sigma = 0.2, phi = 1;
    double disc() const { return std::exp(-r * T); }
    double drift() const { return r - q - 0.5 * sigma * sigma; }
    double payoff(double s) const { return std::max(phi * (s - K), 0.0); }
    double vanilla() const { return black_scholes(S0, K, T, r, q, sigma, phi); }
    double prepaid() const { return S0 * std::exp(-q * T); }
};

// ---------------------------------------------------------------------------------- European
class EuropeanGBM {
public:
    static constexpr Flags kMethods = kAnti | kControl | kStrat;
    explicit EuropeanGBM(const Market& mk) : mk_(mk), disc_(mk.disc()), sd_(mk.sigma * std::sqrt(mk.T)) {}
    Dims dims(Flags) const { return {1, 0}; }
    int controls() const { return 1; }
    std::array<double, 2> control_means(Flags) const { return {mk_.prepaid(), 0.0}; }
    Sample path(const double* z, const double*, Flags, double*) const {
        const double s = mk_.S0 * fast_exp(mk_.drift() * mk_.T + sd_ * z[0]);
        return {disc_ * mk_.payoff(s), {disc_ * s, 0.0}};
    }
    double reference() const { return mk_.vanilla(); }

private:
    Market mk_;
    double disc_, sd_;
};

class EuropeanMerton {
public:
    static constexpr Flags kMethods = kAnti | kControl | kStrat | kCond;
    EuropeanMerton(const Market& mk, const Jumps& j)
        : mk_(mk), j_(j), pois_(j.lam * mk.T), disc_(mk.disc()), sd_(mk.sigma * std::sqrt(mk.T)),
          comp_(-j.lam * j.k() * mk.T) {
        for (std::size_t n = 0; n < pois_.cdf.size(); ++n) {
            value_.push_back(merton_conditional(mk.S0, mk.K, mk.T, mk.r, mk.q, mk.sigma, j, int(n), mk.phi));
            forward_.push_back(mk.S0 * std::exp(-mk.q * mk.T + comp_ + n * std::log1p(j.k())));
        }
    }
    Dims dims(Flags f) const { return f & kCond ? Dims{0, 1} : Dims{2, 1}; }
    int controls() const { return 2; }
    std::array<double, 2> control_means(Flags f) const {
        return {mk_.prepaid(), f & kCond ? j_.lam * mk_.T : mk_.vanilla()};
    }
    Sample path(const double* z, const double* u, Flags f, double*) const {
        const int n = pois_.invert(u[0]);
        if (f & kCond) return {value_[n], {forward_[n], double(n)}};
        const double base = mk_.S0 * fast_exp(mk_.drift() * mk_.T + sd_ * z[0]);
        const double s = base * fast_exp(comp_ + n * j_.mu + std::sqrt(double(n)) * j_.delta * z[1]);
        return {disc_ * mk_.payoff(s), {disc_ * s, disc_ * mk_.payoff(base)}};
    }
    double reference() const { return merton_series(mk_.S0, mk_.K, mk_.T, mk_.r, mk_.q, mk_.sigma, j_, mk_.phi); }

private:
    Market mk_;
    Jumps j_;
    Poisson pois_;
    double disc_, sd_, comp_;
    std::vector<double> value_, forward_;
};

// ------------------------------------------------------------------------------------- Asian
class AsianArithmetic {
public:
    static constexpr Flags kMethods = kAnti | kControl | kStrat;
    AsianArithmetic(const Market& mk, int m)
        : mk_(mk), m_(m), disc_(mk.disc()), mean_(mk.drift() * mk.T / m), sd_(mk.sigma * std::sqrt(mk.T / m)), w_(m) {
        double norm = 0.0;
        for (int i = 0; i < m; ++i) norm += double(m - i) * (m - i);
        for (int i = 0; i < m; ++i) w_[i] = (m - i) / std::sqrt(norm);
    }
    Dims dims(Flags f) const { return {m_ + (f & kStrat ? 1 : 0), 0}; }
    int controls() const { return 1; }
    std::array<double, 2> control_means(Flags) const { return {reference_geometric(), 0.0}; }
    Sample path(const double* z, const double*, Flags f, double*) const {
        double lift = 0.0;
        if (f & kStrat) {  // z[0] is the stratified projection on the geometric-average direction
            double dot = 0.0;
            for (int i = 0; i < m_; ++i) dot += z[i + 1] * w_[i];
            lift = z[0] - dot;
            ++z;
        }
        double x = 0.0, sum = 0.0, logsum = 0.0;
        for (int i = 0; i < m_; ++i) {
            x += mean_ + sd_ * (z[i] + lift * w_[i]);
            sum += fast_exp(x);
            logsum += x;
        }
        return {disc_ * mk_.payoff(mk_.S0 * sum / m_), {disc_ * mk_.payoff(mk_.S0 * fast_exp(logsum / m_)), 0.0}};
    }
    double reference() const { return arithmetic_asian(mk_.S0, mk_.K, mk_.T, mk_.r, mk_.q, mk_.sigma, m_, mk_.phi); }
    double reference_geometric() const {
        return geometric_asian(mk_.S0, mk_.K, mk_.T, mk_.r, mk_.q, mk_.sigma, m_, mk_.phi);
    }

private:
    Market mk_;
    int m_;
    double disc_, mean_, sd_;
    std::vector<double> w_;
};

// ----------------------------------------------------------------------------------- barrier
enum class Monitor { bridge, naive, shifted };

class Barrier {
public:
    static constexpr Flags kMethods = kAnti | kControl | kStrat | kCond;
    Barrier(const Market& mk, double H, int dir, bool knock_in, Monitor mode, int m)
        : mk_(mk), H_(H), dir_(dir), in_(knock_in), mode_(mode), m_(m), disc_(mk.disc()),
          mean_(mk.drift() * mk.T / m), sd_(mk.sigma * std::sqrt(mk.T / m)), root_(1.0 / std::sqrt(double(m))) {
        const double level = mode == Monitor::shifted ? H * std::exp(dir * kBgkBeta * sd_) : H;
        h_ = std::log(level / mk.S0);
    }
    Dims dims(Flags f) const {
        return {m_ + (f & kStrat ? 1 : 0), mode_ == Monitor::bridge && !(f & kCond) ? 1 : 0};
    }
    int controls() const { return 2; }
    std::array<double, 2> control_means(Flags) const { return {mk_.prepaid(), mk_.vanilla()}; }
    Sample path(const double* z, const double* u, Flags f, double*) const {
        double lift = 0.0;
        if (f & kStrat) {  // z[0] is the stratified terminal Brownian value
            double dot = 0.0;
            for (int i = 0; i < m_; ++i) dot += z[i + 1];
            lift = root_ * (z[0] - root_ * dot);
            ++z;
        }
        const double scale = -2.0 / (sd_ * sd_);
        double x = 0.0, gap = -dir_ * h_, surv = gap > 0.0 ? 1.0 : 0.0;
        for (int i = 0; i < m_; ++i) {
            x += mean_ + sd_ * (z[i] + lift);
            const double next = dir_ * (x - h_);
            if (!(next > 0.0)) surv = 0.0;
            if (surv > 0.0 && mode_ == Monitor::bridge) {
                const double e = scale * gap * next;
                if (e > -40.0) surv *= 1.0 - fast_exp(e);  // below that, 1 - exp(e) == 1 in double
            }
            gap = next;
        }
        if (mode_ == Monitor::bridge && !(f & kCond)) surv = u[0] < surv ? 1.0 : 0.0;
        const double s = mk_.S0 * fast_exp(x), v = disc_ * mk_.payoff(s);
        return {v * (in_ ? 1.0 - surv : surv), {disc_ * s, v}};
    }
    double reference() const {
        return barrier_price(mk_.S0, mk_.K, H_, mk_.T, mk_.r, mk_.q, mk_.sigma, dir_, in_, mk_.phi);
    }

private:
    Market mk_;
    double H_;
    int dir_;  // +1 down, -1 up
    bool in_;
    Monitor mode_;
    int m_;
    double disc_, mean_, sd_, root_, h_ = 0.0;
};

// ---------------------------------------------------------------------------------- American
// Continuation value per exercise date: a cubic in x = S/K, NaN where the policy never exercises.
using Policy = std::vector<std::array<double, 4>>;

// Least squares for an n x 4 system by Householder QR; overwrites its inputs.
inline std::array<double, 4> least_squares4(std::vector<std::array<double, 4>>& a, std::vector<double>& b) {
    constexpr int p = 4;
    const std::size_t n = a.size();
    std::array<double, p> diag{};
    for (int k = 0; k < p; ++k) {
        double norm = 0.0;
        for (std::size_t i = k; i < n; ++i) norm += a[i][k] * a[i][k];
        norm = std::sqrt(norm);
        if (a[k][k] > 0.0) norm = -norm;
        diag[k] = norm;
        if (norm == 0.0) continue;
        a[k][k] -= norm;
        double vv = 0.0;
        for (std::size_t i = k; i < n; ++i) vv += a[i][k] * a[i][k];
        auto reflect = [&](auto get) {
            double dot = 0.0;
            for (std::size_t i = k; i < n; ++i) dot += a[i][k] * get(i);
            dot *= 2.0 / vv;
            for (std::size_t i = k; i < n; ++i) get(i) -= dot * a[i][k];
        };
        for (int j = k + 1; j < p; ++j) reflect([&](std::size_t i) -> double& { return a[i][j]; });
        reflect([&](std::size_t i) -> double& { return b[i]; });
    }
    std::array<double, p> x{};
    for (int k = p - 1; k >= 0; --k) {
        double s = b[k];
        for (int j = k + 1; j < p; ++j) s -= a[k][j] * x[j];
        x[k] = std::fabs(diag[k]) > 1e-14 ? s / diag[k] : 0.0;
    }
    return x;
}

class AmericanPut {
public:
    static constexpr Flags kMethods = kAnti | kControl;
    AmericanPut(const Market& mk, int m, int n_fit, std::uint32_t fit_seed)
        : mk_(mk), m_(m), mean_(mk.drift() * mk.T / m), sd_(mk.sigma * std::sqrt(mk.T / m)), dt_(mk.T / m),
          policy_(cached_policy(n_fit, fit_seed)) {}
    Dims dims(Flags) const { return {m_, 0}; }
    int controls() const { return 1; }
    std::array<double, 2> control_means(Flags) const { return {mk_.vanilla(), 0.0}; }
    Sample path(const double* z, const double*, Flags, double*) const {
        double x = 0.0, s = mk_.S0;
        for (int i = 0; i < m_; ++i) {
            x += mean_ + sd_ * z[i];
            const bool last = i == m_ - 1;
            s = mk_.S0 * fast_exp(x);
            if (!last && s < mk_.K) {
                const auto& c = (*policy_)[i];
                const double w = s / mk_.K;
                if (!(1.0 - w > c[0] + w * (c[1] + w * (c[2] + w * c[3])))) continue;  // NaN: continue
            } else if (!last) {
                continue;
            }
            const double t = (i + 1) * dt_, d = fast_exp(-mk_.r * t);
            return {d * std::max(mk_.K - s, 0.0),
                    {d * black_scholes(s, mk_.K, last ? 0.0 : mk_.T - t, mk_.r, mk_.q, mk_.sigma, -1.0), 0.0}};
        }
        return {0.0, {0.0, 0.0}};  // unreachable
    }
    double reference() const { return bermudan_put(mk_.S0, mk_.K, mk_.T, mk_.r, mk_.q, mk_.sigma, m_, 2000); }
    const Policy& policy() const { return *policy_; }

private:
    std::shared_ptr<const Policy> cached_policy(int n_fit, std::uint32_t seed) const {
        using Key = std::tuple<double, double, double, double, double, double, int, int, std::uint32_t>;
#ifndef VROPT_NO_THREADS
        static std::mutex mutex;
        const std::scoped_lock lock(mutex);
#endif
        static std::map<Key, std::shared_ptr<const Policy>> cache;
        const Key key{mk_.S0, mk_.K, mk_.T, mk_.r, mk_.q, mk_.sigma, m_, n_fit, seed};
        if (auto it = cache.find(key); it != cache.end()) return it->second;
        if (cache.size() >= 64) cache.clear();
        return cache[key] = std::make_shared<const Policy>(fit(n_fit, seed));
    }

    // Longstaff-Schwartz (2001), in-the-money paths only, on a stream of its own.
    Policy fit(int n_fit, std::uint32_t seed) const {
        constexpr int kBlock = 4096;
        constexpr std::uint32_t kPolicyStream = 2;
        std::vector<double> x(std::size_t(n_fit) * m_);  // row per path
        parallel_for((n_fit + kBlock - 1) / kBlock, [&](int b) {
            Pcg64 g(seed, kPolicyStream, std::uint32_t(b));
            for (int i = b * kBlock; i < std::min(n_fit, (b + 1) * kBlock); ++i) {
                double w = 0.0;
                for (int j = 0; j < m_; ++j) {
                    w += mean_ + sd_ * inv_normal(clip_uniform(g.uniform()));
                    x[std::size_t(i) * m_ + j] = mk_.S0 * fast_exp(w) / mk_.K;
                }
            }
        });
        const double nan = std::nan("");
        Policy coef(m_, {nan, nan, nan, nan});
        std::vector<double> cash(n_fit), rhs;
        std::vector<std::array<double, 4>> basis;
        std::vector<int> itm;
        for (int i = 0; i < n_fit; ++i) cash[i] = std::max(1.0 - x[std::size_t(i) * m_ + m_ - 1], 0.0);
        const double step = std::exp(-mk_.r * mk_.T / m_);
        for (int j = m_ - 2; j >= 0; --j) {
            itm.clear(), basis.clear(), rhs.clear();
            for (int i = 0; i < n_fit; ++i) {
                cash[i] *= step;
                const double v = x[std::size_t(i) * m_ + j];
                if (v < 1.0) itm.push_back(i), basis.push_back({1.0, v, v * v, v * v * v}), rhs.push_back(cash[i]);
            }
            if (itm.size() < 50) continue;
            const auto c = coef[j] = least_squares4(basis, rhs);
            for (int i : itm) {
                const double v = x[std::size_t(i) * m_ + j];
                if (1.0 - v > c[0] + v * (c[1] + v * (c[2] + v * c[3]))) cash[i] = 1.0 - v;
            }
        }
        return coef;
    }

    Market mk_;
    int m_;
    double mean_, sd_, dt_;
    std::shared_ptr<const Policy> policy_;
};

using AnyProduct = std::variant<EuropeanGBM, EuropeanMerton, AsianArithmetic, Barrier, AmericanPut>;
static_assert(Product<EuropeanGBM> && Product<EuropeanMerton> && Product<AsianArithmetic> && Product<Barrier> &&
              Product<AmericanPut>);

}  // namespace vropt
