// Standalone front end: price one product under every applicable method combination.
#include <chrono>
#include <cstdio>
#include <map>
#include <stdexcept>
#include <string>

#include "vropt/engine.hpp"

using namespace vropt;

namespace {
int usage() {
    std::puts("usage: vropt_cli <european|merton|asian|barrier|american> [--paths N] [--seed N] [--threads N]\n"
              "  [--S0 x] [--K x] [--T x] [--r x] [--q x] [--sigma x] [--put] [--steps m] [--lam x] [--muj x]\n"
              "  [--delta x] [--barrier x] [--up] [--in] [--mode bridge|naive|shifted]");
    return 2;
}
}  // namespace

int main(int argc, char** argv) try {
    if (argc < 2) return usage();
    std::map<std::string, std::string> opt;
    for (int i = 2; i < argc; ++i) {
        const std::string key = argv[i];
        if (key.rfind("--", 0) != 0) return usage();
        if (key == "--put" || key == "--up" || key == "--in")
            opt[key] = "1";
        else if (++i < argc)
            opt[key] = argv[i];
        else
            return usage();
    }
    auto num = [&](const char* k, double d) { return opt.count(k) ? std::stod(opt[k]) : d; };
    const std::string name = argv[1];
    Market mk{num("--S0", 100), num("--K", 100), num("--T", 1),     num("--r", 0.04),
              num("--q", 0),    num("--sigma", 0.2), opt.count("--put") ? -1.0 : 1.0};
    if (name == "american") mk.phi = -1.0;
    const int m = int(num("--steps", 50));
    const std::int64_t paths = std::int64_t(num("--paths", 200000));
    const auto seed = std::uint32_t(num("--seed", 7));
    if (opt.count("--threads")) thread_limit() = std::max(1, int(num("--threads", 1)));

    const std::string mode = opt.count("--mode") ? opt["--mode"] : "bridge";
    const Monitor mon = mode == "naive" ? Monitor::naive : mode == "shifted" ? Monitor::shifted : Monitor::bridge;
    const bool up = opt.count("--up") > 0;
    const AnyProduct product = [&]() -> AnyProduct {
        if (name == "european") return EuropeanGBM(mk);
        if (name == "merton") return EuropeanMerton(mk, {num("--lam", 0.8), num("--muj", -0.1), num("--delta", 0.15)});
        if (name == "asian") return AsianArithmetic(mk, m);
        if (name == "barrier")
            return Barrier(mk, num("--barrier", up ? mk.S0 * 1.2 : mk.S0 * 0.85), up ? -1 : 1, opt.count("--in") > 0,
                           mon, m);
        if (name == "american") return AmericanPut(mk, m, 20000, 20221);
        throw std::invalid_argument("unknown product " + name);
    }();

    std::visit(
        [&](const auto& p) {
            using P = std::decay_t<decltype(p)>;
            Flags allowed = P::kMethods;
            if constexpr (std::is_same_v<P, Barrier>)
                if (mon != Monitor::bridge) allowed &= ~Flags(kCond);
            std::printf("%s, %lld paths, seed %u, %d threads", name.c_str(), static_cast<long long>(paths), seed,
                        thread_limit());
            const double ref = p.reference();
            if (ref == ref) std::printf(", reference %.6f", ref);
            std::printf("\n%-10s %12s %12s %12s %10s\n", "method", "price", "std.err", "VRF", "ms");
            double base = 0;
            for (Flags f = 0; f < 16; ++f) {
                if (f & ~allowed) continue;
                const Plan plan = make_plan(p.dims(f), f, paths);
                if (!plan.valid()) throw std::invalid_argument("path budget too small");
                const auto t0 = std::chrono::steady_clock::now();
                const Result r = price(p, plan, seed);
                const double ms =
                    std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - t0).count();
                const double v = r.se * r.se * double(r.paths);
                if (f == 0) base = v;
                std::printf("%-10s %12.6f %12.3e %12.1f %10.2f\n", method_label(f).c_str(), r.price, r.se, base / v,
                            ms);
            }
        },
        product);
    return 0;
} catch (const std::exception& e) {
    std::fprintf(stderr, "error: %s\n", e.what());
    return 1;
}
