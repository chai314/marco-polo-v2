// Puts the formulas typeset by tools/build_math.py in place: data-eq for display, data-tex for inline.
// The TeX source stays in the page as the formula's accessible name.
"use strict";

const Tex = (() => {
  let defs = false;
  function fill(root = document) {
    if (!window.TEX) return;
    if (!defs) {
      defs = true;
      const s = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      s.setAttribute("aria-hidden", "true");
      s.style.cssText = "position:absolute;width:0;height:0;overflow:hidden";
      s.innerHTML = `<defs>${window.TEX_GLYPHS}</defs>`;
      document.body.prepend(s);
    }
    root.querySelectorAll("[data-eq]:not([data-done]), [data-tex]:not([data-done])").forEach((el) => {
      const display = el.hasAttribute("data-eq"), src = el.getAttribute(display ? "data-eq" : "data-tex"), f = window.TEX[(display ? "D:" : "T:") + src];
      el.dataset.done = "";
      if (!f) { el.textContent = src; el.classList.add("tex-missing"); return; }
      const [svg, w, h, d] = f;
      el.innerHTML = svg;
      el.setAttribute("role", "img");
      el.setAttribute("aria-label", src);
      const g = el.firstChild;
      g.setAttribute("aria-hidden", "true");
      g.setAttribute("fill", "currentColor");
      g.style.width = w + "em";
      g.style.height = h + "em";
      if (!display) g.style.verticalAlign = -d + "em";
    });
  }
  return { fill };
})();
document.addEventListener("DOMContentLoaded", () => Tex.fill());
