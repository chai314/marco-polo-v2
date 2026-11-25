# Marco Polo

Four variance-reduction methods for Monte Carlo option pricing, antithetic variates (A), control variates (C), stratification (S) and conditioning (K), in every combination, measured at equal cost against prices that were not simulated.

The site runs the C++ engine in your browser as WebAssembly. Every number on it is computed from the contract you set: nothing is precomputed or looked up.

## Open it

Open `docs/index.html` in a browser; it works straight from disk. To serve it:

```
python -m http.server -d docs
```

On GitHub Pages it is served from the `docs/` folder.

## What is on the page

**The story.** A guided walk through a Galton board, the bean machine that turns randomness into a bell curve. Every ball is one simulated future of the stock: it falls through the pins along its real simulated path and lands at its price on expiry day. The option's price is the average payoff, and a needle under the board shows that average settling on the true price (the yellow bar). Chapters then bolt on one trick at a time, each with its own gadget on the board:

- **A, mirror twins** (antithetic variates): every ball is dropped with a twin that gets the opposite nudge at every pin.
- **S, a fair share for every lane** (stratification): the landing zone is cut into 32 equally likely lanes, and each gets the same number of balls.
- **C, an answer key** (control variate): the stock's own average, whose true value is known, corrects the option's estimate.
- **K, skip the dice** (conditioning): with jumps, only the number of jumps is rolled; a formula does the rest.

Each chapter reports, live, how much smaller the error gets for the same number of balls. The last chapter ranks all 15 combinations.

**The lab.** Every product (European, Asian, barrier, American), stock and setting, with five views: the board, convergence of 64 runs against the exact price, the paths, the market data and its fitted jump model, and notes on each method. Drag a field's name sideways to scrub its number.

The board (`docs/js/board.js`) and the line renderer (`docs/js/ink.js`) are small WebGL2 renderers with Canvas 2D fallbacks; add `?canvas` to the URL to see the fallback.

## How the headline is measured, and where it is weak

- The factor is (variance × paths) of plain over (variance × paths) of the combination, from repeated independent runs at the chosen run length. Antithetic pairs are charged as two paths, and the control-variate pilot (5% of the budget, on its own random stream) is paid for.
- The variance is the mean of the reported squared standard errors. If the spread actually observed across runs is clearly larger (more than about 25% in variance, allowing for sampling noise), the observed spread is used instead, and the page says so. Under Merton jumps with short runs this happens: rare jumps are missing from most runs, so their reported errors are too small.
- American prices (Longstaff–Schwartz) and grid-monitored barriers are biased. Their variance is measured about their own mean, and the bias is reported separately on the page.
- Stratified standard errors can be 20 to 25% too small when a stratum holds very few paths.
- Run times on the page come from one worker in your browser and are noisy.

## Three questions

**Why does the standard error fall like 1/√N?** The estimate is a mean of N independent draws, so its variance is Var(Y)/N and its standard deviation is σ/√N. Variance reduction lowers σ; it narrows the funnel and leaves its shape alone.

**Why does a pilot β keep the estimator unbiased?** Given the pilot, β is a constant, and E[Y − β(C − E[C])] = E[Y] for any constant. Fitting β on the pricing paths themselves would tie it to them and leave a bias of order 1/N.

**Why does antithetic sampling need monotonicity?** If the payoff is monotone in each normal, f(Z) and f(−Z) are negatively correlated and a pair beats two independent paths. For a payoff symmetric about its centre they move together, and the pair is worse than two independent paths.

## Checks

Every price is compared with one that was not simulated: Black–Scholes, Merton's series, a quadrature recursion for the arithmetic Asian, Reiner–Rubinstein for barriers, and a lattice with the same exercise dates for the American put.

- `cpp/`: C++20 header library, C ABI, CLI and unit tests (283 checks). PCG64 and SeedSequence are ported bit for bit from NumPy, and results do not depend on the thread count.
- `vropt/`: NumPy reference implementation, analytic prices, data layer and calibration. `vropt.native` loads the C++ by ctypes and falls back to NumPy.
- `tests/`: unbiasedness, calibration and coverage for every combination; the C++ against NumPy path for path; and the WebAssembly build the site ships, run under Node through the page's own worker code, against the native C++ (`tests/test_wasm.py`, agreement to 1e-9).

```
pip install -r requirements-dev.txt
python -m vropt.native
python -m pytest
cmake -S cpp -B cpp/build && cmake --build cpp/build && cpp/build/vropt_tests
python tools/build_site.py
```

`tools/build_site.py` rebuilds `docs/js/engine.wasm.js` (needs `ziglang`) and `docs/js/market.js` from `data/`. Both outputs are committed, so the site needs no build step.

## Data

Closing prices, option chains and dividend yields for SPY, QQQ, IWM, AAPL, MSFT and NVDA at the close of 24 November 2026, from Yahoo Finance through yfinance; the three-month Treasury rate from FRED. Listed options on these names are American; their early-exercise premium is ignored when the smile is fitted. The page can also draw a synthetic market in the browser, and says so when it does.

## Sources

Section numbers on the page refer to Glasserman, *Monte Carlo Methods in Financial Engineering* (2004). Also Longstaff and Schwartz (2001), Merton (1976), and Broadie, Glasserman and Kou (1997). Set in TeX Gyre Heros and Latin Modern Math, under the GUST font licence (`docs/fonts`).
