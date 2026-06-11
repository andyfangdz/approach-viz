'use client';

import { useCallback, useEffect, useRef, useState, useTransition } from 'react';
import { listAirportsAction, loadSceneDataAction } from '@/app/actions';
import type { AirportOption, SceneData } from '@/lib/types';

export const SELECTION_STORAGE_KEY = 'approach-viz:last-selection';

interface UseSceneSelectionParams {
  initialAirportOptions: AirportOption[];
  initialSceneData: SceneData;
  initialAirportId: string;
  initialApproachId: string;
  isDefaultRoute: boolean;
}

/**
 * Airport/approach selection and scene-data fetching: option-list loading,
 * stale-response-safe scene requests, prop resync, and last-selection restore
 * on the default route.
 */
export function useSceneSelection({
  initialAirportOptions,
  initialSceneData,
  initialAirportId,
  initialApproachId,
  isDefaultRoute
}: UseSceneSelectionParams) {
  const [airportOptions, setAirportOptions] = useState<AirportOption[]>(initialAirportOptions);
  const [airportOptionsLoading, setAirportOptionsLoading] = useState(
    initialAirportOptions.length === 0
  );
  const [sceneData, setSceneData] = useState<SceneData>(initialSceneData);
  const [selectedAirport, setSelectedAirport] = useState<string>(
    initialSceneData.airport?.id ?? initialAirportId
  );
  const [selectedApproach, setSelectedApproach] = useState<string>(
    initialSceneData.selectedApproachId || initialApproachId
  );
  const [loading, setLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string>('');
  const [isPending, startTransition] = useTransition();
  const requestCounter = useRef(0);

  // Restore last-selected airport/approach on the default route.
  useEffect(() => {
    if (typeof window === 'undefined' || !isDefaultRoute) return;
    let target: { airportId: string; approachId: string } | null = null;
    try {
      const raw = window.localStorage.getItem(SELECTION_STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (
          typeof parsed.airportId === 'string' &&
          parsed.airportId.length > 0 &&
          typeof parsed.approachId === 'string'
        ) {
          target = parsed;
        }
      }
    } catch {
      // corrupt or missing — keep server-provided default selection
    }
    if (!target) {
      return;
    }
    // Skip fetch if server already loaded the exact airport+approach
    if (
      target.airportId === initialAirportId &&
      (!target.approachId || target.approachId === initialApproachId)
    ) {
      return;
    }
    setLoading(true);
    loadSceneDataAction(target.airportId, target.approachId)
      .then((nextSceneData) => {
        if (!nextSceneData.airport) {
          setLoading(false);
          return;
        }
        setSceneData(nextSceneData);
        setSelectedAirport(nextSceneData.airport?.id ?? target.airportId);
        setSelectedApproach(nextSceneData.selectedApproachId || target.approachId);
        setLoading(false);
      })
      .catch(() => {
        setLoading(false);
      });
    // Mount-only: mirrors the original single init effect.
  }, []);

  // Resync when server-provided props change (route navigation).
  useEffect(() => {
    setSceneData(initialSceneData);
    setSelectedAirport(initialSceneData.airport?.id ?? initialAirportId);
    setSelectedApproach(initialSceneData.selectedApproachId || initialApproachId);
  }, [initialSceneData, initialAirportId, initialApproachId]);

  useEffect(() => {
    if (airportOptions.length > 0) return;
    setAirportOptionsLoading(true);
    startTransition(() => {
      listAirportsAction()
        .then((nextOptions) => {
          setAirportOptions(nextOptions);
          setAirportOptionsLoading(false);
        })
        .catch(() => {
          setAirportOptionsLoading(false);
        });
    });
  }, [airportOptions.length, startTransition]);

  const requestSceneData = useCallback(
    (airportId: string, procedureId: string, onRequestStart?: () => void) => {
      const nextRequestId = requestCounter.current + 1;
      requestCounter.current = nextRequestId;
      setLoading(true);
      setErrorMessage('');
      onRequestStart?.();

      startTransition(() => {
        loadSceneDataAction(airportId, procedureId)
          .then((nextSceneData) => {
            if (requestCounter.current !== nextRequestId) return;
            setSceneData(nextSceneData);
            setSelectedAirport(nextSceneData.airport?.id ?? airportId);
            setSelectedApproach(nextSceneData.selectedApproachId || '');
            setLoading(false);
          })
          .catch(() => {
            if (requestCounter.current !== nextRequestId) return;
            setLoading(false);
            setErrorMessage('Unable to load airport data.');
          });
      });
    },
    [startTransition]
  );

  return {
    airportOptions,
    airportOptionsLoading,
    sceneData,
    selectedAirport,
    setSelectedAirport,
    selectedApproach,
    setSelectedApproach,
    loading,
    errorMessage,
    isPending,
    requestSceneData
  };
}
