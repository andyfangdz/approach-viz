import type { TrainerMode, WeatherScenario } from './sim/types';

export interface ModeInfo {
  id: TrainerMode;
  label: string;
  blurb: string;
  pilotControlled: boolean;
  showAdvice: boolean;
  showBugsGuidance: boolean;
}

/** Training modes mirror pilotapproach.com's progression from demo to test. */
export const TRAINER_MODES: ModeInfo[] = [
  {
    id: 'ai',
    label: 'AI Demo',
    blurb: 'The computer flies the approach so you can watch how it is done.',
    pilotControlled: false,
    showAdvice: true,
    showBugsGuidance: true
  },
  {
    id: 'training',
    label: 'Training',
    blurb: 'You fly with full guidance: advice and mistake explanations for each segment.',
    pilotControlled: true,
    showAdvice: true,
    showBugsGuidance: true
  },
  {
    id: 'practice',
    label: 'Practice',
    blurb: 'You fly without instructions. Mistakes are logged, but not explained in real time.',
    pilotControlled: true,
    showAdvice: false,
    showBugsGuidance: false
  },
  {
    id: 'testing',
    label: 'Testing',
    blurb: 'No assistance and no feedback until the debrief. Fly it like a checkride.',
    pilotControlled: true,
    showAdvice: false,
    showBugsGuidance: false
  }
];

export function modeInfo(mode: TrainerMode): ModeInfo {
  return TRAINER_MODES.find((m) => m.id === mode) ?? TRAINER_MODES[1];
}

export interface WeatherInfo extends WeatherScenario {
  id: string;
}

/** Ceiling scenarios (AGL). Below the ceiling near the runway → runway in sight. */
export const WEATHER_SCENARIOS: WeatherInfo[] = [
  { id: 'vmc', label: 'VMC — 3000′ ceiling', ceilingFtAgl: 3000 },
  { id: 'mvfr', label: 'MVFR — 1500′ ceiling', ceilingFtAgl: 1500 },
  { id: 'ifr', label: 'IFR — 600′ ceiling', ceilingFtAgl: 600 },
  { id: 'lifr', label: 'LIFR — 200′ ceiling (missed likely)', ceilingFtAgl: 200 }
];

export function weatherInfo(id: string): WeatherInfo {
  return WEATHER_SCENARIOS.find((w) => w.id === id) ?? WEATHER_SCENARIOS[0];
}
