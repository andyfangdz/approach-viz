import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { parseCIFP } from '../lib/cifp/parser';

interface ApproachMinimumsDb {
  dtpp_cycle_number: string;
  airports: Record<string, { approaches: ExternalApproach[] }>;
}

interface MinimumsValue {
  altitude: string;
  rvr: string | null;
  visibility: string | null;
}

interface ApproachMinimums {
  minimums_type: string;
  cat_a: MinimumsValue | 'NA' | null;
  cat_b: MinimumsValue | 'NA' | null;
  cat_c: MinimumsValue | 'NA' | null;
  cat_d: MinimumsValue | 'NA' | null;
}

interface ExternalApproach {
  name: string;
  types: string[];
  runway: string | null;
  minimums: ApproachMinimums[];
}

interface AirspaceGeoJson {
  features: Array<{
    properties: {
      NAME?: string;
      AIRSPACE?: string;
      LOWALT?: string;
      HIGHALT?: string;
    };
    geometry: {
      type: 'Polygon' | 'MultiPolygon';
      coordinates: number[][][] | number[][][][];
    };
  }>;
}

const DATA_DIR = path.join(process.cwd(), 'public', 'data');
const CIFP_PATH = path.join(DATA_DIR, 'cifp', 'FAACIFP18');
const APPROACH_DB_PATH = path.join(DATA_DIR, 'approach-db', 'approaches.json');
const AIRSPACE_DIR = path.join(DATA_DIR, 'airspace');
const DB_DIR = path.join(process.cwd(), 'data');
const DB_PATH = path.join(DB_DIR, 'approach-viz.sqlite');

