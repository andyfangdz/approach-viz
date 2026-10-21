/**
 * FAA Minimum Vectoring Altitude charts in AIXM 5.1, as published at
 * aeronav.faa.gov/MVA_Charts/aixm/. Each chart is one AIXMBasicMessage of
 * Airspace members whose horizontal projection is a polygon (CRS84
 * lon/lat, with holes) and whose minimum limit is the sector's MVA in feet
 * MSL. A sector without a polygon or an MSL altitude in feet is malformed,
 * and the whole chart is rejected.
 */

export type LonLat = [lon: number, lat: number];

export interface MvaSector {
  /** Sector name from the chart (often a letter or blank). */
  name: string;
  minimumAltitudeFt: number;
  /** Outer ring first, then holes; closed lon/lat rings. */
  rings: LonLat[][];
}

export interface MvaChart {
  /** Chart edition, e.g. `N90_MVA_FUS3_2025_v1`. */
  edition: string;
  sectors: MvaSector[];
}

// AIXM namespace prefixes vary between files (`ns3:`, `aixm:`), so element
// names are matched with any prefix.
const P = '(?:[\\w-]+:)?';

function elementText(xml: string, name: string): string | null {
  const match = new RegExp(`<${P}${name}(?:\\s[^>]*)?>([^<]*)</${P}${name}>`).exec(xml);
  return match ? match[1].trim() : null;
}

function parsePosList(text: string, context: string): LonLat[] {
  const values = text.trim().split(/\s+/).map(Number);
  if (values.length < 8 || values.length % 2 !== 0 || values.some((v) => !Number.isFinite(v))) {
    throw new Error(`${context}: malformed posList`);
  }
  const ring: LonLat[] = [];
  for (let i = 0; i < values.length; i += 2) {
    const lon = values[i];
    const lat = values[i + 1];
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180) {
      throw new Error(`${context}: coordinate out of range (${lon}, ${lat})`);
    }
    ring.push([lon, lat]);
  }
  const first = ring[0];
  const last = ring[ring.length - 1];
  if (first[0] !== last[0] || first[1] !== last[1]) ring.push([first[0], first[1]]);
  return ring;
}

function ringsOf(block: string, part: 'exterior' | 'interior', context: string): LonLat[][] {
  const pattern = new RegExp(
    `<${P}${part}>[\\s\\S]*?<${P}posList(?:\\s[^>]*)?>([^<]*)</${P}posList>[\\s\\S]*?</${P}${part}>`,
    'g'
  );
  return [...block.matchAll(pattern)].map((match) => parsePosList(match[1], context));
}

export function parseMvaChart(xml: string, chartId: string): MvaChart {
  if (!new RegExp(`<${P}AIXMBasicMessage[\\s>]`).test(xml)) {
    throw new Error(`MVA chart ${chartId} is not an AIXMBasicMessage`);
  }
  const srs = [...xml.matchAll(/srsName="([^"]+)"/g)].map((match) => match[1]);
  const unsupported = srs.find((name) => !/CRS84$/.test(name));
  if (unsupported) {
    throw new Error(`MVA chart ${chartId} uses unsupported CRS ${unsupported}`);
  }
  const edition = elementText(xml, 'description') ?? chartId;
  const members = [
    ...xml.matchAll(new RegExp(`<${P}Airspace\\s[\\s\\S]*?</${P}Airspace>`, 'g'))
  ].map((match) => match[0]);
  if (members.length === 0) {
    throw new Error(`MVA chart ${chartId} has no Airspace members`);
  }

  const sectors = members.map((member, index) => {
    const context = `MVA chart ${chartId} sector ${index + 1}`;
    const limit = new RegExp(
      `<${P}minimumLimit(?:\\s+uom="([^"]*)")?\\s*>([^<]*)</${P}minimumLimit>`
    ).exec(member);
    const reference = elementText(member, 'minimumLimitReference');
    if (!limit || limit[1] !== 'FT' || reference !== 'MSL' || !/^\d+$/.test(limit[2].trim())) {
      throw new Error(`${context}: minimum limit is not feet MSL`);
    }
    const exterior = ringsOf(member, 'exterior', context);
    if (exterior.length !== 1) {
      throw new Error(`${context}: expected one exterior ring, found ${exterior.length}`);
    }
    return {
      name: elementText(member, 'name') ?? '',
      minimumAltitudeFt: parseInt(limit[2].trim(), 10),
      rings: [...exterior, ...ringsOf(member, 'interior', context)]
    };
  });
  return { edition, sectors };
}
