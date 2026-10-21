import { useEffect, useState } from 'react';
import type { TraconScopeSettings } from '../types';
import { formatAltitudeFilter } from '@/app/scene/tracon/data-block';

function formatZuluTime(date: Date): string {
  const hh = String(date.getUTCHours()).padStart(2, '0');
  const mm = String(date.getUTCMinutes()).padStart(2, '0');
  const ss = String(date.getUTCSeconds()).padStart(2, '0');
  return `${hh}${mm}/${ss}`;
}

/** `WX: (1)(2) 3` style: available levels, selected ones in parentheses. */
function formatWxLine(levels: readonly boolean[], availableLevels: number): string {
  if (availableLevels === 0) return 'WX: NONE';
  const parts: string[] = [];
  for (let level = 1; level <= availableLevels; level += 1) {
    parts.push(levels[level - 1] ? `(${level})` : ` ${level} `);
  }
  return `WX: ${parts.join('').trim()}`;
}

/**
 * STARS system status area: the red-capability triangle, Zulu time,
 * range and PTL length, the altitude filter limits, and available weather
 * levels, with the ADS-B feed status where STARS shows its network status.
 * Lines that STARS fills from sources this app does not have (altimeters)
 * are left out rather than invented.
 */
export function StarsSsa({
  settings,
  wxAvailableLevels,
  showWeather,
  trackCount,
  trafficError
}: {
  settings: TraconScopeSettings;
  wxAvailableLevels: number;
  showWeather: boolean;
  trackCount: number | null;
  trafficError: string | null;
}) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="stars-ssa" aria-label="System status">
      <div className="stars-ssa-triangle" aria-hidden="true" />
      <div>{formatZuluTime(now)}</div>
      <div>
        {settings.rangeNm} PTL: {settings.ptlMinutes.toFixed(1)}
      </div>
      <div>
        {formatAltitudeFilter({ lowFeet: null, highFeet: settings.altitudeFilterHighFeet })}
      </div>
      {showWeather && <div>{formatWxLine(settings.wxLevels, wxAvailableLevels)}</div>}
      {trafficError ? (
        <div className="stars-ssa-alert">ADS-B NA</div>
      ) : (
        trackCount !== null && <div>ADS-B {trackCount}</div>
      )}
    </div>
  );
}
