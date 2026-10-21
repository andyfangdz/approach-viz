import assert from 'node:assert/strict';
import test from 'node:test';
import type { AirspaceFeature, TraconVideoMapData } from '@/lib/types';
import { arcPoints, parseScopeMapRecords } from '@/lib/cifp/scope-map-records';
import { parseMvaChart } from '@/lib/mva/parser';
import { polygonLabelPoint } from '@/lib/polygon-label-point';
import {
  dataBlockKind,
  formatAltitudeFilter,
  formatDataBlock,
  shortDataBlockLine
} from './data-block';
import {
  declutterBoxes,
  LEADER_DIRECTIONS,
  placeDataBlocks,
  symbolLabelBox
} from './label-declutter';
import {
  buildEdgeCompassRose,
  buildRangeRings,
  buildScopeVideoMap,
  mvaLabelText,
  rangeRingRadii
} from './scope-geometry';
import { buildScopeWxLevels, scopeWxLevel } from './scope-weather';
import { traceShoreline } from './shoreline';
import {
  buildTrafficScopeBuffers,
  SCOPE_MAX_HISTORY_DOTS,
  scopeRenderHash,
  TRAFFIC_FLAG_IS_CURRENTLY_PRESENT,
  TRAFFIC_FLAG_IS_ON_GROUND
} from '../traffic/traffic-draw-buffers';
import { COMPOSITE_EMPTY_DBZ_TENTHS } from '../nexrad/nexrad-composite';
import {
  availableWxLevels,
  clampRange,
  RING_SPACING_STEPS_NM,
  stepAltitudeFilter,
  stepPtl,
  stepThrough
} from '../../app-client/tracon/scope-settings';

function near(actual: number, expected: number, message?: string) {
  assert.ok(Math.abs(actual - expected) < 1e-5, message ?? `${actual} != ${expected}`);
}

test('formatDataBlock uses STARS altitude hundreds and ground speed tens', () => {
  assert.deepEqual(formatDataBlock('UAL445', 'a1b2c3', 4520, 214), ['UAL445', '045 21']);
  assert.deepEqual(formatDataBlock(null, 'a1b2c3', 11000, 95), ['A1B2C3', '110 10']);
  assert.deepEqual(formatDataBlock('  ', 'abc', Number.NaN, Number.NaN), ['ABC', '--- --']);
  assert.deepEqual(formatDataBlock('HI', 'abc', 150_000, 2000), ['HI', '999 99']);
});

test('range rings follow the RR spacing out to the map radius, flat on the floor', () => {
  assert.deepEqual(rangeRingRadii(10, 35), [10, 20, 30]);
  assert.deepEqual(rangeRingRadii(5, 20), [5, 10, 15, 20]);
  assert.deepEqual(rangeRingRadii(0, 60), []);
  assert.deepEqual(rangeRingRadii(10, Number.NaN), []);
  const rings = buildRangeRings(10, 20, 0.25);
  for (let i = 1; i < rings.length; i += 3) assert.equal(rings[i], 0.25);
  near(Math.hypot(rings.at(-3)!, rings.at(-1)!), 20);
});

function emptyVideoMap(): TraconVideoMapData {
  return {
    radiusNm: 60,
    runwayAirports: [],
    finals: [],
    approachFixes: [],
    navaids: [],
    arrivalPaths: [],
    arrivalFixes: [],
    mva: { chartEdition: 'TEST', sectors: [] },
    specialUse: []
  };
}

