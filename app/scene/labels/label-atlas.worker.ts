import * as Comlink from 'comlink';
import {
  LABEL_ATLAS_ENTRY_STRIDE,
  labelBoxMetrics,
  packShelves,
  premultiplyRgba,
  type LabelAtlasRequestEntry,
  type LabelAtlasResult
} from './label-atlas';
import type { LabelStyle } from './label-styles';

/** Draws a glyph run far off-canvas so only its offset shadow lands in view. */
const SHADOW_ONLY_OFFSET_PX = 100_000;

function fontString(style: LabelStyle): string {
  return `${style.fontWeight} ${style.fontSizePx}px ${style.fontFamily}`;
}

type Context2D = OffscreenCanvasRenderingContext2D;

function applyTextStyle(context: Context2D, style: LabelStyle) {
  context.font = fontString(style);
  // `letterSpacing` is not in every engine's canvas yet; without it the text
  // is only marginally narrower than the CSS original.
  if ('letterSpacing' in context) {
    context.letterSpacing = style.letterSpacing ?? '0px';
  }
  context.textBaseline = 'alphabetic';
  context.textAlign = 'left';
}

function traceRoundRect(
  context: Context2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number
) {
  const r = Math.max(0, Math.min(radius, width / 2, height / 2));
  context.beginPath();
  context.moveTo(x + r, y);
  context.arcTo(x + width, y, x + width, y + height, r);
  context.arcTo(x + width, y + height, x, y + height, r);
  context.arcTo(x, y + height, x, y, r);
  context.arcTo(x, y, x + width, y, r);
  context.closePath();
}

export class LabelAtlasWorkerApi {
  /**
   * Rasterize labels into one premultiplied RGBA atlas at `pixelRatio`
   * device pixels per CSS pixel. Entry order matches the request.
   */
  rasterize(entries: LabelAtlasRequestEntry[], pixelRatio: number): LabelAtlasResult {
    if (!(pixelRatio > 0)) {
      throw new Error(`Label atlas needs a positive pixel ratio, got ${pixelRatio}.`);
    }
    const measureCanvas = new OffscreenCanvas(1, 1);
    const measure = measureCanvas.getContext('2d');
    if (!measure) throw new Error('OffscreenCanvas 2D context is unavailable in the label worker.');

    const metrics = entries.map((entry) => {
      applyTextStyle(measure, entry.style);
      const measured = measure.measureText(entry.text);
      return labelBoxMetrics(entry.style, {
        widthPx: measured.width,
        ascentPx: measured.fontBoundingBoxAscent,
        descentPx: measured.fontBoundingBoxDescent
      });
    });
    const sizes = metrics.map((m) => ({
      width: Math.ceil(m.widthPx * pixelRatio),
      height: Math.ceil(m.heightPx * pixelRatio)
    }));
    const packing = packShelves(sizes);

    const canvas = new OffscreenCanvas(packing.width, packing.height);
    const context = canvas.getContext('2d');
    if (!context) throw new Error('OffscreenCanvas 2D context is unavailable in the label worker.');

    const out = new Float32Array(entries.length * LABEL_ATLAS_ENTRY_STRIDE);
    entries.forEach((entry, index) => {
      const { style, text } = entry;
      const m = metrics[index];
      const rect = packing.rects[index];
      const size = sizes[index];

      context.save();
      context.beginPath();
      context.rect(rect.x, rect.y, size.width, size.height);
      context.clip();
      context.translate(rect.x, rect.y);
      context.scale(pixelRatio, pixelRatio);
      context.translate(m.marginPx, m.marginPx);

      if (style.box) {
        const { borderPx, borderColor, background, radiusPx } = style.box;
        traceRoundRect(context, 0, 0, m.boxWidthPx, m.boxHeightPx, radiusPx);
        context.fillStyle = background;
        context.fill();
        if (borderPx > 0) {
          traceRoundRect(
            context,
            borderPx / 2,
            borderPx / 2,
            m.boxWidthPx - borderPx,
            m.boxHeightPx - borderPx,
            Math.max(0, radiusPx - borderPx / 2)
          );
          context.lineWidth = borderPx;
          context.strokeStyle = borderColor;
          context.stroke();
        }
      }

      applyTextStyle(context, style);
      // CSS paints every text-shadow beneath the glyphs; canvas shadows
      // accompany a fill, so draw each glow from an off-canvas copy and
      // paint the glyphs once on top. Shadow blur and offset are in device
      // pixels, untouched by the context transform.
      for (const shadow of style.textShadows ?? []) {
        context.shadowColor = shadow.color;
        context.shadowBlur = shadow.blurPx * pixelRatio;
        context.shadowOffsetX = SHADOW_ONLY_OFFSET_PX * pixelRatio;
        context.shadowOffsetY = 0;
        context.fillStyle = shadow.color;
        context.fillText(text, m.textXPx - SHADOW_ONLY_OFFSET_PX, m.textBaselineYPx);
      }
      context.shadowColor = 'transparent';
      context.shadowBlur = 0;
      context.shadowOffsetX = 0;
      context.fillStyle = style.color;
      context.fillText(text, m.textXPx, m.textBaselineYPx);
      context.restore();

      const base = index * LABEL_ATLAS_ENTRY_STRIDE;
      out[base] = rect.x / packing.width;
      out[base + 1] = rect.y / packing.height;
      out[base + 2] = (rect.x + size.width) / packing.width;
      out[base + 3] = (rect.y + size.height) / packing.height;
      // Report the size the rounded device rect actually covers, so the quad
      // maps texels 1:1 at this pixel ratio.
      out[base + 4] = size.width / pixelRatio;
      out[base + 5] = size.height / pixelRatio;
    });

    const imageData = context.getImageData(0, 0, packing.width, packing.height);
    const pixels = new Uint8Array(
      imageData.data.buffer,
      imageData.data.byteOffset,
      imageData.data.byteLength
    );
    premultiplyRgba(pixels);
    return Comlink.transfer(
      { pixels, width: packing.width, height: packing.height, entries: out },
      // SAFETY: getImageData and the Float32Array constructor both allocate fresh ArrayBuffers.
      [pixels.buffer as ArrayBuffer, out.buffer as ArrayBuffer]
    );
  }
}

Comlink.expose(new LabelAtlasWorkerApi());
