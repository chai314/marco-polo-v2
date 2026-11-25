// Dependency-free unit tests: numerics against known values, estimators against closed forms.
#include <cstdio>

#include "vropt/engine.hpp"

using namespace vropt;

static int failures = 0, checks = 0;
#define CHECK(cond)                                                                     \
    do {                                                                                \
        ++checks;                                                                       \
        if (!(cond)) ++failures, std::printf("FAIL %s:%d  %s\n", __FILE__, __LINE__, #cond); \
    } while (0)
static bool close(double a, double b, double tol) { return std::fabs(a - b) <= tol; }

static void test_numerics() {
    CHECK(close(inv_normal(0.975), 1.959963984540054, 1e-14));
    CHECK(close(inv_normal(1e-10), -6.361340902404056, 1e-12));
    CHECK(inv_normal(0.5) == 0.0);
    for (double p : {1e-12, 1e-4, 0.1, 0.3, 0.7, 0.999}) CHECK(close(norm_cdf(inv_normal(p)), p, 4e-15));
    for (double x = -30; x <= 30; x += 0.37) CHECK(std::fabs(fast_exp(x) / std::exp(x) - 1.0) < 5e-16);
    Pcg64 g(1, 0, 0);
    double s = 0;
    for (int i = 0; i < 1 << 20; ++i) s += g.uniform();
    CHECK(close(s / (1 << 20), 0.5, 4 * 0.2887 / 1024));
}

static void test_closed_forms() {
    CHECK(close(black_scholes(100, 100, 1, 0.05, 0, 0.2, 1), 10.450583572185565, 1e-12));
    CHECK(close(black_scholes(100, 100, 1, 0.05, 0, 0.2, -1), 5.573526022256971, 1e-12));
    const Jumps none{0.0, -0.1, 0.15};
    CHECK(close(merton_series(100, 95, 0.5, 0.03, 0.01, 0.25, none, 1),
                black_scholes(100, 95, 0.5, 0.03, 0.01, 0.25, 1), 1e-12));
    for (int dir : {1, -1})
        for (double phi : {1.0, -1.0})
            for (double K : {80.0, 100.0, 125.0}) {
                const double H = dir > 0 ? 90 : 115;
                const double in = barrier_price(100, K, H, 1, 0.04, 0.01, 0.25, dir, true, phi);
                const double out = barrier_price(100, K, H, 1, 0.04, 0.01, 0.25, dir, false, phi);
                CHECK(in >= 0 && out >= 0);
                CHECK(close(in + out, black_scholes(100, K, 1, 0.04, 0.01, 0.25, phi), 1e-10));
            }
    // arithmetic Asian: one fixing is a European, the converged value for m=50 comes from the Python recursion
    CHECK(close(arithmetic_asian(100, 102, 1, 0.04, 0.01, 0.3, 1, 1), black_scholes(100, 102, 1, 0.04, 0.01, 0.3, 1), 1e-9));
    CHECK(close(arithmetic_asian(100, 100, 1, 0.04, 0, 0.2, 50, 1), 5.6097674, 2e-5));
    CHECK(arithmetic_asian(100, 102, 1, 0.04, 0.01, 0.3, 12, 1) > geometric_asian(100, 102, 1, 0.04, 0.01, 0.3, 12, 1));
    // Longstaff-Schwartz (2001), Table 1, finite-difference American values
    CHECK(close(bermudan_put(36, 40, 1, 0.06, 0, 0.2, 1000, 1000), 4.478, 1.2e-2));
    CHECK(close(bermudan_put(44, 40, 2, 0.06, 0, 0.4, 1000, 1000), 5.647, 1.2e-2));
}

template <Product P>
static void unbiased(const char* name, const P& p, double ref, Flags allowed, double extra = 0.0) {
    for (Flags f = 0; f < 16; ++f) {
        if (f & ~allowed) continue;
        double sum = 0, var = 0;
        const int reps = 40;
        const Plan plan = make_plan(p.dims(f), f, 20000);
        for (int i = 0; i < reps; ++i) {
            const Result r = price(p, plan, 500u + i);
            sum += r.price, var += r.se * r.se;
        }
        const double err = sum / reps - ref;
        ++checks;
        if (std::fabs(err) > 4.5 * std::sqrt(var) / reps + extra + 1e-12) {
            ++failures;
            std::printf("FAIL bias %s %s error %.3e se %.3e\n", name, method_label(f).c_str(), err,
                        std::sqrt(var) / reps);
        }
    }
}

static void test_estimators() {
    const Market call{100, 105, 0.75, 0.04, 0.01, 0.25, 1};
    const Market put{100, 105, 0.75, 0.04, 0.01, 0.25, -1};
    const EuropeanGBM gbm(put);
    unbiased("gbm", gbm, gbm.reference(), EuropeanGBM::kMethods);
    const EuropeanMerton merton(call, {1.0, -0.08, 0.12});
    unbiased("merton", merton, merton.reference(), EuropeanMerton::kMethods);
    const Barrier down(call, 90, 1, false, Monitor::bridge, 8), up(put, 115, -1, true, Monitor::bridge, 8);
    unbiased("down-out call", down, down.reference(), Barrier::kMethods);
    unbiased("up-in put", up, up.reference(), Barrier::kMethods);
    const AmericanPut american(put, 10, 20000, 1);
    unbiased("american", american, american.reference(), AmericanPut::kMethods, 0.02);  // LSM is low-biased
    // one fixing: the arithmetic average is the terminal price
    const AsianArithmetic one(call, 1);
    unbiased("one-fixing asian", one, call.vanilla(), AsianArithmetic::kMethods);
    const AsianArithmetic twelve(put, 12);
    unbiased("asian", twelve, twelve.reference(), AsianArithmetic::kMethods);
}

static void test_determinism() {
    const Market mk{};
    const Barrier p(mk, 85, 1, false, Monitor::bridge, 20);
    const Flags f = kAnti | kControl | kStrat | kCond;
    const Plan plan = make_plan(p.dims(f), f, 100000);
    const int before = thread_limit();
    thread_limit() = 1;
    const Result a = price(p, plan, 42);
    thread_limit() = 7;
    const Result b = price(p, plan, 42);
    thread_limit() = before;
    CHECK(a.price == b.price && a.se == b.se);  // bitwise, whatever the thread count
    CHECK(price(p, plan, 43).price != a.price);
}

int main() {
    test_numerics();
    test_closed_forms();
    test_estimators();
    test_determinism();
    std::printf("%d checks, %d failures\n", checks, failures);
    return failures != 0;
}