test('the video map draws runways once, approach finals with FAF ticks, and symbols', () => {
  const data = emptyVideoMap();
  data.runwayAirports = [
    {
      airportId: 'KTST',
      runways: [
        { id: 'RW04', lat: 40, lon: -74 },
        { id: 'RW22', lat: 40.01, lon: -73.99 },
        { id: 'RW13', lat: 40, lon: -73.98 }
      ]
    }
  ];
  // Southwest final: IF, FAF, threshold, due north-east.
  data.finals = [
    {
      airportId: 'KTST',
      procedureId: 'I04',
      path: [
        [-74.2, 39.8],
        [-74.1, 39.9],
        [-74, 40]
      ],
      finalApproachFixes: [[-74.1, 39.9]]
    }
  ];
  data.approachFixes = [{ name: 'FAFFX', lat: 39.9, lon: -74.1 }];
  data.navaids = [
    { ident: 'VOR', kind: 'VOR', lat: 40.2, lon: -74 },
    { ident: 'NB', kind: 'NDB', lat: 40.1, lon: -74 }
  ];
  const map = buildScopeVideoMap(data, [], 40, -74, 0);
  // RW13 has no reciprocal threshold, so one runway line.
  assert.equal(map.runwaySegments.length, 6);
  // Two course segments plus one FAF tick across the course.
  assert.equal(map.finalSegments.length / 6, 3);
  const tick = map.finalSegments.slice(12, 18);
  const along = [
    map.finalSegments[9] - map.finalSegments[6],
    map.finalSegments[11] - map.finalSegments[8]
  ];
  const across = [tick[3] - tick[0], tick[5] - tick[2]];
  near(along[0] * across[0] + along[1] * across[1], 0, 'the tick crosses the course');
  assert.deepEqual(
    map.approachFixes.labels.map((label) => label.text),
    ['FAFFX']
  );
  assert.equal(map.vors.positions.length, 3);
  assert.deepEqual(map.ndbs.labels[0].text, 'NB');
});

test('the video map clips far segments and splits airspace by class', () => {
  const data = emptyVideoMap();
  data.radiusNm = 10;
  // One segment near the center, one wholly beyond 10 NM.
  data.arrivalPaths = [
    [
      [-74, 40],
      [-74, 40.1],
      [-74, 41],
      [-74, 41.1]
    ]
  ];
  data.mva.sectors = [
    {
      minimumAltitudeFt: 2500,
      rings: [
        [
          [-74, 40],
          [-73.9, 40],
          [-73.9, 40.1],
          [-74, 40]
        ]
      ],
      labelLat: 40.03,
      labelLon: -73.95
    }
  ];
  const square = (cls: string): AirspaceFeature => ({
    type: 'CLASS',
    class: cls,
    name: cls,
    lowerAlt: 0,
    upperAlt: 7000,
    coordinates: [
      [
        [-74, 40],
        [-73.9, 40],
        [-73.9, 40.1],
        [-74, 40]
      ]
    ]
  });
  const map = buildScopeVideoMap(
    data,
    [square('B'), square('C'), square('D'), square('E')],
    40,
    -74,
    0
  );
  // Segment 1 is inside, segment 2 reaches inside, segment 3 is beyond.
  assert.equal(map.arrivalSegments.length / 6, 2);
  assert.equal(map.mvaSegments.length / 6, 3);
  assert.deepEqual(
    map.mvaLabels.map((label) => label.text),
    ['25']
  );
  // Three edges per closed ring; class E is not on the map.
  assert.equal(map.classBSegments.length / 6, 3);
  assert.equal(map.classCDSegments.length / 6, 6);
  assert.equal(mvaLabelText(1550), '16');
});

// FAACIFP18 records (cycle 2610): VOR, DME-only VOR, NDB, enroute and
// terminal waypoints, the first legs of a STAR common route (its first fix
// changed to CRI so the fixture stays small), and P-56A cut to three points
// plus the P-56B circle.
const SCOPE_MAP_CIFP = [
  'SUSAD        CRI   K6011230VDTW N40364489W073534007    N40364490W073534000W0110000040     NARCANARSIE                      251212308',
  'SUSAD        CSX   K3011645 DLW                    CSX N38450988W090213946W0019005561     NARCARDINAL                      251272605',
  'SUSADB       AA    K3003650HOLW N47003259W096485466                       E0040           NARKENIE                         268621805',
  'SUSAEAENRT   HOGGS K60    C   L N39345825W074161407                       W0122     NAR           HOGGS                    379732504',
  'SUSAP KJFKK6CBOTON K60    R     N39245210W074271708                       W0121     NAR           BOTON                    305062506',
  'SUSAP KJFKK6ECAMRN52ALL   010CRI  K6D 0V       IF                                             18000                        305942506',
  'SUSAP KJFKK6ECAMRN52ALL   020BOTONK6PC0E       TF                                                                          305952506',
  'SUSAP KJFKK6ECAMRN52ALL   030HOGGSK6EA0E       TF                                                                          305962506',
  'SUSAURK6P56        A00100LC   G N38532000W077030200                              GND  A18000MP-56                          879611703',
  'SUSAURK6P56        A00200L    G N38534500W077032300                                                                        879621703',
  'SUSAURK6P56        A00300L    GEN38535000W077031700                                                                        879631703',
  'SUSAURK6P56        B01200LC   CE                   N38551700W0770401000004       GND  A18000MP-56                          879721703'
].join('\n');

