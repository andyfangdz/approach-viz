import { useState } from 'react';
import type {
  NexradDebugState,
  RuntimeCapabilities,
  ServiceWorkerCacheDebugState,
  SurfaceMode,
  TrafficDebugState
} from './types';
import type { CycleInfo, SerializedApproach } from '@/lib/types';
import type { ApproachLeg } from '@/lib/cifp/parser';

interface DebugPanelProps {
  debugCollapsed: boolean;
  onToggleDebug: () => void;
  airportId: string;
  approachId: string;
  surfaceMode: SurfaceMode;
  runtimeCapabilities: RuntimeCapabilities;
  serviceWorkerDebug: ServiceWorkerCacheDebugState;
  nexradDebug: NexradDebugState;
  trafficDebug: TrafficDebugState;
  cycleInfo: CycleInfo | null;
  currentApproach: SerializedApproach | null;
}

function formatTimestamp(value: string | null): string {
  if (!value) return 'n/a';
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) return value;
  return parsed.toLocaleTimeString([], { hour12: false });
}

function boolLabel(value: boolean): string {
  return value ? 'yes' : 'no';
}

function formatAgeSeconds(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return 'n/a';
  return `${Math.round(value)}s`;
}

function formatScanAge(scanTime: string | null): string {
  if (!scanTime) return '';
  const ms = Date.now() - new Date(scanTime).getTime();
  if (!Number.isFinite(ms) || ms < 0) return '';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s ago`;
  return `${Math.floor(s / 60)}m${s % 60}s ago`;
}

function formatFeet(value: number | null): string {
  if (value === null || !Number.isFinite(value) || value <= 0) return 'n/a';
  return `${Math.round(value).toLocaleString()} ft`;
}

function formatMs(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return 'n/a';
  return `${value.toFixed(1)} ms`;
}

function formatAltConstraint(leg: ApproachLeg): string {
  if (leg.altitude == null) return '';
  const prefix =
    leg.altitudeConstraint === '+'
      ? '≥'
      : leg.altitudeConstraint === '-'
        ? '≤'
        : leg.altitudeConstraint === 'at'
          ? '@'
          : '';
  return `${prefix}${leg.altitude}`;
}

function formatLeg(leg: ApproachLeg): string {
  const parts: string[] = [leg.pathTerminator.padEnd(2), (leg.waypointId || '—').padEnd(5)];
  const alt = formatAltConstraint(leg);
  if (alt) parts.push(alt);
  if (leg.course != null) parts.push(`crs ${leg.course.toFixed(0)}°`);
  if (leg.distance != null) parts.push(`${leg.distance.toFixed(1)} NM`);
  if (leg.verticalAngleDeg != null) parts.push(`VDA ${leg.verticalAngleDeg.toFixed(2)}°`);
  const flags: string[] = [];
  if (leg.isInitialFix) flags.push('IF');
  if (leg.isFinalApproachFix) flags.push('FAF');
  if (leg.isFinalFix) flags.push('MAP');
  if (leg.isMissedApproach) flags.push('MA');
  if (flags.length) parts.push(`[${flags.join(',')}]`);
  return parts.join(' ');
}

function LegTable({ label, legs }: { label: string; legs: ApproachLeg[] }) {
  if (!legs.length) return null;
  return (
    <div className="debug-leg-group">
      <div className="debug-leg-label">{label}</div>
      {legs.map((leg, i) => (
        <div key={`${label}-${i}`} className="debug-leg-row">
          <span className="debug-leg-seq">{leg.sequence}</span>
          <span className="debug-leg-detail">{formatLeg(leg)}</span>
        </div>
      ))}
    </div>
  );
}

export function DebugPanel({
  debugCollapsed,
  onToggleDebug,
  airportId,
  approachId,
  surfaceMode,
  runtimeCapabilities,
  serviceWorkerDebug,
  nexradDebug,
  trafficDebug,
  cycleInfo,
  currentApproach
}: DebugPanelProps) {
  const [contextExpanded, setContextExpanded] = useState(false);
  const [mrmsExpanded, setMrmsExpanded] = useState(false);
  const [procedureExpanded, setProcedureExpanded] = useState(false);
  const [trafficExpanded, setTrafficExpanded] = useState(false);

  if (debugCollapsed) {
    return (
      <button
        type="button"
        className="debug-panel-fab"
        onClick={onToggleDebug}
        title="Show debug panel"
        aria-label="Show debug panel"
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path
            d="M9 5h6M9 19h6M12 19v-2m0-10V5m-6 6h12M7 14h10a2 2 0 0 1 2 2v1a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-1a2 2 0 0 1 2-2Zm1-9h8a2 2 0 0 1 2 2v1a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2Z"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>
    );
  }

  return (
    <aside className="debug-panel compact">
      <div className="section-header">
        <h3>Debug</h3>
        <button
          type="button"
          className="info-panel-close"
          onClick={onToggleDebug}
          title="Hide debug panel"
        >
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
            <path
              d="M2 2l10 10M12 2L2 12"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
            />
          </svg>
        </button>
      </div>

      <div className="debug-section">
        <button
          type="button"
          className="debug-section-toggle"
          onClick={() => setContextExpanded((v) => !v)}
          aria-expanded={contextExpanded}
        >
          <span className="debug-title">Context</span>
          <span className="debug-summary">
            {airportId || 'n/a'} &middot; {approachId || 'n/a'}
          </span>
          <svg
            className={`debug-chevron${contextExpanded ? ' debug-chevron-open' : ''}`}
            width="10"
            height="10"
            viewBox="0 0 10 10"
            aria-hidden="true"
          >
            <path
              d="M2.5 3.5L5 6.5L7.5 3.5"
              stroke="currentColor"
              strokeWidth="1.3"
              fill="none"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
        {contextExpanded && (
          <div className="debug-section-body">
            <div className="debug-row">
              <span>Airport</span>
              <span>{airportId || 'n/a'}</span>
            </div>
            <div className="debug-row">
              <span>Approach</span>
              <span>{approachId || 'n/a'}</span>
            </div>
            <div className="debug-row">
              <span>Surface</span>
              <span>{surfaceMode}</span>
            </div>
            <div className="debug-row">
              <span>Worker</span>
              <span>{boolLabel(runtimeCapabilities.workerAvailable)}</span>
            </div>
            <div className="debug-row">
              <span>SharedArrayBuffer</span>
              <span>{boolLabel(runtimeCapabilities.sharedArrayBufferAvailable)}</span>
            </div>
            <div className="debug-row">
              <span>Atomics</span>
              <span>{boolLabel(runtimeCapabilities.atomicsAvailable)}</span>
            </div>
            <div className="debug-row">
              <span>Cross-Origin Iso</span>
              <span>{boolLabel(runtimeCapabilities.crossOriginIsolated)}</span>
            </div>
            <div className="debug-row">
              <span>SW Support</span>
              <span>{boolLabel(serviceWorkerDebug.supported)}</span>
            </div>
            <div className="debug-row">
              <span>SW Registered</span>
              <span>{boolLabel(serviceWorkerDebug.registered)}</span>
            </div>
            <div className="debug-row">
              <span>SW Controlling</span>
              <span>{boolLabel(serviceWorkerDebug.controlling)}</span>
            </div>
            <div className="debug-row">
              <span>SW State</span>
              <span>{serviceWorkerDebug.activeState || 'n/a'}</span>
            </div>
            <div className="debug-row">
              <span>SW Scope</span>
              <span>{serviceWorkerDebug.scope || 'n/a'}</span>
            </div>
            <div className="debug-row">
              <span>SW Plate Cycle</span>
              <span>{serviceWorkerDebug.dtppCycle || 'n/a'}</span>
            </div>
            {cycleInfo && (
              <>
                <div className="debug-row">
                  <span>CIFP Cycle</span>
                  <span>{cycleInfo.cifpCycle || 'n/a'}</span>
                </div>
                <div className="debug-row">
                  <span>d-TPP Cycle</span>
                  <span>{cycleInfo.dtppCycle || 'n/a'}</span>
                </div>
              </>
            )}
          </div>
        )}
      </div>

      {currentApproach && (
        <div className="debug-section">
          <button
            type="button"
            className="debug-section-toggle"
            onClick={() => setProcedureExpanded((v) => !v)}
            aria-expanded={procedureExpanded}
          >
            <span className="debug-title">Procedure (ARINC)</span>
            <span className="debug-summary">
              {currentApproach.type} {currentApproach.runway} &middot;{' '}
              {currentApproach.finalLegs.length + currentApproach.missedLegs.length} legs
            </span>
            <svg
              className={`debug-chevron${procedureExpanded ? ' debug-chevron-open' : ''}`}
              width="10"
              height="10"
              viewBox="0 0 10 10"
              aria-hidden="true"
            >
              <path
                d="M2.5 3.5L5 6.5L7.5 3.5"
                stroke="currentColor"
                strokeWidth="1.3"
                fill="none"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
          {procedureExpanded && (
            <div className="debug-section-body debug-procedure-body">
              <div className="debug-row">
                <span>Procedure ID</span>
                <span>{currentApproach.procedureId}</span>
              </div>
              <div className="debug-row">
                <span>Type</span>
                <span>{currentApproach.type}</span>
              </div>
              <div className="debug-row">
                <span>Runway</span>
                <span>{currentApproach.runway}</span>
              </div>
              {currentApproach.transitions.map(([name, legs]) => (
                <LegTable key={`tr-${name}`} label={`Transition: ${name}`} legs={legs} />
              ))}
              <LegTable label="Final" legs={currentApproach.finalLegs} />
              <LegTable label="Missed" legs={currentApproach.missedLegs} />
            </div>
          )}
        </div>
      )}

      <div className="debug-section">
        <button
          type="button"
          className="debug-section-toggle"
          onClick={() => setMrmsExpanded((v) => !v)}
          aria-expanded={mrmsExpanded}
        >
          <span className="debug-title">MRMS</span>
          <span className="debug-summary">
            {boolLabel(nexradDebug.enabled)} &middot; {nexradDebug.renderedVoxelCount} vox
            {nexradDebug.scanTime ? ` · ${formatScanAge(nexradDebug.scanTime)}` : ''}
          </span>
          <svg
            className={`debug-chevron${mrmsExpanded ? ' debug-chevron-open' : ''}`}
            width="10"
            height="10"
            viewBox="0 0 10 10"
            aria-hidden="true"
          >
            <path
              d="M2.5 3.5L5 6.5L7.5 3.5"
              stroke="currentColor"
              strokeWidth="1.3"
              fill="none"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
        {nexradDebug.error && <div className="debug-error">MRMS: {nexradDebug.error}</div>}
        {mrmsExpanded && (
          <div className="debug-section-body">
            <div className="debug-row">
              <span>Enabled</span>
              <span>{boolLabel(nexradDebug.enabled)}</span>
            </div>
            <div className="debug-row">
              <span>Loading</span>
              <span>{boolLabel(nexradDebug.loading)}</span>
            </div>
            <div className="debug-row">
              <span>Offload</span>
              <span>{nexradDebug.offloadMode || 'n/a'}</span>
            </div>
            <div className="debug-row">
              <span>Transport D/P</span>
              <span>
                {nexradDebug.decodeTransport || 'n/a'}/{nexradDebug.prepareTransport || 'n/a'}
              </span>
            </div>
            <div className="debug-row">
              <span>Worker Fail</span>
              <span>{nexradDebug.workerFailureStage || 'n/a'}</span>
            </div>
            <div className="debug-row">
              <span>Worker Fail At</span>
              <span>{formatTimestamp(nexradDebug.workerFailureAt)}</span>
            </div>
            {nexradDebug.workerFailureMessage && (
              <div className="debug-row debug-row-wrap">{nexradDebug.workerFailureMessage}</div>
            )}
            <div className="debug-row">
              <span>Poll Cycle</span>
              <span>{formatMs(nexradDebug.timingsMs.pollCycleMs)}</span>
            </div>
            <div className="debug-row">
              <span>Fetch V/E</span>
              <span>
                {formatMs(nexradDebug.timingsMs.volumeFetchMs)}/
                {formatMs(nexradDebug.timingsMs.echoTopFetchMs)}
              </span>
            </div>
            <div className="debug-row">
              <span>Decode V/E</span>
              <span>
                {formatMs(nexradDebug.timingsMs.volumeDecodeMs)}/
                {formatMs(nexradDebug.timingsMs.echoTopDecodeMs)}
              </span>
            </div>
            <div className="debug-row">
              <span>Prep V/E</span>
              <span>
                {formatMs(nexradDebug.timingsMs.volumePrepareMs)}/
                {formatMs(nexradDebug.timingsMs.echoTopPrepareMs)}
              </span>
            </div>
            <div className="debug-row">
              <span>Upload</span>
              <span>{formatMs(nexradDebug.timingsMs.instanceUploadMs)}</span>
            </div>
            <div className="debug-row">
              <span>Stale</span>
              <span>{boolLabel(nexradDebug.stale)}</span>
            </div>
            <div className="debug-row">
              <span>Layers</span>
              <span>{nexradDebug.layerCount}</span>
            </div>
            <div className="debug-row">
              <span>Voxels</span>
              <span>{nexradDebug.voxelCount}</span>
            </div>
            <div className="debug-row">
              <span>Rendered</span>
              <span>{nexradDebug.renderedVoxelCount}</span>
            </div>
            <div className="debug-row">
              <span>Phase R/M/S</span>
              <span>
                {nexradDebug.phaseCounts.rain}/{nexradDebug.phaseCounts.mixed}/
                {nexradDebug.phaseCounts.snow}
              </span>
            </div>
            <div className="debug-row">
              <span>Phase Mode</span>
              <span>{nexradDebug.phaseMode || 'n/a'}</span>
            </div>
            <div className="debug-row">
              <span>EchoTop Cells</span>
              <span>{nexradDebug.echoTopCellCount}</span>
            </div>
            <div className="debug-row">
              <span>EchoTop 18/30</span>
              <span>
                {formatFeet(nexradDebug.echoTopMax18Feet)}/
                {formatFeet(nexradDebug.echoTopMax30Feet)}
              </span>
            </div>
            <div className="debug-row">
              <span>EchoTop 50/60</span>
              <span>
                {formatFeet(nexradDebug.echoTopMax50Feet)}/
                {formatFeet(nexradDebug.echoTopMax60Feet)}
              </span>
            </div>
            <div className="debug-row">
              <span>Aux Age Z/R</span>
              <span>
                {formatAgeSeconds(nexradDebug.zdrAgeSeconds)}/
                {formatAgeSeconds(nexradDebug.rhohvAgeSeconds)}
              </span>
            </div>
            <div className="debug-row">
              <span>Aux Ts Z/R</span>
              <span>
                {formatTimestamp(nexradDebug.zdrTimestamp)}/
                {formatTimestamp(nexradDebug.rhohvTimestamp)}
              </span>
            </div>
            <div className="debug-row">
              <span>Legacy Ts P/F</span>
              <span>
                {formatTimestamp(nexradDebug.precipFlagTimestamp)}/
                {formatTimestamp(nexradDebug.freezingLevelTimestamp)}
              </span>
            </div>
            <div className="debug-row">
              <span>EchoTop Ts 18/30</span>
              <span>
                {formatTimestamp(nexradDebug.echoTop18Timestamp)}/
                {formatTimestamp(nexradDebug.echoTop30Timestamp)}
              </span>
            </div>
            <div className="debug-row">
              <span>EchoTop Ts 50/60</span>
              <span>
                {formatTimestamp(nexradDebug.echoTop50Timestamp)}/
                {formatTimestamp(nexradDebug.echoTop60Timestamp)}
              </span>
            </div>
            <div className="debug-row">
              <span>Scan</span>
              <span>{formatTimestamp(nexradDebug.scanTime)}</span>
            </div>
            <div className="debug-row">
              <span>Poll</span>
              <span>{formatTimestamp(nexradDebug.lastPollAt)}</span>
            </div>
            {nexradDebug.phaseDetail && (
              <div className="debug-row debug-row-wrap">{nexradDebug.phaseDetail}</div>
            )}
          </div>
        )}
      </div>

      <div className="debug-section">
        <button
          type="button"
          className="debug-section-toggle"
          onClick={() => setTrafficExpanded((v) => !v)}
          aria-expanded={trafficExpanded}
        >
          <span className="debug-title">Traffic</span>
          <span className="debug-summary">
            {boolLabel(trafficDebug.enabled)} &middot; {trafficDebug.renderedTrackCount} tracks
          </span>
          <svg
            className={`debug-chevron${trafficExpanded ? ' debug-chevron-open' : ''}`}
            width="10"
            height="10"
            viewBox="0 0 10 10"
            aria-hidden="true"
          >
            <path
              d="M2.5 3.5L5 6.5L7.5 3.5"
              stroke="currentColor"
              strokeWidth="1.3"
              fill="none"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
        {trafficDebug.error && <div className="debug-error">Traffic: {trafficDebug.error}</div>}
        {trafficExpanded && (
          <div className="debug-section-body">
            <div className="debug-row">
              <span>Enabled</span>
              <span>{boolLabel(trafficDebug.enabled)}</span>
            </div>
            <div className="debug-row">
              <span>Loading</span>
              <span>{boolLabel(trafficDebug.loading)}</span>
            </div>
            <div className="debug-row">
              <span>Offload</span>
              <span>{trafficDebug.offloadMode || 'n/a'}</span>
            </div>
            <div className="debug-row">
              <span>Feed</span>
              <span>{trafficDebug.feedTransport || 'n/a'}</span>
            </div>
            <div className="debug-row">
              <span>Transport</span>
              <span>{trafficDebug.workerTransport || 'n/a'}</span>
            </div>
            {trafficDebug.workerErrorReason && (
              <div className="debug-row debug-row-wrap">
                Worker Error: {trafficDebug.workerErrorReason}
              </div>
            )}
            <div className="debug-row">
              <span>Poll Cycle</span>
              <span>{formatMs(trafficDebug.timingsMs.pollCycleMs)}</span>
            </div>
            <div className="debug-row">
              <span>Fetch/Parse</span>
              <span>
                {formatMs(trafficDebug.timingsMs.fetchMs)}/
                {formatMs(trafficDebug.timingsMs.parseMs)}
              </span>
            </div>
            <div className="debug-row">
              <span>Process</span>
              <span>{formatMs(trafficDebug.timingsMs.processMs)}</span>
            </div>
            <div className="debug-row">
              <span>Recompute</span>
              <span>{formatMs(trafficDebug.timingsMs.recomputeMs)}</span>
            </div>
            <div className="debug-row">
              <span>Prune</span>
              <span>{formatMs(trafficDebug.timingsMs.pruneMs)}</span>
            </div>
            <div className="debug-row">
              <span>Worker RT/CPU</span>
              <span>
                {formatMs(trafficDebug.timingsMs.workerRoundTripMs)}/
                {formatMs(trafficDebug.timingsMs.workerProcessingMs)}
              </span>
            </div>
            <div className="debug-row">
              <span>Upload</span>
              <span>{formatMs(trafficDebug.timingsMs.markerUploadMs)}</span>
            </div>
            <div className="debug-row">
              <span>Backfill</span>
              <span>{boolLabel(trafficDebug.historyBackfillPending)}</span>
            </div>
            <div className="debug-row">
              <span>Tracks</span>
              <span>{trafficDebug.trackCount}</span>
            </div>
            <div className="debug-row">
              <span>Rendered</span>
              <span>{trafficDebug.renderedTrackCount}</span>
            </div>
            <div className="debug-row">
              <span>History Pts</span>
              <span>{trafficDebug.historyPointCount}</span>
            </div>
            <div className="debug-row">
              <span>Radius/Limit</span>
              <span>
                {trafficDebug.radiusNm} / {trafficDebug.limit}
              </span>
            </div>
            <div className="debug-row">
              <span>Poll</span>
              <span>{formatTimestamp(trafficDebug.lastPollAt)}</span>
            </div>
          </div>
        )}
      </div>
    </aside>
  );
}
