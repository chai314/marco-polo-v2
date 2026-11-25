"""Typeset the page's mathematics with LaTeX and write docs/js/math.js.

Every formula on the site is written in TeX, in a data-eq (display) or data-tex (inline) attribute in docs/index.html or in
the JavaScript that writes HTML. This script finds them all, typesets each with latex and amsmath, converts the pages to SVG
with dvisvgm, shares the glyph outlines between formulas, and writes them with their sizes and baselines into docs/js/math.js.
docs/js/tex.js puts them in place when the page loads. Needs latex and dvisvgm (TeX Live or MiKTeX).

    python tools/build_math.py
"""

from __future__ import annotations

import html
import json
import re
import subprocess
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SOURCES = [ROOT / "docs" / "index.html", *sorted((ROOT / "docs" / "js").glob("*.js"))]
OUT = ROOT / "docs" / "js" / "math.js"
PT = 12.0  # the document's font size: one em
BP = 72.0 / 72.27  # dvisvgm draws in big points

PREAMBLE = r"""\documentclass[12pt]{article}
\usepackage{amsmath,amssymb,xcolor}
\definecolor{cA}{HTML}{1657C9}\definecolor{cC}{HTML}{B34E00}\definecolor{cS}{HTML}{0B7A57}\definecolor{cK}{HTML}{A8328F}
\newcommand\A[1]{\textcolor{cA}{#1}}\newcommand\C[1]{\textcolor{cC}{#1}}\newcommand\Sc[1]{\textcolor{cS}{#1}}\newcommand\K[1]{\textcolor{cK}{#1}}
\newcommand\E{\mathbb{E}}\newcommand\Q{\mathbb{Q}}\newcommand\Var{\operatorname{Var}}\newcommand\Cov{\operatorname{Cov}}
\newcommand\Corr{\operatorname{Corr}}\newcommand\SE{\operatorname{SE}}\newcommand\N{\mathcal{N}}\newcommand\dd{\mathrm{d}}
\begin{document}
\hoffset=-1in \voffset=-1in
"""


def collect() -> list[tuple[str, bool]]:
    found: dict[tuple[str, bool], None] = {}
    for path in SOURCES:
        if path.name in ("math.js", "engine.wasm.js", "market.js"):
            continue
        text = path.read_text(encoding="utf-8")
        for kind, tex in re.findall(r'data-(eq|tex)="([^"]*)"', text):
            tex = html.unescape(tex)
            if path.suffix == ".js":
                tex = tex.replace("\\\\", "\\")  # written inside a JavaScript string
            found[(tex, kind == "eq")] = None
    return list(found)


def typeset(items: list[tuple[str, bool]]) -> list[dict]:
    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        body = []
        for tex, display in items:
            style = r"\displaystyle" if display else r"\textstyle"
            body.append(rf"\setbox0=\hbox{{${style} {tex}$}}\typeout{{DIM \the\wd0 \the\ht0 \the\dp0}}\shipout\vbox{{\box0}}")
        (tmp / "m.tex").write_text(PREAMBLE + "\n".join(body) + "\n\\end{document}\n", encoding="utf-8")
        run = subprocess.run(["latex", "--disable-installer", "-interaction=nonstopmode", "-halt-on-error", "m.tex"],
                             cwd=tmp, capture_output=True, text=True, stdin=subprocess.DEVNULL)
        log = (tmp / "m.log").read_text(encoding="utf-8", errors="replace")
        if run.returncode:
            raise SystemExit("latex failed:\n" + "\n".join(l for l in log.splitlines() if l.startswith("!") or l.startswith("l.")))
        dims = [tuple(float(x) for x in m) for m in re.findall(r"DIM ([\d.]+)pt([\d.]+)pt([\d.]+)pt", log)]
        assert len(dims) == len(items), (len(dims), len(items))
        subprocess.run(["dvisvgm", "--no-fonts", "-p", "1-", "-o", "m-%p.svg", "m.dvi"], cwd=tmp, check=True,
                       capture_output=True, stdin=subprocess.DEVNULL)
        files = sorted(tmp.glob("m-*.svg"), key=lambda q: int(q.stem.split("-")[1]))  # dvisvgm pads page numbers
        assert len(files) == len(items), (len(files), len(items))
        pages = [q.read_text(encoding="utf-8") for q in files]
    return [{"tex": t, "display": d, "dim": dim, "svg": svg} for (t, d), dim, svg in zip(items, dims, pages)]


def main() -> None:
    items = collect()
    out = typeset(items)
    glyphs: dict[str, str] = {}  # outline -> shared id
    formulas = {}
    local = {}  # dvisvgm defines a glyph once, on the first page that uses it
    for f in out:
        for gid, d in re.findall(r"<path id='([^']+)' d='([^']*)'/>", f["svg"]):
            local[gid] = glyphs.setdefault(d, f"q{len(glyphs)}")
    scaled = {}  # glyphs at another size are drawn as a scaled copy of the base outline
    for f in out:
        for gid, base, tr in re.findall(r"<use id='([^']+)' xlink:href='#([^']+)' transform='([^']+)'/>", f["svg"]):
            scaled[gid] = (base, tr)
    for gid, (base, tr) in scaled.items():
        local[gid] = f"q{len(glyphs) + len(scaled) + list(scaled).index(gid)}"
    for f in out:
        svg = f["svg"]
        body = svg[svg.index("<g id='page"):svg.rindex("</g>") + 4]
        body = re.sub(r"<g id='page\d+'>", "<g>", body)
        body = re.sub(r"xlink:href='#([^']+)'", lambda m: f"href='#{local[m.group(1)]}'", body)
        body = re.sub(r"(-?\d+\.\d{2})\d+", r"\1", body).replace("'", '"')
        wd, ht, dp = f["dim"]
        w, h = wd * BP, (ht + dp) * BP
        formulas[("D:" if f["display"] else "T:") + f["tex"]] = [f'<svg viewBox="-72 -72 {w:.2f} {h:.2f}">{body}</svg>', round(wd / PT, 4), round((ht + dp) / PT, 4), round(dp / PT, 4)]
    trim = lambda d: re.sub(r"(-?\d+\.\d{2})\d+", r"\1", d)  # noqa: E731
    defs = "".join(f'<path id="{i}" d="{trim(d)}"/>' for d, i in glyphs.items())
    defs += "".join(f'<use id="{local[g]}" href="#{local[b]}" transform="{t}"/>' for g, (b, t) in scaled.items())
    OUT.write_text("// Generated by tools/build_math.py from the TeX in the page: do not edit.\n"
                   f"window.TEX_GLYPHS = {json.dumps(defs)};\nwindow.TEX = {json.dumps(formulas, ensure_ascii=False)};\n", encoding="utf-8", newline="\n")
    print(f"{len(formulas)} formulas, {len(glyphs)} glyphs, {OUT.stat().st_size / 1024:.0f} KB -> {OUT.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
