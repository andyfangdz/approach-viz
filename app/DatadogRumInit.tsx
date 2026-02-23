'use client';

import { useEffect } from 'react';
import { datadogRum } from '@datadog/browser-rum';

type RumWindow = Window & {
  __approachVizRumInitialized?: boolean;
};

const DATADOG_SITE = process.env.NEXT_PUBLIC_DD_SITE || 'datadoghq.com';
const RUM_APPLICATION_ID = process.env.NEXT_PUBLIC_DD_RUM_APPLICATION_ID;
const RUM_CLIENT_TOKEN = process.env.NEXT_PUBLIC_DD_RUM_CLIENT_TOKEN;
const RUM_SERVICE = process.env.NEXT_PUBLIC_DD_RUM_SERVICE || 'approach-viz-web';
const RUM_ENV = process.env.NEXT_PUBLIC_DD_RUM_ENV || process.env.NODE_ENV || 'development';
const RUM_VERSION =
  process.env.NEXT_PUBLIC_DD_RUM_VERSION || process.env.NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA;
const RUM_SESSION_SAMPLE_RATE = parseFloat(
  process.env.NEXT_PUBLIC_DD_RUM_SESSION_SAMPLE_RATE || '100'
);
const RUM_SESSION_REPLAY_SAMPLE_RATE = parseFloat(
  process.env.NEXT_PUBLIC_DD_RUM_SESSION_REPLAY_SAMPLE_RATE || '0'
);

function sampleRateOrDefault(value: number, fallback: number): number {
  if (!Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(0, Math.min(100, value));
}

export default function DatadogRumInit() {
  useEffect(() => {
    if (!RUM_APPLICATION_ID || !RUM_CLIENT_TOKEN) {
      return;
    }

    const appWindow = window as RumWindow;
    if (appWindow.__approachVizRumInitialized) {
      return;
    }

    datadogRum.init({
      applicationId: RUM_APPLICATION_ID,
      clientToken: RUM_CLIENT_TOKEN,
      site: DATADOG_SITE,
      service: RUM_SERVICE,
      env: RUM_ENV,
      version: RUM_VERSION,
      sessionSampleRate: sampleRateOrDefault(RUM_SESSION_SAMPLE_RATE, 100),
      sessionReplaySampleRate: sampleRateOrDefault(RUM_SESSION_REPLAY_SAMPLE_RATE, 0),
      trackUserInteractions: true,
      trackResources: true,
      trackLongTasks: true,
      defaultPrivacyLevel: 'mask-user-input',
      allowedTracingUrls: [
        (value: string | URL) => {
          try {
            const target =
              typeof value === 'string' ? new URL(value, window.location.origin) : value;
            return target.origin === window.location.origin;
          } catch {
            return false;
          }
        }
      ]
    });

    appWindow.__approachVizRumInitialized = true;
  }, []);

  return null;
}
