// Visual styles for in-scene labels: font, glow, and optional chip box, in
// CSS terms (px, CSS colors) so the canvas rasterizer draws them the way the
// browser would draw the equivalent HTML. Kept free of `three` and the
// DOM: styles cross the worker boundary as plain data.

export interface LabelTextShadow {
  /** CSS color of the glow. */
  color: string;
  /** CSS `text-shadow` blur radius in CSS px. */
  blurPx: number;
}

export interface LabelBox {
  paddingXPx: number;
  paddingYPx: number;
  borderPx: number;
  borderColor: string;
  background: string;
  radiusPx: number;
}

export interface LabelStyle {
  fontFamily: string;
  fontSizePx: number;
  fontWeight: number;
  color: string;
  /** CSS `letter-spacing`, e.g. `0.03em`. */
  letterSpacing?: string;
  /** Line-height multiplier; `normal` line height when omitted. */
  lineHeight?: number;
  textShadows?: LabelTextShadow[];
  box?: LabelBox;
}

const MONO_WITH_SF = "'JetBrains Mono', 'SF Mono', monospace";
const MONO = "'JetBrains Mono', monospace";
/** `var(--radius-xs)` in App.css. */
const RADIUS_XS_PX = 4;

const SOFT_GLOW: LabelTextShadow[] = [
  { color: 'rgba(0, 0, 0, 0.8)', blurPx: 4 },
  { color: 'rgba(0, 0, 0, 0.6)', blurPx: 8 }
];
const STRONG_GLOW: LabelTextShadow[] = [
  { color: 'rgba(0, 0, 0, 0.9)', blurPx: 4 },
  { color: 'rgba(0, 0, 0, 0.7)', blurPx: 8 }
];

export const WAYPOINT_LABEL_STYLE: LabelStyle = {
  fontFamily: MONO_WITH_SF,
  fontSizePx: 11,
  fontWeight: 500,
  color: '#ffffff',
  textShadows: SOFT_GLOW
};

export function airportLabelStyle(color: string): LabelStyle {
  return {
    fontFamily: MONO_WITH_SF,
    fontSizePx: 11,
    fontWeight: 500,
    color,
    textShadows: SOFT_GLOW
  };
}

export function runwayLabelStyle(color: string): LabelStyle {
  return {
    fontFamily: MONO_WITH_SF,
    fontSizePx: 10,
    fontWeight: 500,
    color,
    textShadows: SOFT_GLOW
  };
}

export function holdLabelStyle(color: string): LabelStyle {
  return {
    fontFamily: MONO_WITH_SF,
    fontSizePx: 10,
    fontWeight: 600,
    color,
    letterSpacing: '0.02em',
    textShadows: STRONG_GLOW
  };
}

export function turnConstraintLabelStyle(color: string): LabelStyle {
  return {
    fontFamily: MONO_WITH_SF,
    fontSizePx: 10,
    fontWeight: 600,
    color,
    textShadows: STRONG_GLOW
  };
}

/** ADS-B callsign above an aircraft marker. */
export const CALLSIGN_LABEL_STYLE: LabelStyle = {
  fontFamily: MONO,
  fontSizePx: 10,
  fontWeight: 600,
  color: '#c8f9ff',
  letterSpacing: '0.03em',
  lineHeight: 1.1,
  textShadows: [
    { color: 'rgba(0, 0, 0, 0.95)', blurPx: 3 },
    { color: 'rgba(0, 0, 0, 0.65)', blurPx: 7 }
  ]
};

function chipBox(borderColor: string, background: string): LabelBox {
  return {
    paddingXPx: 4,
    paddingYPx: 2,
    borderPx: 1,
    borderColor,
    background,
    radiusPx: RADIUS_XS_PX
  };
}

function chipStyle(color: string, borderColor: string, background: string): LabelStyle {
  return {
    fontFamily: MONO,
    fontSizePx: 9,
    fontWeight: 400,
    color,
    lineHeight: 1,
    box: chipBox(borderColor, background)
  };
}

const OBSTACLE_BORDER = 'rgba(255, 170, 89, 0.38)';
const OBSTACLE_BACKGROUND = 'rgba(26, 16, 4, 0.76)';

/** Obstacle elevation chip. */
export const OBSTACLE_LABEL_STYLE = chipStyle('#ffd9a8', OBSTACLE_BORDER, OBSTACLE_BACKGROUND);

/** TPP convention: the plan view's highest obstacle gets a bolder, larger label. */
export const OBSTACLE_HIGHEST_LABEL_STYLE: LabelStyle = {
  ...OBSTACLE_LABEL_STYLE,
  fontSizePx: 11,
  fontWeight: 700,
  color: '#ffe9c4',
  box: chipBox('rgba(255, 170, 89, 0.7)', OBSTACLE_BACKGROUND)
};

/** MRMS altitude-guide ring label. */
export const ALTITUDE_GUIDE_LABEL_STYLE = chipStyle(
  '#d6ecff',
  'rgba(124, 188, 255, 0.35)',
  'rgba(8, 14, 28, 0.72)'
);

/** ProbSevere storm-top label. */
export const STORM_CELL_LABEL_STYLE = chipStyle(
  '#ffe2b0',
  'rgba(255, 170, 89, 0.38)',
  'rgba(26, 12, 4, 0.76)'
);

/** Stable identity of a style, used to key atlas entries. */
export function labelStyleKey(style: LabelStyle): string {
  const shadows = (style.textShadows ?? []).map((s) => `${s.color}/${s.blurPx}`).join(',');
  const box = style.box
    ? `${style.box.paddingXPx},${style.box.paddingYPx},${style.box.borderPx},${style.box.borderColor},${style.box.background},${style.box.radiusPx}`
    : '';
  return [
    style.fontFamily,
    style.fontSizePx,
    style.fontWeight,
    style.color,
    style.letterSpacing ?? '',
    style.lineHeight ?? '',
    shadows,
    box
  ].join('|');
}
