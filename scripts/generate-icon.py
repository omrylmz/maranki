#!/usr/bin/env python3
"""Generate the Maranki app-icon asset set (direction: "pine stamp").

The mark is the official Maranki app mark (see design/assets/maranki-appmark.svg):
a pine tile + Newsreader-SemiBold serif "M" + an amber/honey "spark" (the same
spark that dots the "i" in the wordmark). The "M" is rendered from the real
Newsreader glyph *outline* (via fontTools) so the result is font-independent and
pixel-faithful — no system font install required.

Requires:
  - Python:  pip install fonttools          (glyph -> path extraction)
  - System:  rsvg-convert  (librsvg)        SVG -> PNG rasterization
             macOS:  brew install librsvg
  - The Newsreader font shipped in node_modules (@expo-google-fonts/newsreader).

Writes 8 PNGs into assets/images/. After running, regenerate the native
projects so iOS/Android pick up the new icons:
  npx expo prebuild --clean        (or -p ios / -p android)

Usage:  python3 scripts/generate-icon.py
"""
import os
import subprocess
import tempfile
from fontTools.ttLib import TTFont
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.boundsPen import BoundsPen

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
IMG = os.path.join(REPO, "assets", "images")
FONT = os.path.join(REPO, "node_modules", "@expo-google-fonts", "newsreader",
                    "600SemiBold", "Newsreader_600SemiBold.ttf")

# --- Brand palette (design/colors_and_type.css) ------------------------------
PINE, PINE_DEEP, PINE_BRIGHT = "#136F63", "#0E574E", "#1C8A7B"
PINE_DK_BR = "#46BEAA"            # pine on dark surfaces
OFFWHITE, AMBER, HONEY = "#FBF8F2", "#DD8A2B", "#F2B741"
INK, INK_SUNK = "#1C1916", "#120F0D"

# --- Composition constants ---------------------------------------------------
CAP = 0.455                       # M cap-height as fraction of canvas (full-bleed)
SPARK = dict(x=0.760, y=0.277, r=0.066)
SAFE_K = 0.80                     # mark scale inside the Android adaptive safe zone

# --- Extract the "M" glyph outline -------------------------------------------
_f = TTFont(FONT)
_gs = _f.getGlyphSet()
_cmap = _f.getBestCmap()
_pen = SVGPathPen(_gs)
_gs[_cmap[ord("M")]].draw(_pen)
M_PATH = _pen.getCommands()
_bpen = BoundsPen(_gs)
_gs[_cmap[ord("M")]].draw(_bpen)
MX0, MY0, MX1, MY1 = _bpen.bounds


def _m_tf(S, cx, cy, cap_frac):
    """Transform placing the glyph bbox centered at (cx,cy), bbox-height=cap_frac*S."""
    s = (cap_frac * S) / (MY1 - MY0)
    tx = cx - s * (MX0 + MX1) / 2.0
    ty = cy + s * (MY0 + MY1) / 2.0
    return f"translate({tx:.3f},{ty:.3f}) scale({s:.5f},{-s:.5f})"


def _mark(S, m_fill, glow=True, spark_two_tone=True, shadow=True):
    """The logo content (M + spark), centered full-bleed."""
    cx, cy, r = SPARK["x"] * S, SPARK["y"] * S, SPARK["r"] * S
    out = []
    if shadow:
        out.append(f'<path d="{M_PATH}" transform="{_m_tf(S, S/2, S/2 + S*0.006, CAP)}" '
                   f'fill="#000" opacity="0.13" filter="url(#mshadow)"/>')
    out.append(f'<path d="{M_PATH}" transform="{_m_tf(S, S/2, S/2, CAP)}" fill="{m_fill}"/>')
    if glow:
        out.append(f'<circle cx="{cx}" cy="{cy}" r="{r*1.8:.2f}" fill="{AMBER}" '
                   f'opacity="0.13" filter="url(#softglow)"/>')
    if spark_two_tone:
        out.append(f'<circle cx="{cx}" cy="{cy}" r="{r:.2f}" fill="{AMBER}"/>')
        out.append(f'<circle cx="{cx}" cy="{cy}" r="{r*0.40:.2f}" fill="{HONEY}"/>')
    else:
        out.append(f'<circle cx="{cx}" cy="{cy}" r="{r:.2f}" fill="{m_fill}"/>')
    return "\n  ".join(out)


def _filters(S):
    return (f'<filter id="softglow" x="-80%" y="-80%" width="260%" height="260%">'
            f'<feGaussianBlur stdDeviation="{S*0.013:.2f}"/></filter>'
            f'<filter id="mshadow" x="-20%" y="-20%" width="140%" height="140%">'
            f'<feGaussianBlur stdDeviation="{S*0.006:.2f}"/></filter>')


