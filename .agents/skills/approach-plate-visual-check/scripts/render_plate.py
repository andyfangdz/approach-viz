#!/usr/bin/env python3
"""Render an FAA plate PDF page to PNG (full page or a clipped region).

Self-contained via PyMuPDF (no system poppler needed).

Usage:
  render_plate.py <pdf> <out.png> [--zoom N] [--clip x0 y0 x1 y1] [--page N]

The clip box is in PDF points (origin top-left). US approach plates are ~387 x
594 pt; the plan view is typically the upper-middle band, e.g. "40 95 320 300".
"""
import argparse


def main() -> int:
    import fitz  # PyMuPDF

    ap = argparse.ArgumentParser()
    ap.add_argument("pdf")
    ap.add_argument("out")
    ap.add_argument("--zoom", type=float, default=4.0)
    ap.add_argument("--page", type=int, default=0)
    ap.add_argument("--clip", type=float, nargs=4, metavar=("X0", "Y0", "X1", "Y1"))
    args = ap.parse_args()

    doc = fitz.open(args.pdf)
    page = doc[args.page]
    matrix = fitz.Matrix(args.zoom, args.zoom)
    clip = fitz.Rect(*args.clip) if args.clip else None
    pix = page.get_pixmap(matrix=matrix, clip=clip)
    pix.save(args.out)
    print(f"{args.out} ({pix.width}x{pix.height}); page rect {page.rect}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
