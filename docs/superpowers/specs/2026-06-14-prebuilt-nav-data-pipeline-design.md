# Prebuilt Nav-Data Publish-and-Pin Pipeline

**Date:** 2026-06-14
**Status:** Design — awaiting review
**Repo:** `andyfangdz/approach-viz`

## Problem

Every Vercel build (`npm run build` → `build:sw && prepare-data && next build`) runs
`prepare-data`, which fetches three external sources at deploy time:

1. `approaches.json` — latest GitHub Release of `andyfangdz/faa-instrument-approach-db`
2. CIFP `FAACIFP18` — `aeronav.faa.gov` (the genuinely fragile FAA endpoint)
3. Class B/C/D airspace GeoJSON — `raw.githubusercontent.com` (pinned commit)

…then runs `build-db.ts` to produce `data/approach-viz.sqlite` (67 MB). Any transient
upstream failure (e.g. an `api.github.com` 504, observed during PR #49 / commit
d28c901) fails the entire deploy. GitHub Actions CI avoids this by compiling with
`npx next build` only — but Vercel must produce a working DB, so it cannot skip the
data step. (A prior change already added `curl_retry` backoff to `download-data.sh`;
this design removes the fetch from the deploy path entirely.)

The runtime SQLite DB is required (opened read-only by `lib/db.ts` with
`fileMustExist: true`, traced into serverless functions via
`outputFileTracingIncludes`) and is a generated, git-ignored artifact, so it must be
produced somewhere before deploy.

## Goal

Move all FAA/source fetching and DB building out of the Vercel deploy path. A
scheduled job builds the DB once and publishes it to GitHub Releases; the Vercel
build (and local dev) only downloads a **prebuilt DB pinned to an exact release tag**
in the repo.

## Chosen options (confirmed with user)

- **Artifact:** final built `approach-viz.sqlite` (gzipped, ~10.4 MB — smaller than
  the ~11.8 MB raw-source bundle, and lets the consumer skip `build-db` entirely).
- **Versioning:** pinned exact tag committed in the repo (reproducible deploys).
- **Publisher:** new scheduled GitHub Action **in this repo**, running **daily** plus
  manual dispatch.
- **(a) Schema drift:** **fail loudly** (no silent fallback), per the repo's
  "fail loudly over silent fallbacks" principle.
- **(b) Pin updates:** publisher **opens an auto-PR** bumping the pin.
- **(c) Idempotency:** tag fully encodes the dataset identity; **skip if the tag
  already exists**.

## Architecture

Two halves that never run on the same machine.

```
┌─────────────────────────── PUBLISHER (GitHub Actions) ───────────────────────────┐
│ daily cron + workflow_dispatch                                                     │
│   download-data.sh  →  FAACIFP18, approaches.json, airspace/*.geojson              │
│   build-db.ts       →  data/approach-viz.sqlite  (writes metadata.schema_version)  │
│   compute tag = data-<cifp_cycle>-<dtpp_cycle>-s<schemaVersion>                    │
│   if release tag exists → skip (no-op)                                             │
│   else gzip DB, write manifest.json, create Release, open auto-PR bumping pin      │
└───────────────────────────────────────────────────────────────────────────────────┘
                                       │  GitHub Release assets
                                       ▼
                  approach-viz.sqlite.gz   +   manifest.json
                                       │
┌──────────────────────── CONSUMER (Vercel build + npm run dev) ───────────────────┐
│   fetch-data.sh                                                                    │
│     read tag from data-version.json                                               │
│     curl_retry  https://github.com/andyfangdz/approach-viz/releases/download/      │
│                 <tag>/{manifest.json,approach-viz.sqlite.gz}   (direct CDN, no API)│
│     verify gz sha256 == manifest.gzSha256                                          │
│     gunzip → data/approach-viz.sqlite                                              │
│     verify-db.mjs: DB metadata.schema_version == scripts/data-schema-version.json  │
│   next build                                                                       │
└───────────────────────────────────────────────────────────────────────────────────┘
```