def _pine_bg(S, rad):
    defs = (f'<linearGradient id="bg" x1="0" y1="0" x2="0.25" y2="1">'
            f'<stop offset="0" stop-color="{PINE_BRIGHT}"/>'
            f'<stop offset="0.55" stop-color="{PINE}"/>'
            f'<stop offset="1" stop-color="{PINE_DEEP}"/></linearGradient>'
            f'<radialGradient id="sheen" cx="0.5" cy="0" r="0.9">'
            f'<stop offset="0" stop-color="#FFF" stop-opacity="0.10"/>'
            f'<stop offset="0.6" stop-color="#FFF" stop-opacity="0"/></radialGradient>')
    body = (f'<rect width="{S}" height="{S}" rx="{rad}" fill="url(#bg)"/>'
            f'<rect width="{S}" height="{S}" rx="{rad}" fill="url(#sheen)"/>')
    return defs, body


def _svg(S, defs, body):
    return (f'<svg xmlns="http://www.w3.org/2000/svg" width="{S}" height="{S}" '
            f'viewBox="0 0 {S} {S}"><defs>{_filters(S)}{defs}</defs>{body}</svg>')


def _safe(S, frag):
    return (f'<g transform="translate({S/2},{S/2}) scale({SAFE_K}) '
            f'translate({-S/2},{-S/2})">{frag}</g>')


def _write(tmp, name, S, defs, body, out_w=None):
    svg_path = os.path.join(tmp, name + ".svg")
    with open(svg_path, "w") as fh:
        fh.write(_svg(S, defs, body))
    w = out_w or S
    out = os.path.join(IMG, name + ".png")
    subprocess.run(["rsvg-convert", "-w", str(w), "-h", str(w), "-o", out, svg_path], check=True)
    print("  wrote", os.path.relpath(out, REPO))


def main():
    with tempfile.TemporaryDirectory() as tmp:
        # iOS light + Android legacy + web fallback (full-bleed pine)
        d, b = _pine_bg(1024, 0)
        _write(tmp, "icon", 1024, d, b + _mark(1024, OFFWHITE))

        # iOS dark appearance (deep ink, pine-bright M)
        ddefs = (f'<linearGradient id="bg" x1="0" y1="0" x2="0.2" y2="1">'
                 f'<stop offset="0" stop-color="{INK}"/>'
                 f'<stop offset="1" stop-color="{INK_SUNK}"/></linearGradient>'
                 f'<radialGradient id="sheen" cx="0.5" cy="0.18" r="0.85">'
                 f'<stop offset="0" stop-color="{PINE_DK_BR}" stop-opacity="0.16"/>'
                 f'<stop offset="0.7" stop-color="{PINE_DK_BR}" stop-opacity="0"/></radialGradient>')
        dbg = ('<rect width="1024" height="1024" fill="url(#bg)"/>'
               '<rect width="1024" height="1024" fill="url(#sheen)"/>')
        _write(tmp, "icon-dark", 1024, ddefs, dbg + _mark(1024, PINE_DK_BR))

        # iOS tinted (grayscale luminance on transparent)
        _write(tmp, "icon-tinted", 1024, "",
               _mark(1024, "#EDEAE2", glow=False, spark_two_tone=False, shadow=False))

        # Android adaptive foreground (transparent, mark in safe zone)
        _write(tmp, "android-icon-foreground", 1024, "",
               _safe(1024, _mark(1024, OFFWHITE, glow=True, shadow=False)))

        # Android adaptive background (pine gradient, full-bleed)
        d, b = _pine_bg(1024, 0)
        _write(tmp, "android-icon-background", 1024, d, b)

        # Android 13+ themed icon (white silhouette, safe zone, transparent)
        _write(tmp, "android-icon-monochrome", 1024, "",
               _safe(1024, _mark(1024, "#FFFFFF", glow=False, spark_two_tone=False, shadow=False)))

        # Splash + favicon: rounded "appmark" tile (shown small on paper)
        rad = 1024 * 0.2237
        d, b = _pine_bg(1024, rad)
        edge = (f'<rect x="0.75" y="0.75" width="1022.5" height="1022.5" rx="{rad-0.75}" '
                f'fill="none" stroke="{PINE_DEEP}" stroke-opacity="0.55" stroke-width="1.5"/>')
        appmark = b + edge + _mark(1024, OFFWHITE)
        _write(tmp, "splash-icon", 1024, d, appmark)
        _write(tmp, "favicon", 1024, d, appmark, out_w=96)

    print("Done. Run `npx expo prebuild --clean` to refresh native icons.")


if __name__ == "__main__":
    main()