test('scope map records parse navaids, STAR routes, and special use airspace', () => {
  const records = parseScopeMapRecords(SCOPE_MAP_CIFP);
  assert.deepEqual(
    records.navaids.map((navaid) => `${navaid.kind} ${navaid.ident}`),
    ['VOR CRI', 'NDB AA']
  );
  assert.equal(records.stars.length, 1);
  const [star] = records.stars;
  assert.equal(star.procedureId, 'CAMRN5');
  assert.deepEqual(
    star.fixes.map((fix) => fix.name),
    ['CRI', 'BOTON', 'HOGGS']
  );
  assert.equal(star.paths.length, 1);
  assert.equal(star.paths[0].length, 3);
  near(star.paths[0][0][1], 40 + 36 / 60 + 44.89 / 3600);

  const [polygon, circle] = records.restrictiveAirspace;
  assert.equal(polygon.name, 'P-56');
  assert.equal(polygon.type, 'P');
  assert.equal(polygon.upperLimit, '18000');
  // Three published points, closed.
  assert.equal(polygon.rings[0].length, 4);
  // 0.4 NM circle around the arc origin.
  const center = { lat: 38 + 55 / 60 + 17 / 3600, lon: -(77 + 4 / 60 + 1 / 3600) };
  for (const [lon, lat] of circle.rings[0]) {
    const dx = (lon - center.lon) * Math.cos((center.lat * Math.PI) / 180) * 60;
    const dz = (lat - center.lat) * 60;
    // Within the 1e-6 degree storage rounding.
    assert.ok(Math.abs(Math.hypot(dx, dz) - 0.4) < 1e-3);
  }

  // An unresolvable STAR fix is an error, not a gap.
  assert.throws(
    () => parseScopeMapRecords(SCOPE_MAP_CIFP.replace('HOGGSK6EA', 'NOPESK6EA')),
    /NOPES/
  );
});

test('arcs sweep the requested way and meet both endpoints', () => {
  const center = { lat: 40, lon: -74 };
  const north = { lat: 40 + 5 / 60, lon: -74 };
  const east = { lat: 40, lon: -74 + 5 / 60 / Math.cos((40 * Math.PI) / 180) };
  const clockwise = arcPoints(center, north, east, true);
  const counter = arcPoints(center, north, east, false);
  // A quarter turn clockwise, three quarters counterclockwise.
  assert.ok(counter.length > clockwise.length * 2);
  // Clockwise from north toward east passes north-east of the center.
  const mid = clockwise[Math.floor(clockwise.length / 2)];
  assert.ok(mid[0] > center.lon && mid[1] > center.lat);
});

test('MVA charts parse AIXM sectors in feet MSL and reject other units', () => {
  const sector = (limit: string, uom = 'FT') => `
    <aixm:Airspace gml:id="1"><aixm:timeSlice><aixm:AirspaceTimeSlice>
      <aixm:name>A</aixm:name>
      <aixm:minimumLimit uom="${uom}">${limit}</aixm:minimumLimit>
      <aixm:minimumLimitReference>MSL</aixm:minimumLimitReference>
      <gml:exterior><gml:LinearRing>
        <gml:posList srsName="urn:ogc:def:crs:OGC:1.3:CRS84">-74 40 -73.9 40 -73.9 40.1 -74 40</gml:posList>
      </gml:LinearRing></gml:exterior>
      <gml:interior><gml:LinearRing>
        <gml:posList>-73.98 40.01 -73.95 40.01 -73.95 40.03 -73.98 40.01</gml:posList>
      </gml:LinearRing></gml:interior>
    </aixm:AirspaceTimeSlice></aixm:timeSlice></aixm:Airspace>`;
  const chart = (body: string) =>
    `<message:AIXMBasicMessage><gml:description>TST_MVA_FUS3_2026</gml:description>${body}</message:AIXMBasicMessage>`;
  const parsed = parseMvaChart(chart(sector('2500')), 'TST');
  assert.equal(parsed.edition, 'TST_MVA_FUS3_2026');
  assert.equal(parsed.sectors[0].minimumAltitudeFt, 2500);
  assert.equal(parsed.sectors[0].rings.length, 2);
  assert.throws(() => parseMvaChart(chart(sector('762', 'M')), 'TST'), /feet MSL/);
  assert.throws(() => parseMvaChart(chart(''), 'TST'), /no Airspace/);
});

