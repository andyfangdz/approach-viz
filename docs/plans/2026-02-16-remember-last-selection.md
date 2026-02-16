# Remember Last Selected Airport/Approach — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Persist the user's last-viewed airport/approach to localStorage and restore it when they visit `/` without explicit URL params.

**Architecture:** New localStorage key `'approach-viz:last-selection'` written on every airport/approach change, read on mount when `isDefaultRoute` is true. A `DEFAULT_SELECTIONS` constant provides the fallback for first-time visitors.

**Tech Stack:** Next.js App Router, React, TypeScript, localStorage

---

### Task 1: Add `DEFAULT_SELECTIONS` and `isDefaultRoute` prop threading

**Files:**

- Modify: `app/route-page.tsx`
- Modify: `app/page.tsx`
- Modify: `app/AppClient.tsx` (props interface + destructuring only)

**Step 1: Add `DEFAULT_SELECTIONS` to `route-page.tsx`**

In `app/route-page.tsx`, after the `DEFAULT_AIRPORT_ID` line (line 4), add:

```ts
export const DEFAULT_SELECTIONS = [{ airportId: 'KCDW', approachId: 'L22' }];
```

**Step 2: Add `isDefaultRoute` prop to `renderScenePage` and `AppClient`**

In `app/route-page.tsx`, add an `isDefaultRoute` parameter to `renderScenePage` (default `false`) and pass it through to `<AppClient>`:

```ts
export async function renderScenePage(
  airportIdParam?: string,
  procedureIdParam?: string,
  isDefaultRoute = false
) {
```

Add to the JSX: `isDefaultRoute={isDefaultRoute}`.

**Step 3: Pass `isDefaultRoute={true}` from root `page.tsx`**

In `app/page.tsx`, change:

```ts
return renderScenePage(DEFAULT_AIRPORT_ID, '', true);
```

**Step 4: Add `isDefaultRoute` to `AppClientProps`**

In `app/AppClient.tsx`, add to the `AppClientProps` interface:

```ts
isDefaultRoute?: boolean;
```

Add to the destructuring at line 212–217:

```ts
isDefaultRoute = false;
```

**Step 5: Run typecheck**

Run: `npm run typecheck`
Expected: PASS (new prop is optional with default, no consumers break)

**Step 6: Commit**

```
feat: add DEFAULT_SELECTIONS and isDefaultRoute prop threading
```

---

### Task 2: Write last selection to localStorage on navigation

**Files:**

- Modify: `app/AppClient.tsx` (URL-sync effect, ~lines 459–494)

**Step 1: Add the storage key constant**

Near `OPTIONS_STORAGE_KEY` (line 92), add:

```ts
const SELECTION_STORAGE_KEY = 'approach-viz:last-selection';
```

**Step 2: Write selection in the URL-sync effect**

In the existing `useEffect` that calls `window.history.replaceState` (~line 459), add a localStorage write at the end, before the closing `}` of the effect body, after the replaceState call:

```ts
try {
  window.localStorage.setItem(
    SELECTION_STORAGE_KEY,
    JSON.stringify({ airportId: selectedAirport, approachId: selectedApproach })
  );
} catch {
  // localStorage full or unavailable — silently ignore
}
```

This writes on every airport/approach/layer change since those are all deps of the effect. That's fine — the write is cheap and idempotent.

**Step 3: Run typecheck + lint**

Run: `npm run typecheck && npm run lint`
Expected: PASS

**Step 4: Commit**

```
feat: persist last airport/approach selection to localStorage
```

---

### Task 3: Restore last selection on mount for default route

**Files:**

- Modify: `app/AppClient.tsx` (localStorage init effect, ~lines 287–397)
- Modify: `app/route-page.tsx` (export `DEFAULT_SELECTIONS` — already done in Task 1)

**Step 1: Import `DEFAULT_SELECTIONS`**

At top of `app/AppClient.tsx`, add to the import from `@/app/route-page`:

Wait — `route-page.tsx` is a server file and `AppClient.tsx` is `'use client'`. We can't import from a server component into a client component in Next.js App Router. Instead, define `DEFAULT_SELECTIONS` in `AppClient.tsx` directly (or in `app-client/constants.ts`). Move the constant:

In `app/route-page.tsx`, remove `DEFAULT_SELECTIONS` (it was added in Task 1). Instead, add it to `app/AppClient.tsx` near the top, after `SELECTION_STORAGE_KEY`:

```ts
const DEFAULT_SELECTIONS = [{ airportId: 'KCDW', approachId: 'L22' }];
```

