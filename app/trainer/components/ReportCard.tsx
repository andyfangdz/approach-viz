'use client';

import type { RunReport } from '../sim/types';

const OUTCOME_LABEL: Record<RunReport['outcome'], string> = {
  landed: 'Landed',
  'missed-complete': 'Missed approach flown',
  crashed: 'Terrain / minimums bust',
  aborted: 'Ended early'
};

function grade(report: RunReport): { label: string; tone: string } {
  if (report.outcome === 'crashed') return { label: 'Unsafe', tone: 'danger' };
  if (report.majorCount === 0 && report.minorCount === 0)
    return { label: 'Checkride standard', tone: 'good' };
  if (report.majorCount === 0) return { label: 'Good — minor cleanup', tone: 'good' };
  if (report.majorCount <= 2) return { label: 'Needs work', tone: 'warn' };
  return { label: 'Below standard', tone: 'danger' };
}

export function ReportCard({
  report,
  showAdvice,
  onRestart,
  onNewApproach
}: {
  report: RunReport;
  showAdvice: boolean;
  onRestart: () => void;
  onNewApproach: () => void;
}) {
  const g = grade(report);
  const minutes = Math.floor(report.durationSec / 60);
  const seconds = Math.round(report.durationSec % 60);

  return (
    <div className="tr-report-backdrop">
      <div className="tr-report" role="dialog" aria-label="Approach debrief">
        <div className="tr-report-head">
          <div>
            <div className="tr-report-title">Debrief</div>
            <div className="tr-report-sub">
              {report.airportId} · {report.procedureId} · {report.transitionName}
            </div>
          </div>
          <div className={`tr-report-grade tone-${g.tone}`}>{g.label}</div>
        </div>

        <div className="tr-report-stats">
          <div>
            <span className="tr-stat-value">{OUTCOME_LABEL[report.outcome]}</span>
            <span className="tr-stat-label">Outcome</span>
          </div>
          <div>
            <span className="tr-stat-value">{report.majorCount}</span>
            <span className="tr-stat-label">Major faults</span>
          </div>
          <div>
            <span className="tr-stat-value">{report.minorCount}</span>
            <span className="tr-stat-label">Minor faults</span>
          </div>
          <div>
            <span className="tr-stat-value">
              {minutes}:{String(seconds).padStart(2, '0')}
            </span>
            <span className="tr-stat-label">Duration</span>
          </div>
        </div>

        <div className="tr-report-events">
          {report.events.filter((e) => e.severity !== 'info').length === 0 ? (
            <div className="tr-report-clean">No faults logged — nicely flown.</div>
          ) : (
            report.events
              .filter((e) => e.severity !== 'info')
              .map((event, i) => (
                <div key={i} className={`tr-report-event sev-${event.severity}`}>
                  <div className="tr-report-event-head">
                    <span className="tr-report-event-time">{formatTime(event.timeSec)}</span>
                    <span className="tr-report-event-msg">{event.message}</span>
                  </div>
                  {showAdvice && event.advice && (
                    <div className="tr-report-event-advice">{event.advice}</div>
                  )}
                </div>
              ))
          )}
        </div>

        <div className="tr-report-actions">
          <button type="button" className="tr-btn tr-btn-primary" onClick={onRestart}>
            Fly again
          </button>
          <button type="button" className="tr-btn tr-btn-ghost" onClick={onNewApproach}>
            New approach
          </button>
        </div>
      </div>
    </div>
  );
}

function formatTime(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}