**Key property:** because the consumer pins an *exact* tag, it downloads via the
public direct asset URL (`/releases/download/<tag>/<asset>`), which is CDN-backed,
unauthenticated, and makes **zero `api.github.com` calls** — sidestepping the exact
rate-limit/504 class that triggered this work.

## Components

### 1. `scripts/data-schema-version.json` (new, committed)

Single shared source of truth for the DB schema version, readable from both TS and
shell:

```json
{ "schemaVersion": 1 }
```

Whoever changes the DB schema (tables/columns/serialized JSON shape in `build-db.ts`)
**must bump this number**. Documented discipline; enforced operationally by the
consumer schema guard failing loudly on mismatch.

### 2. `scripts/build-db.ts` (modified)

- Import `schemaVersion` from `data-schema-version.json`.
- Write `insertMetadata.run('schema_version', String(schemaVersion))`.

No other behavior change.

### 3. `data-version.json` (new, committed, repo root)

The pin. (`data/` is fully git-ignored, so the pin lives at repo root.)

```json
{ "tag": "data-2506-2505-s1" }
```

### 4. `scripts/verify-db.mjs` (new)

Opens a SQLite DB read-only (better-sqlite3, already a dependency), reads
`metadata.schema_version`, compares to `scripts/data-schema-version.json`. Exits
non-zero with an explicit message on mismatch or missing key. Usage:
`node scripts/verify-db.mjs <db-path>`. Unit-testable against fixtures.

### 5. `scripts/fetch-data.sh` (new)

Consumer download path. Reuses the `curl_retry` helper pattern.

1. Read `tag` from `data-version.json` (fail loudly if missing/malformed).
2. Build base URL `https://github.com/andyfangdz/approach-viz/releases/download/<tag>`.
   (Override owner/repo via `APPROACH_VIZ_DATA_REPO` env for forks; `GITHUB_TOKEN`
   used only if the repo is private — public assets need no auth.)
3. `curl_retry` `manifest.json` and `approach-viz.sqlite.gz`.
4. Verify gz sha256 == `manifest.gzSha256` (fail loudly on mismatch).
5. `mkdir -p data`, gunzip → `data/approach-viz.sqlite`.
6. `node scripts/verify-db.mjs data/approach-viz.sqlite` (schema guard).

On any failure the build stops; the schema-mismatch message instructs: "manually
dispatch the `publish-data` workflow on this branch and bump `data-version.json`, or
run `npm run prepare-data` to build from source."

### 6. `.github/workflows/publish-data.yml` (new)

```
on:
  schedule: [{ cron: "0 9 * * *" }]   # daily ~09:00 UTC
  workflow_dispatch:
permissions:
  contents: write          # create releases, commit pin branch
  pull-requests: write     # open auto-PR
```

Steps:

1. Checkout, setup Node 22, `npm ci`.
2. `npm run prepare-data` (env `GITHUB_TOKEN: ${{ github.token }}` for the
   `api.github.com` release lookup, matching the existing macOS workflow).
3. Read `cifp_cycle`, `dtpp_cycle_number`, `schema_version` from the built DB's
   `metadata` table via a small node read (`verify-db.mjs` validates schema on the
   consumer side; the publisher only needs to *extract* these values for the tag).
4. Compute `TAG=data-<cifp>-<dtpp>-s<schema>`.
5. If a release with `TAG` already exists (`gh release view`) → **exit 0 (no-op)**.
6. Else: gzip DB; write `manifest.json`
   `{ tag, schemaVersion, cifpCycle, dtppCycle, gzSha256, dbSha256, builtAt }`;
   `gh release create "$TAG" approach-viz.sqlite.gz manifest.json`.
7. Open/refresh an auto-PR that sets `data-version.json` `tag` to `$TAG`
   (e.g. `peter-evans/create-pull-request`).

Idempotency is purely tag-existence: `(cifp_cycle, dtpp_cycle, schema_version)` fully
identifies the dataset (airspace is a pinned commit; `dtpp_cycle_number` identifies
`approaches.json`; CIFP cycle identifies `FAACIFP18`). Daily runs are no-ops until the
FAA cycle rolls (~every 28 days) or the schema is bumped.