function parseAltitude(alt: string | undefined): number {
  if (!alt || alt === 'SFC') return 0;
  const parsed = parseInt(alt, 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

function extractRings(feature: AirspaceGeoJson['features'][number]): [number, number][][] {
  if (feature.geometry.type === 'Polygon') {
    return feature.geometry.coordinates as [number, number][][];
  }
  return (feature.geometry.coordinates as [number, number][][][]).flat();
}

function computeBounds(rings: [number, number][][]): {
  minLat: number;
  maxLat: number;
  minLon: number;
  maxLon: number;
} {
  let minLat = Number.POSITIVE_INFINITY;
  let maxLat = Number.NEGATIVE_INFINITY;
  let minLon = Number.POSITIVE_INFINITY;
  let maxLon = Number.NEGATIVE_INFINITY;

  for (const ring of rings) {
    for (const [lon, lat] of ring) {
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
      if (lon < minLon) minLon = lon;
      if (lon > maxLon) maxLon = lon;
    }
  }

  return { minLat, maxLat, minLon, maxLon };
}

function ensureSourceFile(filePath: string) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Missing required file: ${filePath}`);
  }
}

function main() {
  ensureSourceFile(CIFP_PATH);
  ensureSourceFile(APPROACH_DB_PATH);
  ensureSourceFile(path.join(AIRSPACE_DIR, 'class_b.geojson'));
  ensureSourceFile(path.join(AIRSPACE_DIR, 'class_c.geojson'));
  ensureSourceFile(path.join(AIRSPACE_DIR, 'class_d.geojson'));

  fs.mkdirSync(DB_DIR, { recursive: true });
  if (fs.existsSync(DB_PATH)) {
    fs.unlinkSync(DB_PATH);
  }
  const sidecarWal = `${DB_PATH}-wal`;
  const sidecarShm = `${DB_PATH}-shm`;
  if (fs.existsSync(sidecarWal)) fs.unlinkSync(sidecarWal);
  if (fs.existsSync(sidecarShm)) fs.unlinkSync(sidecarShm);

  const db = new Database(DB_PATH);
  // DELETE journal mode is chosen deliberately: the DB is opened read-only at
  // runtime (see lib/db.ts) and deployed to environments with read-only
  // filesystems (e.g. Vercel serverless lambdas).  WAL mode requires the
  // runtime to create -wal and -shm sidecar files, which fails on read-only
  // mounts.  DELETE mode produces a single self-contained .sqlite file that
  // works everywhere without sidecar writes.
  db.pragma('journal_mode = DELETE');
  db.pragma('synchronous = NORMAL');

  db.exec(`
    CREATE TABLE metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE airports (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      lat REAL NOT NULL,
      lon REAL NOT NULL,
      elevation INTEGER NOT NULL,
      mag_var REAL NOT NULL
    );

    CREATE TABLE waypoints (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      lat REAL NOT NULL,
      lon REAL NOT NULL,
      type TEXT NOT NULL
    );

    CREATE TABLE runways (
      airport_id TEXT NOT NULL,
      id TEXT NOT NULL,
      lat REAL NOT NULL,
      lon REAL NOT NULL,
      PRIMARY KEY (airport_id, id)
    );

    CREATE TABLE approaches (
      airport_id TEXT NOT NULL,
      procedure_id TEXT NOT NULL,
      type TEXT NOT NULL,
      runway TEXT NOT NULL,
      data_json TEXT NOT NULL,
      PRIMARY KEY (airport_id, procedure_id)
    );

    CREATE INDEX idx_approaches_airport ON approaches(airport_id);

    CREATE TABLE minima (
      airport_id TEXT NOT NULL,
      approach_name TEXT NOT NULL,
      runway TEXT,
      types_json TEXT NOT NULL,
      minimums_json TEXT NOT NULL,
      cycle TEXT NOT NULL,
      PRIMARY KEY (airport_id, approach_name)
    );

    CREATE INDEX idx_minima_airport_runway ON minima(airport_id, runway);

    CREATE TABLE airspace (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      class TEXT NOT NULL,
      name TEXT NOT NULL,
      lower_alt INTEGER NOT NULL,
      upper_alt INTEGER NOT NULL,
      coordinates_json TEXT NOT NULL
    );

    CREATE VIRTUAL TABLE airspace_rtree USING rtree(id, min_lat, max_lat, min_lon, max_lon);

    CREATE TABLE airport_rtree_map (
      id INTEGER PRIMARY KEY,
      airport_id TEXT NOT NULL
    );

    CREATE VIRTUAL TABLE airport_rtree USING rtree(id, min_lat, max_lat, min_lon, max_lon);
  `);

  const cifpContent = fs.readFileSync(CIFP_PATH, 'utf8');
  const parsed = parseCIFP(cifpContent);

  const insertMetadata = db.prepare('INSERT INTO metadata (key, value) VALUES (?, ?)');
  const insertAirport = db.prepare(
    'INSERT INTO airports (id, name, lat, lon, elevation, mag_var) VALUES (?, ?, ?, ?, ?, ?)'
  );
  const insertWaypoint = db.prepare(
    'INSERT INTO waypoints (id, name, lat, lon, type) VALUES (?, ?, ?, ?, ?)'
  );
  const insertRunway = db.prepare(
    'INSERT INTO runways (airport_id, id, lat, lon) VALUES (?, ?, ?, ?)'
  );
  const insertApproach = db.prepare(
    'INSERT INTO approaches (airport_id, procedure_id, type, runway, data_json) VALUES (?, ?, ?, ?, ?)'
  );
  const insertMinima = db.prepare(
    'INSERT INTO minima (airport_id, approach_name, runway, types_json, minimums_json, cycle) VALUES (?, ?, ?, ?, ?, ?)'
  );
  const insertAirspace = db.prepare(
    'INSERT INTO airspace (class, name, lower_alt, upper_alt, coordinates_json) VALUES (?, ?, ?, ?, ?)'
  );
  const insertAirspaceRtree = db.prepare(
    'INSERT INTO airspace_rtree (id, min_lat, max_lat, min_lon, max_lon) VALUES (?, ?, ?, ?, ?)'
  );
  const insertAirportRtreeMap = db.prepare(
    'INSERT INTO airport_rtree_map (id, airport_id) VALUES (?, ?)'
  );
  const insertAirportRtree = db.prepare(
    'INSERT INTO airport_rtree (id, min_lat, max_lat, min_lon, max_lon) VALUES (?, ?, ?, ?, ?)'
  );

  const insertCifpData = db.transaction(() => {
    for (const airport of parsed.airports.values()) {
      if (!Number.isFinite(airport.lat) || !Number.isFinite(airport.lon)) {
        continue;
      }
      insertAirport.run(
        airport.id,
        airport.name,
        airport.lat,
        airport.lon,
        Number.isFinite(airport.elevation) ? airport.elevation : 0,
        Number.isFinite(airport.magVar) ? airport.magVar : 0
      );
    }

    for (const waypoint of parsed.waypoints.values()) {
      if (!Number.isFinite(waypoint.lat) || !Number.isFinite(waypoint.lon)) {
        continue;
      }
      insertWaypoint.run(waypoint.id, waypoint.name, waypoint.lat, waypoint.lon, waypoint.type);
    }

    for (const [airportId, runways] of parsed.runways.entries()) {
      for (const runway of runways) {
        if (!Number.isFinite(runway.lat) || !Number.isFinite(runway.lon)) {
          continue;
        }
        insertRunway.run(airportId, runway.id, runway.lat, runway.lon);
      }
    }

    for (const [airportId, approaches] of parsed.approaches.entries()) {
      for (const approach of approaches) {
        const procedureId = (approach.procedureId || '').trim();
        const type = (approach.type || '').trim();
        const runway = (approach.runway || '').trim();
        if (!procedureId || !type || !runway) {
          continue;
        }
        const serializable = {
          ...approach,
          transitions: Array.from(approach.transitions.entries())
        };
        insertApproach.run(airportId, procedureId, type, runway, JSON.stringify(serializable));
      }
    }
  });

  insertCifpData();

  const minimumsDb = JSON.parse(fs.readFileSync(APPROACH_DB_PATH, 'utf8')) as ApproachMinimumsDb;

  const insertMinimumsData = db.transaction(() => {
    for (const [airportId, airportData] of Object.entries(minimumsDb.airports || {})) {
      const approaches = airportData?.approaches || [];
      for (const approach of approaches) {
        const name = String(approach.name || '').trim();
        if (!name) continue;
        const runway =
          approach.runway === null || approach.runway === undefined
            ? null
            : String(approach.runway);
        const typesJson = JSON.stringify(Array.isArray(approach.types) ? approach.types : []);
        const minimumsJson = JSON.stringify(
          Array.isArray(approach.minimums) ? approach.minimums : []
        );
        insertMinima.run(
          airportId,
          name,
          runway,
          typesJson,
          minimumsJson,
          minimumsDb.dtpp_cycle_number
        );
      }
    }
  });

  insertMinimumsData();

  const insertAirspaceData = db.transaction(() => {
    const classes: Array<{ file: string; classCode: string }> = [
      { file: 'class_b.geojson', classCode: 'B' },
      { file: 'class_c.geojson', classCode: 'C' },
      { file: 'class_d.geojson', classCode: 'D' }
    ];

    for (const { file, classCode } of classes) {
      const geo = JSON.parse(
        fs.readFileSync(path.join(AIRSPACE_DIR, file), 'utf8')
      ) as AirspaceGeoJson;
      for (const feature of geo.features) {
        const rings = extractRings(feature);
        if (!rings.length) continue;
        const bounds = computeBounds(rings);
        const info = insertAirspace.run(
          classCode,
          feature.properties.NAME || feature.properties.AIRSPACE || `${classCode} Airspace`,
          parseAltitude(feature.properties.LOWALT),
          parseAltitude(feature.properties.HIGHALT),
          JSON.stringify(rings)
        );
        insertAirspaceRtree.run(
          info.lastInsertRowid,
          bounds.minLat,
          bounds.maxLat,
          bounds.minLon,
          bounds.maxLon
        );
      }
    }
  });

  insertAirspaceData();

  // Build airport R-tree spatial index (replaces external kdbush binary)
  const insertAirportSpatial = db.transaction(() => {
    let idx = 1;
    for (const airport of parsed.airports.values()) {
      if (!Number.isFinite(airport.lat) || !Number.isFinite(airport.lon)) continue;
      insertAirportRtreeMap.run(idx, airport.id);
      insertAirportRtree.run(idx, airport.lat, airport.lat, airport.lon, airport.lon);
      idx++;
    }
    return idx - 1;
  });
  const airportSpatialCount = insertAirportSpatial();

  insertMetadata.run('dtpp_cycle_number', minimumsDb.dtpp_cycle_number || '');
  insertMetadata.run('generated_at', new Date().toISOString());
  insertMetadata.run('airport_count', String(parsed.airports.size));
  insertMetadata.run(
    'approach_count',
    String(Array.from(parsed.approaches.values()).reduce((sum, rows) => sum + rows.length, 0))
  );

  db.close();
  console.log(`✅ SQLite DB built at ${DB_PATH}`);
  console.log(`✅ Airport spatial R-tree built (${airportSpatialCount} airports)`);
}

main();
