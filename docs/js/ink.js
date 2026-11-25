// The ink engine: thousands of polylines drawn as instanced quads in WebGL2, with a Canvas 2D fallback.
// Lines land with a left-to-right reveal and morph to new positions when the same set is redrawn.
"use strict";

const Ink = (() => {
  const F = 16; // floats per segment: from x0 y0 x1 y1 | to x0 y0 x1 y1 | r g b a | width birth order0 order1
  const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
  let host, cv, gl, ctx, prog, vao, buf, loc = {}, raf = 0;
  let data = new Float32Array(0), count = 0, lines = [], key = "", m0 = 0, mDur = 1, reveal = 700, clip = null;

  const VS = `#version 300 es
  precision highp float;
  layout(location=0) in vec4 a_from; layout(location=1) in vec4 a_to; layout(location=2) in vec4 a_col; layout(location=3) in vec4 a_misc;
  uniform vec2 u_res; uniform float u_now, u_m, u_rev, u_dpr;
  out vec4 v_col; out float v_side; out float v_w;
  void main(){
    float e = 1.0 - pow(1.0 - u_m, 3.0);
    vec2 p0 = mix(a_from.xy, a_to.xy, e), p1 = mix(a_from.zw, a_to.zw, e);
    float r = clamp((u_now - a_misc.y) / u_rev, 0.0, 1.0); r = 1.0 - pow(1.0 - r, 2.2);
    float k = clamp((r - a_misc.z) / max(a_misc.w - a_misc.z, 1e-6), 0.0, 1.0);
    p1 = mix(p0, p1, k);
    int c = gl_VertexID; float end = (c == 1 || c == 2 || c == 4) ? 1.0 : 0.0; float side = (c == 2 || c == 4 || c == 5) ? 1.0 : -1.0;
    vec2 d = p1 - p0; float len = length(d); vec2 t = len > 1e-4 ? d / len : vec2(1.0, 0.0); vec2 n = vec2(-t.y, t.x);
    float w = a_misc.x * 0.5 + 0.9 / u_dpr;
    vec2 p = mix(p0, p1, end) + t * (end * 2.0 - 1.0) * a_misc.x * 0.5 * step(1.5, a_misc.x) + n * side * w;
    gl_Position = k <= 0.0 ? vec4(2.0, 2.0, 0.0, 1.0) : vec4(p.x / u_res.x * 2.0 - 1.0, 1.0 - p.y / u_res.y * 2.0, 0.0, 1.0);
    v_col = a_col; v_side = side; v_w = w * u_dpr;
  }`;
  const FS = `#version 300 es
  precision mediump float; in vec4 v_col; in float v_side; in float v_w; out vec4 o;
  void main(){ float edge = clamp((1.0 - abs(v_side)) * v_w / 1.1, 0.0, 1.0); float a = v_col.a * edge; o = vec4(v_col.rgb * a, a); }`;

  const dpr = () => Math.min(2, window.devicePixelRatio || 1);
  const now = () => performance.now();

  function mount(el) {
    host = el;
    cv = document.createElement("canvas");
    cv.className = "ink";
    cv.setAttribute("aria-hidden", "true");
    host.prepend(cv);
    gl = new URLSearchParams(location.search).has("canvas") ? null : cv.getContext("webgl2", { antialias: false, alpha: true, premultipliedAlpha: true });
    if (gl) {
      init();
      cv.addEventListener("webglcontextlost", (e) => e.preventDefault());
      cv.addEventListener("webglcontextrestored", () => { init(); upload(); kick(); });
    } else ctx = cv.getContext("2d");
    document.addEventListener("visibilitychange", kick);
    size();
  }

  function init() {
    const sh = (k, src) => { const s = gl.createShader(k); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) console.error(gl.getShaderInfoLog(s)); return s; };
    prog = gl.createProgram();
    gl.attachShader(prog, sh(gl.VERTEX_SHADER, VS));
    gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(prog);
    for (const k of ["u_res", "u_now", "u_m", "u_rev", "u_dpr"]) loc[k] = gl.getUniformLocation(prog, k);
    vao = gl.createVertexArray();
    buf = gl.createBuffer();
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    for (let i = 0; i < 4; i++) {
      gl.enableVertexAttribArray(i);
      gl.vertexAttribPointer(i, 4, gl.FLOAT, false, F * 4, i * 16);
      gl.vertexAttribDivisor(i, 1);
    }
  }

  function size() {
    if (!cv) return;
    cv.width = Math.max(1, Math.round(host.clientWidth * dpr()));
    cv.height = Math.max(1, Math.round(host.clientHeight * dpr()));
    kick();
  }

  // A line is {pts: [x0, y0, x1, y1, ...] in CSS pixels, color: [r, g, b], alpha, width, delay}.
  function pack(set, t, from) {
    let n = 0;
    for (const l of set) n += Math.max(0, l.pts.length / 2 - 1);
    const out = new Float32Array(n * F);
    let o = 0;
    for (const l of set) {
      const p = l.pts, segs = p.length / 2 - 1, birth = l.birth ?? t + (l.delay || 0);
      l.birth = birth;
      // reveal follows x, so a line draws from left to right
      const x0 = p[0], span = Math.max(1e-6, p[p.length - 2] - x0);
      for (let s = 0; s < segs; s++) {
        const a = 2 * s;
        out.set([p[a], p[a + 1], p[a + 2], p[a + 3], p[a], p[a + 1], p[a + 2], p[a + 3], l.color[0], l.color[1], l.color[2], l.alpha ?? 1, l.width ?? 1, birth, (p[a] - x0) / span, (p[a + 2] - x0) / span], o);
        o += F;
      }
    }
    if (from && from.length === out.length) for (let i = 0; i < out.length; i += F) out.set(from.subarray(i, i + 4), i); // morph from where they were
    return out;
  }

  // Where every segment is right now, so a new morph starts from there.
  function current() {
    const e = 1 - (1 - morphT()) ** 3, out = new Float32Array(data.length);
    for (let i = 0; i < data.length; i += F) for (let j = 0; j < 4; j++) out[i + j] = data[i + j] + (data[i + 4 + j] - data[i + j]) * e;
    return out;
  }
  const morphT = () => (still ? 1 : Math.min(1, (now() - m0) / mDur));

  // Replace everything. With the same key and the same shape, segments morph from where they are.
  function draw(set, opts = {}) {
    const t = now(), same = opts.key && opts.key === key && opts.morph;
    const from = same ? current() : null;
    if (!same) for (const l of set) if (l.birth === undefined && opts.instant) l.birth = -1e9;
    lines = set;
    key = opts.key || "";
    reveal = opts.reveal || 700;
    clip = opts.clip || null;
    data = pack(set, t, from);
    if (from && from.length !== data.length) for (const l of set) l.birth = -1e9;
    m0 = t;
    mDur = same ? opts.morph : 1;
    upload();
    kick();
  }
  // Append lines that land now, keeping what is already drawn.
  function add(set) {
    const t = now(), extra = pack(set, t, null), next = new Float32Array(data.length + extra.length);
    next.set(morphT() < 1 ? current() : data);
    if (morphT() < 1) for (let i = 0; i < data.length; i += F) next.set(data.subarray(i + 4, i + F), i + 4);
    next.set(extra, data.length);
    lines = lines.concat(set);
    data = next;
    upload();
    kick();
  }
  function clear() { lines = []; data = new Float32Array(0); key = ""; clip = null; upload(); kick(); }

  function upload() {
    count = data.length / F;
    if (!gl) return;
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
  }

  function busy(t) {
    if (morphT() < 1) return true;
    for (const l of lines) if (t - l.birth < reveal) return true;
    return false;
  }

  function frame() {
    raf = 0;
    const t = now(), w = host.clientWidth, h = host.clientHeight;
    if (gl) {
      gl.viewport(0, 0, cv.width, cv.height);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      if (count) {
        const k = dpr();
        if (clip) { gl.enable(gl.SCISSOR_TEST); gl.scissor(Math.floor(clip[0] * k), Math.floor((h - clip[1] - clip[3]) * k), Math.ceil(clip[2] * k), Math.ceil(clip[3] * k)); } else gl.disable(gl.SCISSOR_TEST);
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
        gl.useProgram(prog);
        gl.bindVertexArray(vao);
        gl.uniform2f(loc.u_res, w, h);
        gl.uniform1f(loc.u_now, still ? 1e12 : t);
        gl.uniform1f(loc.u_m, morphT());
        gl.uniform1f(loc.u_rev, reveal);
        gl.uniform1f(loc.u_dpr, dpr());
        gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, count);
      }
    } else paint2d(t);
    if (!document.hidden && !still && busy(t)) raf = requestAnimationFrame(frame);
  }

  function paint2d(t) {
    const k = dpr(), e = 1 - (1 - morphT()) ** 3;
    ctx.setTransform(k, 0, 0, k, 0, 0);
    ctx.clearRect(0, 0, cv.width, cv.height);
    ctx.lineJoin = "round";
    ctx.save();
    if (clip) { ctx.beginPath(); ctx.rect(...clip); ctx.clip(); }
    let o = 0;
    for (const l of lines) {
      const segs = l.pts.length / 2 - 1, r = still ? 1 : Math.min(1, Math.max(0, (t - l.birth) / reveal)), rr = 1 - (1 - r) ** 2.2;
      ctx.strokeStyle = `rgb(${255 * l.color[0]},${255 * l.color[1]},${255 * l.color[2]})`;
      ctx.globalAlpha = l.alpha ?? 1;
      ctx.lineWidth = l.width ?? 1;
      ctx.beginPath();
      for (let s = 0; s < segs; s++, o += F) {
        if (data[o + 14] > rr) continue;
        const x0 = data[o] + (data[o + 4] - data[o]) * e, y0 = data[o + 1] + (data[o + 5] - data[o + 1]) * e;
        const x1 = data[o + 2] + (data[o + 6] - data[o + 2]) * e, y1 = data[o + 3] + (data[o + 7] - data[o + 3]) * e;
        if (s === 0 || data[o + 14 - F] > rr) ctx.moveTo(x0, y0);
        ctx.lineTo(x1, y1);
      }
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    ctx.restore();
  }

  function kick() { if (!raf && cv) raf = requestAnimationFrame(frame); }

  return { mount, draw, add, clear, size, get webgl() { return Boolean(gl); }, get width() { return host.clientWidth; }, get height() { return host.clientHeight; } };
})();
