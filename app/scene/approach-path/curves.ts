export function formatHoldDistance(distanceNm: number): string {
  const rounded = Math.round(distanceNm * 10) / 10;
  return Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(1);
}
