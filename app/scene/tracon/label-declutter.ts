// Screen-space declutter for video map text. Kept free of `three` and the
// DOM for unit tests.

/** A screen rectangle in CSS px: left, top, right, bottom. */
export type ScreenBox = readonly [number, number, number, number];

/** Grid cell for the overlap index; about the size of a typical label. */
const CELL_PX = 48;

/** Uniform-grid index of screen boxes for overlap queries. */
class BoxGrid {
  private readonly cells = new Map<number, ScreenBox[]>();

  insert(box: ScreenBox) {
    this.forEachCell(box, (key) => {
      const list = this.cells.get(key);
      if (list) list.push(box);
      else this.cells.set(key, [box]);
    });
  }

  /** Total overlap area of `box` with indexed boxes other than `except`. */
  overlapArea(box: ScreenBox, except: ScreenBox | null = null): number {
    const seen = new Set<ScreenBox>();
    let total = 0;
    this.forEachCell(box, (key) => {
      for (const other of this.cells.get(key) ?? []) {
        if (other === except || seen.has(other)) continue;
        seen.add(other);
        total += overlapArea(box, other);
      }
    });
    return total;
  }

  private forEachCell(box: ScreenBox, visit: (key: number) => void) {
    const x0 = Math.floor(box[0] / CELL_PX);
    const y0 = Math.floor(box[1] / CELL_PX);
    const x1 = Math.floor(box[2] / CELL_PX);
    const y1 = Math.floor(box[3] / CELL_PX);
    for (let cx = x0; cx <= x1; cx += 1) {
      for (let cy = y0; cy <= y1; cy += 1) visit(cx * 100_003 + cy);
    }
  }
}

function overlapArea(a: ScreenBox, b: ScreenBox): number {
  const w = Math.min(a[2], b[2]) - Math.max(a[0], b[0]);
  const h = Math.min(a[3], b[3]) - Math.max(a[1], b[1]);
  return w > 0 && h > 0 ? w * h : 0;
}

/**
 * Greedy placement in priority order: each box is kept unless it overlaps a
 * reserved box or a box kept before it. `reserved` boxes (map symbols) are
 * always present and never culled. Returns one flag per box. A `null` box
 * (off screen) is never kept.
 */
export function declutterBoxes(
  boxes: readonly (ScreenBox | null)[],
  reserved: readonly ScreenBox[] = []
): boolean[] {
  const grid = new BoxGrid();
  for (const box of reserved) grid.insert(box);
  return boxes.map((box) => {
    if (!box || grid.overlapArea(box) > 0) return false;
    grid.insert(box);
    return true;
  });
}

/** Map text metrics: 10 px monospace at about 0.6 em per character. */
export const MAP_LABEL_CHAR_WIDTH_PX = 6.1;
export const MAP_LABEL_HEIGHT_PX = 11;
/** Clear space kept around each label. */
export const MAP_LABEL_MARGIN_PX = 2;

/** Box of a label drawn `offsetX` px right of its anchor, left-aligned. */
export function symbolLabelBox(x: number, y: number, text: string, offsetX: number): ScreenBox {
  const width = text.length * MAP_LABEL_CHAR_WIDTH_PX;
  const half = MAP_LABEL_HEIGHT_PX / 2;
  const m = MAP_LABEL_MARGIN_PX;
  // No margin on the left: the label's own symbol sits just there.
  return [x + offsetX, y - half - m, x + offsetX + width + m, y + half + m];
}

/** Box of a label centered on its anchor. */
export function centeredLabelBox(x: number, y: number, text: string): ScreenBox {
  const halfWidth = (text.length * MAP_LABEL_CHAR_WIDTH_PX) / 2;
  const half = MAP_LABEL_HEIGHT_PX / 2;
  const m = MAP_LABEL_MARGIN_PX;
  return [x - halfWidth - m, y - half - m, x + halfWidth + m, y + half + m];
}

/** Box of a symbol glyph of `sizePx` centered on its anchor. */
export function symbolBox(x: number, y: number, sizePx: number): ScreenBox {
  const half = sizePx / 2;
  return [x - half, y - half, x + half, y + half];
}

