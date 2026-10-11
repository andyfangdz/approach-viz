'use client';

import { SimulatorPanel } from '@/app/proc-sim/SimulatorPanel';
import type { Airport, Waypoint } from '@/lib/cifp/parser';
import type { SerializedApproach } from '@/lib/types';
import './training.css';

export function TrainingClient({
  airport,
  approach,
  waypoints
}: {
  airport: Airport;
  approach: SerializedApproach;
  waypoints: Waypoint[];
}) {
  return (
    <main className="training-page">
      <nav aria-label="Training navigation">
        <a href="/KTEB/R06-Y">← Approach visualization</a>
        <span>APPROACHVIZ / TRAINING</span>
      </nav>
      <SimulatorPanel
        approach={{ ...approach, transitions: new Map(approach.transitions) }}
        waypoints={new Map(waypoints.map((point) => [point.id, point]))}
        magVar={airport.magVar}
        frame={{ refLat: airport.lat, refLon: airport.lon, verticalScale: 1, curvature: false }}
      />
    </main>
  );
}
