// Minimal dynamic parallel-for. Work items carry their own random streams, so results
// depend on the item index only, never on the number of threads.
#pragma once
#include <algorithm>
#include <vector>
#ifndef VROPT_NO_THREADS
#include <atomic>
#include <thread>
#endif

namespace vropt {

inline int& thread_limit() {
#ifdef VROPT_NO_THREADS
    static int limit = 1;  // WebAssembly: the page runs one engine per Web Worker instead
#else
    static int limit = std::max(1u, std::thread::hardware_concurrency());
#endif
    return limit;
}

template <class F>
void parallel_for(int count, F&& body) {
#ifndef VROPT_NO_THREADS
    const int workers = std::min(thread_limit(), count);
    if (workers > 1) {
        std::atomic<int> next{0};
        auto loop = [&] {
            for (int i; (i = next.fetch_add(1)) < count;) body(i);
        };
        std::vector<std::thread> pool;
        for (int t = 1; t < workers; ++t) pool.emplace_back(loop);
        loop();
        for (auto& t : pool) t.join();
        return;
    }
#endif
    for (int i = 0; i < count; ++i) body(i);
}

}  // namespace vropt
