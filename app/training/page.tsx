import { loadSceneDataAction } from '@/app/actions';
import { TrainingClient } from './TrainingClient';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export default async function TrainingPage() {
  const scene = await loadSceneDataAction('KTEB', 'R06-Y');
  if (!scene.airport || !scene.currentApproach || scene.selectedApproachId !== 'R06-Y')
    throw new Error('Required KTEB/R06-Y training procedure is missing from the current database.');
  return (
    <TrainingClient
      airport={scene.airport}
      approach={scene.currentApproach}
      waypoints={scene.waypoints}
    />
  );
}
