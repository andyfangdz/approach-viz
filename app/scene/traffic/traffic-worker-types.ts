export interface SceneAirport {
  lat: number;
  lon: number;
  elevation: number;
}

export interface LiveTrafficAircraft {
  hex: string;
  flight: string | null;
  lat: number;
  lon: number;
  isOnGround?: boolean;
  altitudeFeet: number | null;
  groundSpeedKt: number | null;
  trackDeg: number | null;
  lastSeenSeconds: number | null;
}

export interface LiveTrafficHistoryPoint {
  lat: number;
  lon: number;
  altitudeFeet: number;
  timestampMs: number;
}

export interface RenderTrafficTrack {
  hex: string;
  callsignLabel: string | null;
  headingDeg: number;
  markerPosition: [number, number, number];
  trailPoints: [number, number, number][];
}

interface TrafficBaseRequest {
  requestId: number;
  nowMs: number;
  historyMinutes: number;
  hideGroundTargets: boolean;
  refLat: number;
  refLon: number;
  verticalScale: number;
  applyEarthCurvatureCompensation: boolean;
  sceneAirports: SceneAirport[];
}

export interface TrafficResetRequest extends TrafficBaseRequest {
  type: 'reset';
}

export interface TrafficIngestRequest extends TrafficBaseRequest {
  type: 'ingest';
  aircraftList: LiveTrafficAircraft[];
  historyByHex?: Record<string, LiveTrafficHistoryPoint[]>;
}

export interface TrafficRecomputeRequest extends TrafficBaseRequest {
  type: 'recompute';
}

export interface TrafficErrorPruneRequest extends TrafficBaseRequest {
  type: 'prune-error';
}

export type TrafficWorkerRequestMessage =
  | TrafficResetRequest
  | TrafficIngestRequest
  | TrafficRecomputeRequest
  | TrafficErrorPruneRequest;

export interface TrafficWorkerResponseMessage {
  type: 'result';
  requestId: number;
  renderTracks?: RenderTrafficTrack[];
  trackCount?: number;
  historyPointCount?: number;
  operation?: TrafficWorkerRequestMessage['type'];
  workerProcessingMs?: number;
  error?: string;
}
