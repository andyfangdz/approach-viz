# Validation Expectations

Checklist for verifying parser, render, and data-logic changes.

## Automated Steps

Run in order after any parser/render/data change:

1. `npm run prepare-data` — download fresh FAA/CIFP + airspace + minimums data and rebuild SQLite.
2. `npm run test` — full test suite (parser + geometry).
3. `npm run test:parser` — especially after `src/cifp/parser.ts` changes.
4. `npm run test:geometry` — for path/curve/runway/coordinate geometry changes.
5. `npm run build` — production build (also refreshes data).

## Manual Spot-Checks

After a successful build, visually verify at least one procedure exercising each of these features:

- RF leg(s)
- AF / DME arc leg(s)
- Hold leg(s)
- Missed approach with CA / DF / HM
- Glidepath inside FAF

## Minima/Plate-Only Procedure Checks

- Verify at least one minima/plate-only procedure (e.g. `KPOU VOR-A`) appears in the selector list, shows minimums + plate, and indicates geometry is unavailable from CIFP.
- Verify the legend remains concise for these procedures (geometry-unavailable status shown in the minimums section, not as long legend copy).
