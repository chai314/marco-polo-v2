// Text for the Notes view. Section numbers refer to Glasserman (2004).
"use strict";

const NOTES = {
  product: {
    european: "One normal decides everything, so stratifying it removes almost all the variance. The control is the discounted spot; the check is Black–Scholes.",
    merton: "Given the number of jumps the terminal price is lognormal, so conditioning leaves only a Poisson count to simulate. Without it, the controls are the discounted spot and the vanilla on the jump-free path. The check is Merton’s series.",
    asian: "The geometric average is lognormal and almost perfectly correlated with the arithmetic one, so it is a superb control. Stratifying along the same direction removes much of the same variance, which is why the two do not multiply. The check is a one-dimensional quadrature recursion.",
    barrier: "Conditioning replaces a simulated crossing by its Brownian-bridge probability, which can never raise the variance. The controls are the discounted spot and the vanilla payoff. The check is Reiner–Rubinstein.",
    american: "Longstaff–Schwartz fits a cubic in S/K for the value of waiting, on paths of its own. Pricing on fresh paths is biased slightly low, because a fitted rule cannot beat the best one. The control is the European put at the exercise time. The check is a lattice with the same exercise dates.",
  },
  html: `<div class="cols">
<article style="--c:var(--A)"><h3><i class="dot A">A</i> Antithetic variates</h3><math display="block"><mover><mi>Y</mi><mo>^</mo></mover><mo>=</mo><mfrac><mn>1</mn><mn>2</mn></mfrac><mo stretchy="false">(</mo><mi>f</mi><mo stretchy="false">(</mo><mi>Z</mi><mo stretchy="false">)</mo><mo>+</mo><mi>f</mi><mo stretchy="false">(</mo><mo>−</mo><mi>Z</mi><mo stretchy="false">)</mo><mo stretchy="false">)</mo></math>
<p>Each path is paired with its mirror image, and a pair costs two paths. It wins only if the two payoffs are negatively correlated, which is guaranteed when the payoff is monotone in every normal. Uniforms are mirrored too. Section 4.2.</p></article>
<article style="--c:var(--C)"><h3><i class="dot C">C</i> Control variate</h3><math display="block"><msub><mi>Y</mi><mi>i</mi></msub><mo>−</mo><mi>β</mi><mo stretchy="false">(</mo><msub><mi>C</mi><mi>i</mi></msub><mo>−</mo><mi>E</mi><mo stretchy="false">[</mo><mi>C</mi><mo stretchy="false">]</mo><mo stretchy="false">)</mo></math>
<p>Subtract the error made on something whose mean is known. The coefficient is fitted on a separate pilot, 5% of the budget on its own random stream, so the estimator stays exactly unbiased. Section 4.1.</p></article>
<article style="--c:var(--S)"><h3><i class="dot S">S</i> Stratification</h3><math display="block"><mi>X</mi><mo>=</mo><msup><mi>Φ</mi><mrow><mo>−</mo><mn>1</mn></mrow></msup><mrow><mo>(</mo><mfrac><mrow><mi>h</mi><mo>+</mo><mi>U</mi></mrow><mi>H</mi></mfrac><mo>)</mo></mrow></math>
<p>One direction in path space is cut into equally likely slices, and each gets the same number of paths. The rest of the path is drawn given that coordinate, at linear cost. Only variance within slices is left. Section 4.3.</p></article>
<article style="--c:var(--K)"><h3><i class="dot K">K</i> Conditioning</h3><math display="block"><mi>Var</mi><mspace width="0.2em"></mspace><mi>E</mi><mo stretchy="false">[</mo><mi>Y</mi><mo stretchy="false">∣</mo><mi>X</mi><mo stretchy="false">]</mo><mo>≤</mo><mi>Var</mi><mspace width="0.2em"></mspace><mi>Y</mi></math>
<p>Whatever can be integrated exactly is not simulated. Under jumps the price given the jump count is Black–Scholes; for a barrier the chance of a crossing between dates is a Brownian-bridge formula. Sections 3.5.1 and 6.4.</p></article>
</div>
<div class="cols two">
<article><h3>Why does the standard error fall like 1/√N?</h3><p>The estimate is a mean of N independent draws, so its variance is Var(Y)/N. Variance reduction lowers Var(Y): the funnel gets narrower and keeps its shape.</p></article>
<article><h3>Why does a pilot β keep the estimator unbiased?</h3><p>Given the pilot, β is a constant, and E[Y − β(C − E[C])] = E[Y] for any constant. Fitting β on the pricing paths themselves would tie it to them and leave a bias of order 1/N.</p></article>
<article><h3>Why does antithetic sampling need monotonicity?</h3><p>If f is monotone in each coordinate, f(Z) and f(−Z) are negatively correlated and the pair beats two independent paths. For a payoff symmetric about its centre they move together, and the pair is worse.</p></article>
<article><h3>How is this checked?</h3><p>Every price is compared with one that was not simulated. The C++ engine and a separate NumPy implementation use the same PCG64 stream and agree to at least nine digits on every product and combination. The WebAssembly build is tested against both.</p></article>
</div>
<p class="refs">Section numbers refer to Glasserman, <cite>Monte Carlo Methods in Financial Engineering</cite> (2004). Also Longstaff and Schwartz (2001); Merton (1976); Broadie, Glasserman and Kou (1997). Prices and quotes come from Yahoo Finance through yfinance, and the three-month Treasury from FRED. Listed options on these names are American; their early-exercise premium is ignored in the smile. Set in TeX Gyre Heros and Latin Modern Math.</p>`,
};