/**
 * STARS leader directions (keypad digits around the target), in the order
 * tried: the default up-right first, then the rest of the right side, then
 * the left. Leader endpoints are CSS px from the target (x right, y up).
 */
export const LEADER_DIRECTIONS = [
  { keypad: 9, fromPx: [7, 7], toPx: [19, 19] },
  { keypad: 3, fromPx: [7, -7], toPx: [19, -19] },
  { keypad: 6, fromPx: [8, 0], toPx: [24, 0] },
  { keypad: 7, fromPx: [-7, 7], toPx: [-19, 19] },
  { keypad: 1, fromPx: [-7, -7], toPx: [-19, -19] },
  { keypad: 4, fromPx: [-8, 0], toPx: [-24, 0] }
] as const;

/** Data block text: 12 px monospace. */
export const DATA_BLOCK_CHAR_WIDTH_PX = 7.3;
export const DATA_BLOCK_LINE_HEIGHT_PX = 13;
/** Gap between the leader's end and the text. */
export const DATA_BLOCK_TEXT_GAP_PX = 3;
/** Line centers relative to the leader's end, for one- and two-line blocks. */
export const DATA_BLOCK_LINE_OFFSETS_PX = { single: [0], double: [6, -7] } as const;
const TARGET_SYMBOL_PX = 11;

/** Where a data block's text starts: CSS px from the target (y up), and which side it extends to. */
export interface DataBlockTextAnchor {
  x: number;
  y: number;
  side: 1 | -1;
}

export function dataBlockTextAnchor(direction: number): DataBlockTextAnchor {
  const { toPx } = LEADER_DIRECTIONS[direction];
  const side = toPx[0] >= 0 ? 1 : -1;
  return { x: toPx[0] + side * DATA_BLOCK_TEXT_GAP_PX, y: toPx[1], side };
}

function dataBlockBox(
  x: number,
  y: number,
  direction: number,
  chars: number,
  lines: number
): ScreenBox {
  const anchor = dataBlockTextAnchor(direction);
  const width = chars * DATA_BLOCK_CHAR_WIDTH_PX;
  const half = (lines * DATA_BLOCK_LINE_HEIGHT_PX) / 2;
  const left = anchor.side > 0 ? x + anchor.x : x + anchor.x - width;
  // Screen y grows down; anchor y grows up.
  return [left, y - anchor.y - half, left + width, y - anchor.y + half];
}

export interface DataBlockToPlace {
  /** Target position in CSS px (y down), or null when off screen. */
  screen: readonly [number, number] | null;
  /** Longest line in characters. */
  chars: number;
  lines: 1 | 2;
  /** Direction index used last time, tried first so blocks do not hop. */
  previous: number | null;
}

/**
 * Leader direction per data block, as a controller sets them in STARS to
 * keep blocks apart: in the given order, each block takes its previous
 * direction if that is still clear, else the first clear direction, else
 * the one overlapping least. Clear means not over another target symbol or
 * a block already placed. Returns indexes into `LEADER_DIRECTIONS`.
 */
export function placeDataBlocks(blocks: readonly DataBlockToPlace[]): number[] {
  const grid = new BoxGrid();
  const targets = blocks.map((block) =>
    block.screen ? symbolBox(block.screen[0], block.screen[1], TARGET_SYMBOL_PX) : null
  );
  for (const target of targets) if (target) grid.insert(target);
  return blocks.map((block, index) => {
    const own = targets[index];
    if (!block.screen || !own) return block.previous ?? 0;
    const [x, y] = block.screen;
    const order = LEADER_DIRECTIONS.map((_, index) => index);
    if (block.previous !== null) {
      order.splice(order.indexOf(block.previous), 1);
      order.unshift(block.previous);
    }
    let best = order[0];
    let bestBox = dataBlockBox(x, y, best, block.chars, block.lines);
    let bestCost = Number.POSITIVE_INFINITY;
    for (const direction of order) {
      const box = dataBlockBox(x, y, direction, block.chars, block.lines);
      const boxCost = grid.overlapArea(box, own);
      if (boxCost < bestCost) {
        best = direction;
        bestBox = box;
        bestCost = boxCost;
      }
      if (boxCost === 0) break;
    }
    grid.insert(bestBox);
    return best;
  });
}