test('polygon label points sit inside, clear of holes', () => {
  // A square with a hole covering its center: the label goes beside the hole.
  const outer: [number, number][] = [
    [0, 0],
    [1, 0],
    [1, 1],
    [0, 1],
    [0, 0]
  ];
  const hole: [number, number][] = [
    [0.3, 0.3],
    [0.7, 0.3],
    [0.7, 0.7],
    [0.3, 0.7],
    [0.3, 0.3]
  ];
  const [x, y] = polygonLabelPoint([outer, hole]);
  assert.ok(x > 0 && x < 1 && y > 0 && y < 1);
  assert.ok(!(x > 0.3 && x < 0.7 && y > 0.3 && y < 0.7));
});

test('the compass rose meets the display edges, clear of the top inset', () => {
  const rose = buildEdgeCompassRose(800, 600, 100);
  assert.equal(rose.ticks.length, 72);
  assert.equal(rose.labels.length, 36);
  const north = rose.ticks[0];
  near(north.x1, 400);
  near(north.y1, 100);
  const east = rose.ticks[18];
  near(east.x1, 800);
  near(east.y1, 300);
  const south = rose.ticks[36];
  near(south.y1, 600);
  assert.equal(rose.labels[9].text, '090');
  assert.deepEqual(buildEdgeCompassRose(0, 600), { ticks: [], labels: [] });
});

test('STARS weather levels follow the six-level VIP scale', () => {
  assert.equal(scopeWxLevel(10), 0);
  assert.equal(scopeWxLevel(18), 1);
  assert.equal(scopeWxLevel(35), 2);
  assert.equal(scopeWxLevel(44), 3);
  assert.equal(scopeWxLevel(48), 4);
  assert.equal(scopeWxLevel(52), 5);
  assert.equal(scopeWxLevel(65), 6);
  assert.equal(scopeWxLevel(Number.NaN), 0);
  assert.deepEqual(
    [...buildScopeWxLevels(new Int16Array([COMPOSITE_EMPTY_DBZ_TENTHS, 200, 455, 600]))],
    [0, 1, 3, 6]
  );
  assert.equal(availableWxLevels(null), 0);
  assert.equal(availableWxLevels(47), 4);
});

test('DCB spinners step through STARS values and clamp at the ends', () => {
  assert.equal(stepThrough(RING_SPACING_STEPS_NM, 10, 1), 20);
  assert.equal(stepThrough(RING_SPACING_STEPS_NM, 20, 1), 20);
  assert.equal(stepThrough(RING_SPACING_STEPS_NM, 2, -1), 0);
  assert.equal(stepThrough(RING_SPACING_STEPS_NM, 7, -1), 2);
  assert.equal(stepPtl(1, 1), 1.5);
  assert.equal(stepPtl(0.5, -1), 0.5);
  assert.equal(clampRange(1), 5);
  assert.equal(clampRange(62.4), 62);
  assert.equal(clampRange(9999), 400);
});