> **Note on auto-PR + CI:** PRs created with the default `GITHUB_TOKEN` do not trigger
> the `on: pull_request` CI workflow. If CI must run on the bump PR before merge,
> supply a fine-grained PAT secret to the create-pull-request step; otherwise CI runs
> on merge. Acceptable either way — the pin bump only changes one JSON value and the
> consuming build is exercised by the bump PR's Vercel preview deploy.

### 7. `package.json` (modified)

- `"fetch-data": "bash scripts/fetch-data.sh"`
- `"build": "npm run build:sw && npm run fetch-data && next build"` (was `prepare-data`)
- `"dev": "npm run build:sw && { [ -f data/approach-viz.sqlite ] || npm run fetch-data; } && node scripts/dev-with-ddtrace.mjs"` (was `prepare-data`)
- `prepare-data`, `download-data`, `build-db` **unchanged** — still used by the
  publisher and as the local "build fresh from FAA" escape hatch.

`vercel.json` is unchanged (`buildCommand` stays `npm run build`).

## Data flow summary

- **Normal deploy:** read pin → download 1 gzipped file from CDN → verify → unpack →
  `next build`. No FAA endpoints, no `api.github.com`, no `build-db`.
- **New FAA cycle:** daily publisher detects new cycle → cuts release → auto-PR bumps
  pin → merge → subsequent deploys serve new data.
- **Schema change (PR):** author bumps `data-schema-version.json`; manually dispatches
  `publish-data` on the branch (new `-s<n>` tag); bumps `data-version.json` in the same
  PR; preview deploy validates end-to-end. Without that, the build fails loudly rather
  than shipping a mismatched DB.

## Error handling

- Missing/malformed pin file, download failure (after `curl_retry`), sha256 mismatch,
  schema mismatch, or missing `schema_version` → **non-zero exit, build stops**, with a
  message naming the exact remediation. No silent fallback (per repo principle).
- Publisher: a failed `prepare-data` (FAA down) fails that scheduled run only; the
  previously published release and the pin are untouched, so deploys keep working on
  the last good data.

## Testing

- `scripts/verify-db.test.mjs` (new, added to `npm run test`): build a tiny fixture DB
  with a known `schema_version`; assert pass on match, non-zero on mismatch and on
  missing key.
- `bash -n scripts/fetch-data.sh` syntax check (and shellcheck if available).
- `build-db.ts`: assert the built DB contains `metadata.schema_version` equal to the
  JSON (can fold into the verify test using a locally built DB, or a dedicated check).
- `fetch-data.sh` end-to-end: exercised for real by the rollout's PR #2 Vercel preview
  deploy against the first published release; also runnable locally via
  `npm run fetch-data` once a release exists.
- Existing CI (`npx next build`, no data) is unaffected.

## Rollout / bootstrap ordering

The consumer cannot be flipped before a release exists, so:

1. **PR #1:** add `data-schema-version.json`, write `schema_version` in `build-db.ts`,
   add `publish-data.yml`. (`build` still uses `prepare-data` — nothing breaks.) Merge.
2. **Dispatch** `publish-data` once → first release (e.g. `data-2506-2505-s1`).
3. **PR #2:** add `fetch-data.sh`, `verify-db.mjs` (+ test), `data-version.json` pinned
   to that release; flip `package.json` `build`/`dev` to `fetch-data`; update docs.
   Its Vercel preview deploy validates the full consumer path before merge.

## Docs to update (same work item)

- `AGENTS.md`: Core Commands (add `fetch-data`); the CI/Vercel bullet (new flow); the
  `download-data.sh` bullet (now publisher-only + retries); add a pipeline bullet.
- `docs/data-sources.md`: document the publish-and-pin model and the schema-version
  guard.

## Out of scope / YAGNI

- No change to what data is collected or to `build-db` schema beyond adding
  `schema_version`.
- No multi-region mirror / fallback CDN — the pinned GitHub release CDN is sufficient.
- No automatic schema-version bumping — it is a deliberate human action.
- No self-healing fallback to `prepare-data` on the consumer (rejected in favor of
  fail-loud).
```
