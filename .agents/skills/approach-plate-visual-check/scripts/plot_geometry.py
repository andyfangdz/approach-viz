#!/usr/bin/env python3
"""Plot approach-viz computed geometry top-down for comparison with a plate.

Consumes a simple "segments file" produced by a diagnostic dump of the shared
geometry engine (see SKILL.md). Coordinates are the engine's local scene NM
(`coords::lat_lon_to_local`): x = east, z = -north. This plots north-up
(north = -z) so the orientation matches the (north-up) FAA plan view.

Segments-file format (whitespace-separated):
  FIX <name> <x> <z>
  SEG  <label> <x0>,<z0> <x1>,<z1> ...
Lines beginning with '#' are ignored.

Usage:
  plot_geometry.py <segments.txt> <out.png> [--plate plan.png]
                   [--xlim A B] [--ylim A B] [--title T]

With --plate, renders the plate plan view and the computed geometry side by
side (the plate plan view is schematic / not to scale, so compare topology, not
pixels). Without --plate, renders the geometry alone.
"""
import argparse


# Stable colors keyed by the segment label's prefix before ':' (for example
# "transition:FLACK" -> transition); unknown kinds cycle a palette that avoids
# the known colors so they can never collide with e.g. the missed-approach red.
KNOWN_COLORS = {
    "final": "#0a0",
    "localizer": "#0a0",
    "transition": "goldenrod",
    "missed": "#d22",
    "hold": "#22d",
}
PALETTE = ["purple", "teal", "magenta", "#7a5230", "#446644"]


def load_segments(path):
    fixes, segments = {}, []
    with open(path) as handle:
        for raw in handle:
            line = raw.strip()
            if not line or line.startswith("#"):
                continue
            tok = line.split()
            if tok[0] == "FIX" and len(tok) >= 4:
                fixes[tok[1].split("_")[-1]] = (float(tok[2]), float(tok[3]))
            elif tok[0] == "SEG" and len(tok) >= 3:
                pts = [tuple(map(float, p.split(","))) for p in tok[2:]]
                segments.append((tok[1], pts))
    return fixes, segments


def draw(ax, fixes, segments, title):
    for i, (label, pts) in enumerate(segments):
        xs = [p[0] for p in pts]
        ns = [-p[1] for p in pts]  # north = -z
        color = KNOWN_COLORS.get(label.lower().split(":", 1)[0], PALETTE[i % len(PALETTE)])
        ax.plot(xs, ns, color=color, lw=2.2, label=label)
    for name, (x, z) in fixes.items():
        ax.scatter([x], [-z], color="black", s=18, zorder=5)
        ax.annotate(name, (x, -z), fontsize=8, fontweight="bold",
                    xytext=(3, 3), textcoords="offset points")
    ax.set_aspect("equal")
    ax.grid(alpha=0.3)
    ax.set_xlabel("east (NM)")
    ax.set_ylabel("north (NM)")
    if segments or fixes:
        ax.legend(loc="lower left", fontsize=8)
    ax.set_title(title)


def main() -> int:
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    ap = argparse.ArgumentParser()
    ap.add_argument("segments")
    ap.add_argument("out")
    ap.add_argument("--plate")
    ap.add_argument("--xlim", type=float, nargs=2)
    ap.add_argument("--ylim", type=float, nargs=2)
    ap.add_argument("--title", default="approach-viz computed geometry (top-down)")
    args = ap.parse_args()

    fixes, segments = load_segments(args.segments)

    if args.plate:
        from PIL import Image
        fig, (axp, axm) = plt.subplots(1, 2, figsize=(15, 8))
        axp.imshow(Image.open(args.plate))
        axp.axis("off")
        axp.set_title("FAA plate (plan view; schematic, not to scale)")
        target = axm
    else:
        fig, target = plt.subplots(figsize=(8, 10))

    draw(target, fixes, segments, args.title)
    if args.xlim:
        target.set_xlim(*args.xlim)
    if args.ylim:
        target.set_ylim(*args.ylim)
    fig.tight_layout()
    fig.savefig(args.out, dpi=95)
    print(args.out)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
