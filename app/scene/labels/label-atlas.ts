// Layout math for the label atlas. Pure (no DOM, no `three`) so the worker
// rasterizer and the unit tests share it.

import type { LabelStyle } from './label-styles';

/** Widest atlas row, in device pixels, before the packer starts a new shelf. */
export const LABEL_ATLAS_MAX_WIDTH = 2048;
/** Tallest atlas the packer may produce; more labels than this is a caller bug. */
export const LABEL_ATLAS_MAX_HEIGHT = 8192;
/** Transparent gutter between entries so linear/mipmap filtering never bleeds. */
export const LABEL_ATLAS_GUTTER_PX = 2;
/** Floats per entry in {@link LabelAtlasResult.entries}: u0, vTop, u1, vBottom, cssWidth, cssHeight. */
export const LABEL_ATLAS_ENTRY_STRIDE = 6;

export interface LabelAtlasRequestEntry {
  text: string;
  style: LabelStyle;
}

export interface LabelAtlasResult {
  /** Premultiplied RGBA8, row 0 at the top. */
  pixels: Uint8Array;
  width: number;
  height: number;
  /** {@link LABEL_ATLAS_ENTRY_STRIDE} floats per request entry, in request order. */
  entries: Float32Array;
}

/**
 * CSS-pixel geometry of one label: the chip (or bare text line) plus a margin
 * wide enough for the text-shadow glow. The whole entry is centered on the
 * label's anchor.
 */
export interface LabelBoxMetrics {
  /** Glow margin on every side, CSS px. */
  marginPx: number;
  /** Chip box (padding + border + text line), CSS px. */
  boxWidthPx: number;
  boxHeightPx: number;
  /** Full entry including the glow margin, CSS px. */
  widthPx: number;
  heightPx: number;
  /** Text origin inside the box (left edge, alphabetic baseline), CSS px. */
  textXPx: number;
  textBaselineYPx: number;
}

/** Horizontal advance and font-wide vertical extent of a line of text, CSS px. */
export interface LabelTextMetrics {
  widthPx: number;
  /** `fontBoundingBoxAscent` / `fontBoundingBoxDescent`. */
  ascentPx: number;
  descentPx: number;
}

/**
 * Lay a label out the way CSS lays out a single-line inline box: `normal`
 * line height is the font's ascent plus descent, and the glyphs sit centered
 * in the line box (half-leading above and below), so the text lands where a
 * centered HTML element with the same style would put it.
 */
export function labelBoxMetrics(style: LabelStyle, text: LabelTextMetrics): LabelBoxMetrics {
  const fontHeightPx = text.ascentPx + text.descentPx;
  const lineHeightPx =
    style.lineHeight === undefined ? fontHeightPx : style.fontSizePx * style.lineHeight;
  const padX = style.box ? style.box.paddingXPx + style.box.borderPx : 0;
  const padY = style.box ? style.box.paddingYPx + style.box.borderPx : 0;
  const textWidthPx = text.widthPx;
  const boxWidthPx = textWidthPx + padX * 2;
  const boxHeightPx = lineHeightPx + padY * 2;
  const maxBlur = Math.max(0, ...(style.textShadows ?? []).map((shadow) => shadow.blurPx));
  // One extra pixel keeps antialiased chip edges off the entry boundary.
  const marginPx = Math.ceil(maxBlur) + 1;
  return {
    marginPx,
    boxWidthPx,
    boxHeightPx,
    widthPx: boxWidthPx + marginPx * 2,
    heightPx: boxHeightPx + marginPx * 2,
    textXPx: padX,
    textBaselineYPx: padY + (lineHeightPx - fontHeightPx) / 2 + text.ascentPx
  };
}

export interface PackedRect {
  x: number;
  y: number;
}

export interface ShelfPacking {
  rects: PackedRect[];
  width: number;
  height: number;
}

/**
 * Shelf-pack rectangles (device px) left to right, starting a new shelf when
 * a row would exceed `maxWidth`. Entries keep request order so shelves stay
 * deterministic; labels in one set are close in height, so sorting would buy
 * little. Throws when the result would exceed {@link LABEL_ATLAS_MAX_HEIGHT}.
 */
export function packShelves(
  sizes: ReadonlyArray<{ width: number; height: number }>,
  maxWidth = LABEL_ATLAS_MAX_WIDTH,
  gutter = LABEL_ATLAS_GUTTER_PX
): ShelfPacking {
  const rowLimit = Math.max(maxWidth, ...sizes.map((size) => size.width + gutter * 2));
  const rects: PackedRect[] = [];
  let cursorX = gutter;
  let cursorY = gutter;
  let shelfHeight = 0;
  let usedWidth = 0;
  for (const size of sizes) {
    if (!(size.width > 0) || !(size.height > 0)) {
      throw new Error(`Label atlas entry needs a positive size, got ${size.width}x${size.height}.`);
    }
    if (cursorX + size.width + gutter > rowLimit && cursorX > gutter) {
      cursorX = gutter;
      cursorY += shelfHeight + gutter;
      shelfHeight = 0;
    }
    rects.push({ x: cursorX, y: cursorY });
    cursorX += size.width + gutter;
    usedWidth = Math.max(usedWidth, cursorX);
    shelfHeight = Math.max(shelfHeight, size.height);
  }
  const height = rects.length === 0 ? 1 : cursorY + shelfHeight + gutter;
  if (height > LABEL_ATLAS_MAX_HEIGHT) {
    throw new Error(
      `Label atlas for ${sizes.length} labels needs ${height}px, over the ${LABEL_ATLAS_MAX_HEIGHT}px limit.`
    );
  }
  return { rects, width: Math.max(1, usedWidth), height };
}

/** Premultiply straight-alpha RGBA8 in place. */
export function premultiplyRgba(pixels: Uint8Array | Uint8ClampedArray): void {
  for (let i = 0; i < pixels.length; i += 4) {
    const alpha = pixels[i + 3];
    if (alpha === 255) continue;
    pixels[i] = Math.round((pixels[i] * alpha) / 255);
    pixels[i + 1] = Math.round((pixels[i + 1] * alpha) / 255);
    pixels[i + 2] = Math.round((pixels[i + 2] * alpha) / 255);
  }
}
