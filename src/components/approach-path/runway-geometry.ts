export interface RunwaySegment {
  key: string;
  label: string;
  x: number;
  z: number;
  length: number;
  rotationY: number;
}

export interface LocalRunwayThreshold {
  id: string;
  x: number;
  z: number;
}

const SUFFIX_RECIPROCAL: Record<string, string> = { L: 'R', R: 'L', C: 'C' };

export function parseRunwayId(id: string): { num: number; suffix: string } | null {
  const ident = id.replace(/^RW/, '').trim();
  const match = ident.match(/^(\d{1,2})([LRC]?)$/);
  if (!match) return null;
  const num = parseInt(match[1], 10);
  if (!Number.isFinite(num) || num < 1 || num > 36) return null;
  return { num, suffix: match[2] || '' };
}

export function reciprocalRunwayId(id: string): string | null {
  const parsed = parseRunwayId(id);
  if (!parsed) return null;
  const reciprocalNum = ((parsed.num + 17) % 36) + 1;
  const reciprocalSuffix = parsed.suffix ? (SUFFIX_RECIPROCAL[parsed.suffix] ?? parsed.suffix) : '';
  return `RW${String(reciprocalNum).padStart(2, '0')}${reciprocalSuffix}`;
}

export function buildRunwaySegments(runways: LocalRunwayThreshold[]): RunwaySegment[] {
  const byId = new Map(runways.map((runway) => [runway.id, runway]));
  const visited = new Set<string>();
  const segments: RunwaySegment[] = [];

  for (const runway of runways) {
    if (visited.has(runway.id)) continue;
    visited.add(runway.id);

    const reciprocal = reciprocalRunwayId(runway.id);
    const opposite = reciprocal ? byId.get(reciprocal) : undefined;

    if (opposite && !visited.has(opposite.id)) {
      visited.add(opposite.id);
      const dx = opposite.x - runway.x;
      const dz = opposite.z - runway.z;
      const length = Math.max(0.2, Math.hypot(dx, dz));
      segments.push({
        key: `${runway.id}-${opposite.id}`,
        label: `${runway.id}/${opposite.id.replace(/^RW/, '')}`,
        x: (runway.x + opposite.x) / 2,
        z: (runway.z + opposite.z) / 2,
        length,
        rotationY: Math.atan2(dx, dz)
      });
      continue;
    }

    const parsed = parseRunwayId(runway.id);
    const heading = parsed ? parsed.num * 10 : 0;
    const headingRad = (heading * Math.PI) / 180;
    const dx = Math.sin(headingRad) * 1.0;
    const dz = -Math.cos(headingRad) * 1.0;
    segments.push({
      key: runway.id,
      label: runway.id,
      x: runway.x + dx / 2,
      z: runway.z + dz / 2,
      length: 1.0,
      rotationY: Math.atan2(dx, dz)
    });
  }

  return segments;
}