**Step 2: Add restoration logic**

Add a new `useEffect` after the existing localStorage init effect (after line 397) and before the options-persist effect (line 399). This effect runs once on mount, only when `isDefaultRoute` is true and after storage init is done:

```ts
useEffect(() => {
  if (!isDefaultRoute || typeof window === 'undefined') return;
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
    // corrupt or missing — fall through to defaults
  }
  if (!target) {
    target = DEFAULT_SELECTIONS[Math.floor(Math.random() * DEFAULT_SELECTIONS.length)];
  }
  // If the server already loaded the right airport+approach, skip the fetch
  if (
    target.airportId === selectedAirport &&
    (target.approachId === selectedApproach || (!target.approachId && !selectedApproach))
  ) {
    return;
  }
  // Trigger client-side fetch for remembered selection
  setSelectedAirport(target.airportId);
  setSelectedApproach(target.approachId);
  requestSceneData(target.airportId, target.approachId);
  // eslint-disable-next-line react-hooks/exhaustive-deps
}, [isDefaultRoute]);
```

Note: The `eslint-disable` is needed because we intentionally read `selectedAirport`/`selectedApproach` at mount time only, not on every change. This is the polling refs pattern — but since we only need the initial values and this runs once, excluding from deps is correct. React Compiler may add deps; we should use refs if needed. Actually, since this fires once on mount (`isDefaultRoute` is a static prop), the values of `selectedAirport` and `selectedApproach` will be their initial values. The simpler approach: compare against the initial props instead:

```ts
useEffect(() => {
  if (!isDefaultRoute || typeof window === 'undefined') return;
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
    // corrupt or missing — fall through to defaults
  }
  if (!target) {
    target = DEFAULT_SELECTIONS[Math.floor(Math.random() * DEFAULT_SELECTIONS.length)];
  }
  // If the server already loaded the right airport+approach, just set the approach
  if (target.airportId === initialAirportId) {
    if (target.approachId && target.approachId !== initialApproachId) {
      setSelectedApproach(target.approachId);
      requestSceneData(target.airportId, target.approachId);
    } else if (target.approachId && !initialApproachId) {
      // Server loaded airport but no approach; select remembered approach
      setSelectedApproach(target.approachId);
      requestSceneData(target.airportId, target.approachId);
    }
    return;
  }
  // Different airport — full fetch
  setSelectedAirport(target.airportId);
  setSelectedApproach(target.approachId);
  requestSceneData(target.airportId, target.approachId);
}, [isDefaultRoute, initialAirportId, initialApproachId, requestSceneData]);
```

This version uses only props and the stable `requestSceneData` callback as deps, which is safe with React Compiler.

**Step 3: Run typecheck + lint + test**

Run: `npm run typecheck && npm run lint && npm run test`
Expected: PASS

**Step 4: Commit**

```
feat: restore last airport/approach selection on default route
```

---

### Task 4: Update documentation

**Files:**

- Modify: `docs/ui-url-state-and-mobile.md`
- Modify: `AGENTS.md`

**Step 1: Add localStorage section to `docs/ui-url-state-and-mobile.md`**

After the "All options-panel and layer values are persisted..." line (line 41), add:

```markdown
### Last Selection Persistence

- On every airport/approach change, the selection is written to `localStorage` under key `'approach-viz:last-selection'` as `{ airportId, approachId }`.
- When visiting `/` (no airport/approach in URL), the client reads this key and loads the remembered selection. If absent or invalid, a random entry from `DEFAULT_SELECTIONS` (currently only `KCDW/L22`) is used.
- The URL is updated via `replaceState` to reflect the restored selection, making it shareable.
```

**Step 2: Update AGENTS.md UI section**

In the UI, URL State, and Mobile summary paragraph, append mention of last-selection persistence.

**Step 3: Run format check**

Run: `npm run format:check`
Expected: PASS (or fix formatting)

**Step 4: Commit**

```
docs: document last-selection localStorage persistence
```

---

### Task 5: Verify end-to-end + final CI

**Step 1: Run full CI check**

Run: `npm run format:check && npm run typecheck && npm run lint && npm run test`
Expected: All PASS

**Step 2: Manual smoke test (if dev server available)**

1. Visit `/` — should load KCDW/L22 (default)
2. Navigate to a different airport/approach
3. Refresh page at `/` — should restore last selection
4. Clear localStorage, visit `/` — should fall back to KCDW/L22
5. Visit `/KJFK/I04L` directly — should load that (not override with remembered)

**Step 3: Final commit if any fixups needed**
