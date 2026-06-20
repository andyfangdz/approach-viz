#!/usr/bin/env python3
"""Overlay approach-viz computed geometry on the *georeferenced* FAA plate.

Unlike `plot_geometry.py` (which draws the geometry beside the schematic plan
view), this script plots the computed path directly *on top of* the rendered
plate, georeferenced with the plate's embedded GPTS/LPTS viewport control points
(the same data the app's `ApproachPlateSurface` uses). That makes it possible to
see whether the computed arc/turn lies on the chart's drawn arc and where it
diverges.

Caveat: the control points define a 4-corner bilinear map, so the alignment has
a little slack (order ~1-2 NM over a full US plate) and FAA plan views carry some
schematic distortion. Use it to judge shape and placement of a turn against the
chart's line, not for sub-NM pixel matching.

Inputs:
  <plate.pdf>      The downloaded d-TPP plate (from fetch_plate.sh).
  <segments.txt>   A segments file from the geometry dump (see plot_geometry.py /
                   templates/dump_geometry.rs.txt). Coordinates are local scene
                   NM (x = east, z = -north) relative to --ref-lat/--ref-lon.

Usage:
  overlay_geometry.py <plate.pdf> <segments.txt> --ref-lat 37.7631 --ref-lon -99.9654 \
      [--out /tmp/overlay.png] [--zoom-fix WEROM] [--pad 230] [--zoom 5]
"""
import argparse
import importlib
import math
import re
import subprocess
import sys


def _ensure(module, package=None):
    try:
        return importlib.import_module(module)
    except ImportError:
        subprocess.run(
            [sys.executable, "-m", "pip", "install", "--quiet", package or module],
            check=True,
        )
        return importlib.import_module(module)


np = _ensure("numpy")


def load_georef(pdf_path):
    """Extract MediaBox + the georeferenced viewport (BBox/GPTS/LPTS) from the PDF."""
    data = open(pdf_path, "rb").read().decode("latin1")
    start = data.find("/VP[")
    if start < 0:
        raise SystemExit("No /VP georeference viewport found in the plate PDF.")
    sl = data[start : start + 24000]

    def arr(tag, text):
        m = re.search(r"/" + tag + r"\s*\[([^\]]+)\]", text)
        if not m:
            raise SystemExit(f"Missing /{tag} in plate georeference.")
        return [float(x) for x in re.findall(r"-?\d+(?:\.\d+)?", m.group(1))]

    media = arr("MediaBox", data)
    bbox = arr("BBox", sl)
    gpts = arr("GPTS", sl)
    lpts = arr("LPTS", sl)
    points = [(lpts[2 * k], lpts[2 * k + 1], gpts[2 * k], gpts[2 * k + 1]) for k in range(4)]
    return media, bbox, points


def fit_bilinear(points):
    """Fit lat=f(u,v) and lon=g(u,v) bilinear models over the 4 control points."""
    matrix = np.array([[1, u, v, u * v] for (u, v, _, _) in points])
    lat = np.linalg.solve(matrix, np.array([la for (_, _, la, _) in points]))
    lon = np.linalg.solve(matrix, np.array([lo for (_, _, _, lo) in points]))
    return lat, lon


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("pdf")
    ap.add_argument("segments")
    ap.add_argument("--ref-lat", type=float, required=True)
    ap.add_argument("--ref-lon", type=float, required=True)
    ap.add_argument("--out", default="/tmp/overlay.png")
    ap.add_argument("--zoom", type=float, default=5.0, help="PDF render scale.")
    ap.add_argument("--zoom-fix", default=None, help="Center the view on this FIX name.")
    ap.add_argument("--pad", type=float, default=230.0, help="Half-window (px) around --zoom-fix.")
    args = ap.parse_args()

    fitz = _ensure("fitz", "pymupdf")
    Image = _ensure("PIL.Image", "pillow")
    matplotlib = _ensure("matplotlib")

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    media, bbox, control_points = load_georef(args.pdf)
    lat_c, lon_c = fit_bilinear(control_points)

    def latlon_of(u, v):
        b = np.array([1, u, v, u * v])
        return b @ lat_c, b @ lon_c

    def uv_of(lat, lon):
        # Invert the near-linear bilinear map with a few Newton steps.
        u, v = 0.5, 0.5
        for _ in range(50):
            la, lo = latlon_of(u, v)
            jac = np.array(
                [
                    [lat_c[1] + lat_c[3] * v, lat_c[2] + lat_c[3] * u],
                    [lon_c[1] + lon_c[3] * v, lon_c[2] + lon_c[3] * u],
                ]
            )
            du = np.linalg.solve(jac, np.array([lat - la, lon - lo]))
            u += du[0]
            v += du[1]
        return u, v

    doc = fitz.open(args.pdf)
    page = doc[0]
    pix = page.get_pixmap(matrix=fitz.Matrix(args.zoom, args.zoom))
    img = Image.frombytes("RGB", [pix.width, pix.height], pix.samples)

    def pixel_of(lat, lon):
        u, v = uv_of(lat, lon)
        px = bbox[0] + u * (bbox[2] - bbox[0])
        py = bbox[1] + v * (bbox[3] - bbox[1])
        return px * args.zoom, (media[3] - py) * args.zoom  # flip y for image space

    cos_ref = math.cos(math.radians(args.ref_lat))

    def latlon_from_local(x, z):
        return args.ref_lat + (-z) / 60.0, args.ref_lon + x / (60.0 * cos_ref)

    fixes, segments = {}, []
    for raw in open(args.segments):
        tok = raw.split()
        if not tok:
            continue
        if tok[0] == "FIX" and len(tok) >= 4:
            fixes[tok[1]] = (float(tok[2]), float(tok[3]))
        elif tok[0] == "SEG" and len(tok) >= 3:
            segments.append((tok[1], [tuple(map(float, p.split(","))) for p in tok[2:]]))

    known = {"final": "#10b010", "localizer": "#10b010", "transition": "#f0a000", "missed": "#d02020", "hold": "#2020e0"}
    palette = ["#f0a000", "#d02020", "#2020e0", "purple", "teal", "magenta"]

    fig, ax = plt.subplots(figsize=(12, 12))
    ax.imshow(img)
    for i, (label, pts) in enumerate(segments):
        xs, ys = [], []
        for (x, z) in pts:
            ix, iy = pixel_of(*latlon_from_local(x, z))
            xs.append(ix)
            ys.append(iy)
        ax.plot(xs, ys, color=known.get(label.lower(), palette[i % len(palette)]), lw=2.6, label=label, alpha=0.9)
    for name, (x, z) in fixes.items():
        ix, iy = pixel_of(*latlon_from_local(x, z))
        ax.scatter([ix], [iy], c="cyan", s=28, zorder=5, edgecolors="black")
        ax.annotate(name, (ix, iy), color="blue", fontsize=9, fontweight="bold")

    if args.zoom_fix and args.zoom_fix in fixes:
        cx, cy = pixel_of(*latlon_from_local(*fixes[args.zoom_fix]))
        ax.set_xlim(cx - args.pad, cx + args.pad)
        ax.set_ylim(cy + args.pad, cy - args.pad)
    ax.legend(loc="upper right")
    ax.set_title("approach-viz geometry overlaid on georeferenced FAA plate")
    plt.savefig(args.out, dpi=140, bbox_inches="tight")
    print(args.out)


if __name__ == "__main__":
    main()