test('shoreline traces the 0 m contour and skips missing tiles', () => {
  // 4x2 raster: land (+10 m) in the left two columns, ocean (-10 m) right.
  const width = 4;
  const height = 2;
  const data = new Uint8ClampedArray(width * height * 4);
  const setMeters = (col: number, row: number, meters: number, alpha = 255) => {
    const value = meters + 32768;
    const idx = (row * width + col) * 4;
    data[idx] = Math.floor(value / 256);
    data[idx + 1] = Math.floor(value % 256);
    data[idx + 2] = 0;
    data[idx + 3] = alpha;
  };
  for (let row = 0; row < height; row += 1) {
    setMeters(0, row, 10);
    setMeters(1, row, 10);
    setMeters(2, row, -10);
    setMeters(3, row, -10);
  }
  // Zoom 8 tile at New York.
  const source = { raster: { data, width, height }, zoom: 8, minTileX: 75, minTileY: 96 };
  const refLat = 40.9;
  const refLon = -74.6;
  const segments = traceShoreline(source, refLat, refLon, 0, 500);
  // One vertical crossing per row pair, between columns 1 and 2.
  assert.equal(segments.length / 6, 1);
  near(segments[0], segments[3], 'the coast runs north-south');
  // A missing tile (alpha 0) next to the coast is not traced.
  setMeters(2, 0, -10, 0);
  assert.equal(traceShoreline(source, refLat, refLon, 0, 500).length, 0);
  // Segments beyond the radius are dropped.
  setMeters(2, 0, -10);
  assert.equal(traceShoreline(source, refLat, refLon, 0, 1).length, 0);
});

test('buildTrafficScopeBuffers builds airborne data blocks, history dots, PTLs, and stalks', () => {
  const present = TRAFFIC_FLAG_IS_CURRENTLY_PRESENT;
  const trail: number[] = [];
  // Westbound trail ending at the marker: points every 0.2 NM from x=4 to x=0.
  for (let i = 20; i >= 0; i -= 1) trail.push(i * 0.2, 1, 0);
  const soa = {
    trackCount: 3,
    markerPositions: new Float32Array([0, 1, 0, 5, 0, 5, 9, 9, 9]),
    headingDeg: new Float32Array([270, 0, 0]),
    altitudeFeet: new Float32Array([4500, Number.NaN, 8000]),
    groundSpeedKt: new Float32Array([180, 0, 300]),
    flags: new Uint8Array([present, present | TRAFFIC_FLAG_IS_ON_GROUND, 0]),
    trailPointsFlat: new Float32Array(trail),
    trailOffsets: new Uint32Array([0, 21, 21]),
    trailCounts: new Uint32Array([21, 0, 0]),
    hexes: ['aaa111', 'bbb222', 'ccc333'],
    callsignLabels: ['DAL12', null, 'GONE1']
  };
  const scope = buildTrafficScopeBuffers(soa, -0.5, {
    historyDotCount: 5,
    predictedTrackMinutes: 1
  });

  // Only present airborne tracks; surface traffic is filtered out.
  assert.deepEqual([...scope.targetPositions], [0, 1, 0]);
  assert.deepEqual(scope.dataBlockIdents, ['DAL12']);
  assert.deepEqual(scope.dataBlockFields, ['045 18']);
  assert.deepEqual(scope.targetHexes, ['aaa111']);
  assert.deepEqual([...scope.targetAltitudeFeet], [4500]);
  assert.deepEqual([...scope.targetAssociated], [1]);

  // History dots at >= 0.3 NM spacing, newest first with age 0, capped.
  const dots = scope.historyDots;
  assert.equal(dots.length / 4, 5);
  near(dots[0], 0.4);
  near(dots[4], 0.8);
  assert.deepEqual([dots[3], dots[7], dots[19]], [0, 1, 4]);

  // One-minute PTL at 180 kt heading west is 3 NM.
  assert.equal(scope.predictedTrackSegments.length, 6);
  near(scope.predictedTrackSegments[3], -3);
  near(scope.predictedTrackSegments[5], 0);

  // Stalk drops the target to the floor.
  assert.deepEqual([...scope.altitudeStalkSegments], [0, 1, 0, 0, -0.5, 0]);

  // PTL off and history capped at the STARS maximum.
  const quiet = buildTrafficScopeBuffers(soa, -0.5, {
    historyDotCount: 99,
    predictedTrackMinutes: 0
  });
  assert.equal(quiet.predictedTrackSegments.length, 0);
  assert.equal(quiet.historyDots.length / 4, SCOPE_MAX_HISTORY_DOTS);
});

