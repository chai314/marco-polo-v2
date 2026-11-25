// The palette, read once from the CSS custom properties in style.css, so the canvas, WebGL and SVG drawing
// use the same colours as the page. Values are "#rrggbb"; PALETTE.rgb() gives 0-1 channels for WebGL.
"use strict";

const PALETTE = (() => {
  const css = getComputedStyle(document.documentElement);
  const get = (name, fallback) => (css.getPropertyValue(name).trim() || fallback).toLowerCase();
  const p = {
    ink: get("--ink", "#14171a"), mute: get("--ink-3", "#5f666f"), ghost: get("--ink-4", "#8a9097"), rule: get("--rule-2", "#c9ced4"),
    pale: get("--pale", "#b9bfc6"), sky: get("--sky", "#a9c0ea"), pin: get("--pin", "#d3d7dc"), pinHot: get("--pin-hot", "#6b727b"),
    lineGrey: get("--line-grey", "#78808a"), linePale: get("--line-pale", "#9ea6b0"),
    A: get("--A", "#1657c9"), C: get("--C", "#ec6a00"), S: get("--S", "#10936a"), K: get("--K", "#a8328f"),
    Cdark: get("--C-dark", "#b34e00"), Sdark: get("--S-dark", "#0b6b4d"), tape: get("--tape", "#fafbfc"), dateLine: get("--date-line", "#e9ecef"), red: get("--red", "#bf3a2f"), truth: get("--truth", "#f2c200"),
  };
  p.rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  return Object.freeze(p);
})();
