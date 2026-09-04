'use client';

import { useCallback, useEffect, useRef, useState, useTransition } from 'react';
import { listAirportsAction, loadSceneDataAction } from '@/app/actions';
import { isJsonObject, isNonEmptyString, isString, parseJsonValue } from '@/lib/parse-like';
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
            if (!nextSceneData.airport) throw new Error('Airport not found.');
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

  const initialRoute = useRef({ initialSceneData, initialAirportId, initialApproachId });
  const navigated = useRef(false);
  // Navigation and unmount invalidate every request, including saved-selection restore.
  useEffect(() => {
    if (
      initialSceneData !== initialRoute.current.initialSceneData ||
      initialAirportId !== initialRoute.current.initialAirportId ||
      initialApproachId !== initialRoute.current.initialApproachId
    )
      navigated.current = true;
    requestCounter.current += 1;
    setSceneData(initialSceneData);
    setSelectedAirport(initialSceneData.airport?.id ?? initialAirportId);
    setSelectedApproach(initialSceneData.selectedApproachId || initialApproachId);
    setLoading(false);
    setErrorMessage('');
    return () => {
      requestCounter.current += 1;
    };
  }, [initialSceneData, initialAirportId, initialApproachId]);

  // Restore last-selected airport/approach on the default route.
  useEffect(() => {
    if (
      globalThis.window === undefined ||
      !isDefaultRoute ||
      navigated.current ||
      initialSceneData !== initialRoute.current.initialSceneData ||
      initialAirportId !== initialRoute.current.initialAirportId ||
      initialApproachId !== initialRoute.current.initialApproachId
    )
      return;
    let target: { airportId: string; approachId: string } | null = null;
    try {
      const raw = window.localStorage.getItem(SELECTION_STORAGE_KEY);
      if (raw) {
        const parsed = parseJsonValue(raw);
        if (
          isJsonObject(parsed) &&
          isNonEmptyString(parsed.airportId) &&
          isString(parsed.approachId)
        ) {
          target = { airportId: parsed.airportId, approachId: parsed.approachId };
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
    requestSceneData(target.airportId, target.approachId);
  }, [initialSceneData, initialAirportId, initialApproachId, isDefaultRoute, requestSceneData]);

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
          setErrorMessage('Unable to load airport list.');
          setAirportOptionsLoading(false);
        });
    });
  }, [airportOptions.length, startTransition]);

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