test('dataBlockKind follows STARS partial, limited, and full data blocks and the altitude filter', () => {
  const filter = { lowFeet: null, highFeet: 18_000 };
  assert.equal(dataBlockKind(true, 4500, false, filter), 'partial');
  assert.equal(dataBlockKind(false, 4500, false, filter), 'limited');
  assert.equal(dataBlockKind(true, 18_000, false, filter), 'partial');
  assert.equal(dataBlockKind(true, 35_000, false, filter), 'none');
  assert.equal(dataBlockKind(false, 1200, false, { lowFeet: 2000, highFeet: 18_000 }), 'none');
  // A selected target always shows its full data block.
  assert.equal(dataBlockKind(true, 35_000, true, filter), 'full');
  // No reported altitude: nothing to filter on, so the block stays.
  assert.equal(dataBlockKind(false, Number.NaN, false, filter), 'limited');

  assert.equal(shortDataBlockLine('045 21', 'partial'), '045 21');
  assert.equal(shortDataBlockLine('045 21', 'limited'), '045');
  assert.equal(formatAltitudeFilter(filter), 'N99 180');
  assert.equal(formatAltitudeFilter({ lowFeet: 500, highFeet: 99_900 }), '005 999');
  assert.equal(stepAltitudeFilter(18_000, 1), 19_000);
  assert.equal(stepAltitudeFilter(1_000, -1), 1_000);
  assert.equal(stepAltitudeFilter(99_900, 1), 99_900);
});

test('declutterBoxes keeps labels in priority order and never overprints', () => {
  const first = symbolLabelBox(100, 100, 'JFK', 8);
  const overlapping = symbolLabelBox(104, 102, 'CRI', 8);
  const clear = symbolLabelBox(100, 140, 'LGA', 8);
  assert.deepEqual(declutterBoxes([first, overlapping, clear, null]), [true, false, true, false]);
  // A reserved symbol box blocks a label drawn over it.
  assert.deepEqual(declutterBoxes([first], [[110, 95, 120, 105]]), [false]);
  // Boxes spanning grid cells still collide.
  assert.deepEqual(
    declutterBoxes([
      [40, 40, 60, 60],
      [55, 55, 100, 100]
    ]),
    [true, false]
  );
});

test('placeDataBlocks turns a leader away from a block it would overprint', () => {
  const block = (x: number, y: number, previous: number | null = null) => ({
    screen: [x, y] as const,
    chars: 6,
    lines: 1 as const,
    previous
  });
  const keypad = (directions: number[]) => directions.map((d) => LEADER_DIRECTIONS[d].keypad);
  // Two targets far apart keep the default up-right leader.
  assert.deepEqual(keypad(placeDataBlocks([block(100, 100), block(400, 400)])), [9, 9]);
  // Stacked 8 px apart: the second block moves off the first.
  const stacked = keypad(placeDataBlocks([block(100, 100), block(100, 108)]));
  assert.equal(stacked[0], 9);
  assert.notEqual(stacked[1], 9);
  // A clear previous direction is kept instead of snapping back to 9.
  assert.deepEqual(keypad(placeDataBlocks([block(100, 100, 1)])), [3]);
  // Off-screen targets keep their previous direction.
  assert.deepEqual(placeDataBlocks([{ screen: null, chars: 3, lines: 1, previous: 4 }]), [4]);
});

test('scopeRenderHash changes with HISTORY and PTL, not only with the tracks', () => {
  const base = { historyDotCount: 5, predictedTrackMinutes: 0 };
  const hash = scopeRenderHash(123456, base);
  assert.equal(hash, scopeRenderHash(123456, { ...base }));
  assert.notEqual(hash, scopeRenderHash(123457, base));
  assert.notEqual(hash, scopeRenderHash(123456, { ...base, historyDotCount: 6 }));
  assert.notEqual(hash, scopeRenderHash(123456, { ...base, predictedTrackMinutes: 1 }));
  assert.notEqual(
    scopeRenderHash(123456, { ...base, predictedTrackMinutes: 1 }),
    scopeRenderHash(123456, { ...base, predictedTrackMinutes: 1.5 })
  );
  assert.ok(Number.isInteger(hash) && hash >= 0 && hash <= 0xffffffff);
});

test('placeDataBlocks keeps text off targets that have no data block', () => {
  const block = { screen: [100, 100] as const, chars: 6, lines: 1 as const, previous: null };
  // A filtered target where the default (up-right) block would go.
  const [direction] = placeDataBlocks([block], [[130, 81]]);
  assert.notEqual(LEADER_DIRECTIONS[direction].keypad, 9);
  assert.deepEqual(placeDataBlocks([block]), [0]);
});
