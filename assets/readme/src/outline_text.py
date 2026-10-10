"""Convert <text> in an SVG to outlined paths in Instrument Sans / Geist Mono.

Usage: python outline_text.py <fonts-dir> <src.svg> <out.svg>
"""
import re
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

import uharfbuzz as hb
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen

FONTS_DIR, SRC, OUT = (Path(a) for a in sys.argv[1:4])
FILES = {"Instrument Sans": "InstrumentSans.ttf", "Geist Mono": "GeistMono.ttf"}
_fonts = {}


def font_for(family, weight):
    key = (family, weight)
    if key not in _fonts:
        blob = hb.Blob.from_file_path(str(FONTS_DIR / FILES[family]))
        face = hb.Face(blob)
        font = hb.Font(face)
        axes = {"wght": weight}
        if family == "Instrument Sans":
            axes["wdth"] = 100
        font.set_variations(axes)
        _fonts[key] = (font, face.upem)
    return _fonts[key]


def num(v):
    s = f"{v:.2f}".rstrip("0").rstrip(".")
    return "0" if s in ("-0", "") else s


def shape(text, family, weight, size, spacing):
    font, upem = font_for(family, weight)
    buf = hb.Buffer()
    buf.add_str(text)
    buf.guess_segment_properties()
    hb.shape(font, buf, {"kern": True, "liga": True})
    k = size / upem
    x, glyphs = 0.0, []
    for info, pos in zip(buf.glyph_infos, buf.glyph_positions):
        glyphs.append((info.codepoint, x + pos.x_offset * k, pos.y_offset * k))
        x += pos.x_advance * k + spacing
    return font, k, glyphs, x


def outline(el):
    base = {
        "family": el.get("font-family", "Instrument Sans").strip("'\""),
        "weight": int(el.get("font-weight", "400")),
        "size": float(el.get("font-size", "16")),
        "spacing": float(el.get("letter-spacing", "0")),
        "fill": el.get("fill", "#000"),
    }
    runs = []
    if el.text and el.text.strip():
        runs.append((el.text, base))
    for ts in el:
        st = dict(base)
        if ts.get("fill"):
            st["fill"] = ts.get("fill")
        if ts.get("font-weight"):
            st["weight"] = int(ts.get("font-weight"))
        runs.append((ts.text or "", st))
        if ts.tail and ts.tail.strip():
            runs.append((ts.tail, base))
    shaped = [(st, *shape(t, st["family"], st["weight"], st["size"], st["spacing"])) for t, st in runs]
    # CSS adds letter-spacing after the last glyph too; drop it when centering.
    width = sum(s[4] for s in shaped) - (shaped[-1][0]["spacing"] if shaped else 0)
    x0 = float(el.get("x", "0"))
    y0 = float(el.get("y", "0"))
    anchor = el.get("text-anchor", "start")
    if anchor == "middle":
        x0 -= width / 2
    elif anchor == "end":
        x0 -= width
    parts, cursor = [], x0
    for st, font, k, glyphs, adv in shaped:
        pen = SVGPathPen(None, ntos=num)
        for gid, gx, gy in glyphs:
            font.draw_glyph_with_pen(gid, TransformPen(pen, (k, 0, 0, -k, cursor + gx, y0 - gy)))
        d = pen.getCommands()
        if d:
            parts.append(f'<path fill="{st["fill"]}" d="{d}"/>')
        cursor += adv
    extra = "".join(f' {a}="{el.get(a)}"' for a in ("opacity", "fill-opacity") if el.get(a))
    return f"<g{extra}>{''.join(parts)}</g>" if extra else "".join(parts)


src = SRC.read_text(encoding="utf-8")
count = 0


def repl(m):
    global count
    count += 1
    return outline(ET.fromstring(m.group(0)))


out = re.sub(r"<text\b[^>]*>.*?</text>", repl, src, flags=re.S)
out = re.sub(r"\s*<!--\s*fonts:.*?-->", "", out, flags=re.S)
OUT.write_text(out, encoding="utf-8", newline="\n")
print(f"{OUT.name}: {count} text runs outlined, {len(out.encode())} bytes")
