import type { SelectOption } from '@/app/app-client-utils';

const MAX_PICKER_RESULTS = 80;

interface FilterRequestMessage {
  requestId: number;
  options: SelectOption[];
  query: string;
}

interface FilterResponseMessage {
  requestId: number;
  filteredOptions?: SelectOption[];
  error?: string;
}

function normalizeQuery(value: string): string {
  return value.trim().toLowerCase();
}

function filterOptions(options: SelectOption[], query: string): SelectOption[] {
  const normalized = normalizeQuery(query);
  if (!normalized) {
    return options.slice(0, MAX_PICKER_RESULTS);
  }
  return options
    .filter((option) => option.searchText.includes(normalized))
    .slice(0, MAX_PICKER_RESULTS);
}

const scope = self as unknown as {
  postMessage: (message: FilterResponseMessage) => void;
  onmessage: ((event: MessageEvent<FilterRequestMessage>) => void) | null;
};

scope.onmessage = (event) => {
  try {
    scope.postMessage({
      requestId: event.data.requestId,
      filteredOptions: filterOptions(event.data.options, event.data.query)
    });
  } catch (error) {
    scope.postMessage({
      requestId: event.data.requestId,
      error: error instanceof Error ? error.message : 'Filter worker failed.'
    });
  }
};

export {};
