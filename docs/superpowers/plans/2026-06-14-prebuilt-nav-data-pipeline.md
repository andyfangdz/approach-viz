# Prebuilt Nav-Data Publish-and-Pin Pipeline — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move FAA/source fetching and DB building out of the Vercel deploy path — a daily GitHub Action publishes the built `approach-viz.sqlite` to a Releases tag, and the Vercel/dev build only downloads that prebuilt DB pinned to an exact tag in the repo.

**Architecture:** Two halves that never share a machine. A **publisher** workflow runs `prepare-data` (fetch FAA + `build-db`), gzips the DB, and creates a GitHub Release tagged `data-<cifp>-<dtpp>-s<schema>` (idempotent: skip if the tag exists). A **consumer** script (`fetch-data.sh`) reads the pinned tag from `data-version.json` and downloads the DB via the public direct-asset CDN URL (no `api.github.com` calls), verifying a sha256 and a fail-loud schema-version guard.

**Tech Stack:** bash + `curl`, Node 22 ESM scripts, `better-sqlite3` (existing dep), `node:test`, GitHub Actions, `gh` CLI, `peter-evans/create-pull-request`.

**Spec:** `docs/superpowers/specs/2026-06-14-prebuilt-nav-data-pipeline-design.md`

**Current branch:** `prebuilt-nav-data-pipeline` (already holds the spec commit; the working tree also has the already-applied `curl_retry` resilience in `scripts/download-data.sh` + `AGENTS.md`).

---

## File Structure

**Phase 1 — PR #1 (publisher + schema foundation). Nothing in the deploy path changes yet; `build` still runs `prepare-data`.**

- Commit (already applied): `scripts/download-data.sh`, `AGENTS.md` — `curl_retry` backoff.
- Create `scripts/data-schema-version.json` — single shared source of truth for the DB schema version.
- Modify `scripts/build-db.ts` — write `metadata.schema_version` from that file.
- Create `scripts/db-metadata.mjs` (+ `scripts/db-metadata.test.mjs`) — read the DB `metadata` table from JS/CLI.
- Create `scripts/build-manifest.mjs` (+ `scripts/build-manifest.test.mjs`) — derive the release tag, hash artifacts, write `manifest.json`.
- Modify `package.json` — add `test:scripts`; wire into `test`.
- Create `.github/workflows/publish-data.yml` — the daily publisher.

**Manual gate (Phase 1.5):** after PR #1 merges, dispatch the publisher once to cut the first release; capture its tag.

**Phase 2 — PR #2 (consumer flip).**

- Create `scripts/verify-db.mjs` (+ `scripts/verify-db.test.mjs`) — fail-loud schema guard.
- Create `scripts/fetch-data.sh` — download + verify + unpack the pinned DB.
- Create `data-version.json` (repo root) — the pin, set to the first release's tag.
- Modify `package.json` — add `fetch-data`; flip `build` and `dev` from `prepare-data` to `fetch-data`; extend `test:scripts`.
- Modify `AGENTS.md`, `docs/data-sources.md` — document the new model.

---

# PHASE 1 — PR #1: Publisher + schema foundation

## Task 1: Land the curl_retry resilience already in the working tree

**Files:**

- Modify (already edited): `scripts/download-data.sh`, `AGENTS.md`

- [ ] **Step 1: Confirm the changes are present**

Run: `git diff --stat scripts/download-data.sh AGENTS.md`
Expected: both files listed as modified. `grep -n curl_retry scripts/download-data.sh` shows the helper definition plus its use at every fetch site.

- [ ] **Step 2: Verify the script still parses**

Run: `bash -n scripts/download-data.sh && echo OK`
Expected: `OK`

- [ ] **Step 3: Commit**

```bash
git add scripts/download-data.sh AGENTS.md
git commit -m "Retry transient HTTP failures in download-data.sh"
```

---

## Task 2: Add the shared schema-version file and write it into the DB

**Files:**

- Create: `scripts/data-schema-version.json`
- Modify: `scripts/build-db.ts` (imports near top; metadata inserts near the existing `insertMetadata.run('generated_at', ...)` block)

- [ ] **Step 1: Create the schema-version file**

`scripts/data-schema-version.json`:

```json
{ "schemaVersion": 1 }
```

- [ ] **Step 2: Read it in build-db.ts**

In `scripts/build-db.ts`, after the existing `const DB_PATH = ...` line (around line 52), add:

```ts
const SCHEMA_VERSION_PATH = path.join(process.cwd(), 'scripts', 'data-schema-version.json');

function readSchemaVersion(): number {
  const parsed = JSON.parse(fs.readFileSync(SCHEMA_VERSION_PATH, 'utf8')) as {
    schemaVersion?: number;
  };
  if (typeof parsed.schemaVersion !== 'number' || !Number.isInteger(parsed.schemaVersion)) {
    throw new Error(`Invalid schemaVersion in ${SCHEMA_VERSION_PATH}`);
  }
  return parsed.schemaVersion;
}
```

- [ ] **Step 3: Write the metadata row**

In `main()`, immediately before `insertMetadata.run('generated_at', new Date().toISOString());`, add:

```ts
insertMetadata.run('schema_version', String(readSchemaVersion()));
```

- [ ] **Step 4: Build the DB and confirm the row exists**

Run (uses the source files already downloaded in `public/data/`):

```bash
npm run build-db && \
node --input-type=commonjs -e 'const D=require("better-sqlite3");const db=new D("data/approach-viz.sqlite",{readonly:true});console.log(db.prepare("SELECT value FROM metadata WHERE key=?").get("schema_version"));'
```

Expected: prints `{ value: '1' }`.

> Note: `--input-type=commonjs` forces CJS so `require("better-sqlite3")` works even though the package is ESM.

- [ ] **Step 5: Run the existing format/type checks**

Run: `npm run format:check && npm run typecheck`
Expected: both pass.

- [ ] **Step 6: Commit**

```bash
git add scripts/data-schema-version.json scripts/build-db.ts
git commit -m "Write schema_version into the built SQLite DB"
```

---

## Task 3: DB metadata reader (`db-metadata.mjs`) — TDD

**Files:**

- Create: `scripts/db-metadata.mjs`
- Test: `scripts/db-metadata.test.mjs`

- [ ] **Step 1: Write the failing test**

`scripts/db-metadata.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { readAllMetadata, readMetadataKey } from './db-metadata.mjs';

function makeDb(metadata) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'avdb-'));
  const dbPath = path.join(dir, 'test.sqlite');
  const db = new Database(dbPath);
  db.exec('CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  const ins = db.prepare('INSERT INTO metadata (key, value) VALUES (?, ?)');
  for (const [k, v] of Object.entries(metadata)) ins.run(k, v);
  db.close();
  return dbPath;
}

test('readAllMetadata returns all rows', () => {
  const dbPath = makeDb({ schema_version: '1', cifp_cycle: '2506' });
  assert.deepEqual(readAllMetadata(dbPath), { schema_version: '1', cifp_cycle: '2506' });
});

test('readMetadataKey returns one value', () => {
  const dbPath = makeDb({ schema_version: '1' });
  assert.equal(readMetadataKey(dbPath, 'schema_version'), '1');
});

test('readMetadataKey throws on missing key', () => {
  const dbPath = makeDb({ schema_version: '1' });
  assert.throws(() => readMetadataKey(dbPath, 'nope'), /not found/);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test scripts/db-metadata.test.mjs`
Expected: FAIL — cannot find module `./db-metadata.mjs`.

- [ ] **Step 3: Implement `db-metadata.mjs`**

`scripts/db-metadata.mjs`:

```js
import Database from 'better-sqlite3';

export function readAllMetadata(dbPath) {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const rows = db.prepare('SELECT key, value FROM metadata').all();
    const out = {};
    for (const row of rows) out[row.key] = row.value;
    return out;
  } finally {
    db.close();
  }
}

export function readMetadataKey(dbPath, key) {
  const all = readAllMetadata(dbPath);
  if (!(key in all)) {
    throw new Error(`metadata key '${key}' not found in ${dbPath}`);
  }
  return all[key];
}

// CLI: node scripts/db-metadata.mjs <db-path> [key]
if (import.meta.url === `file://${process.argv[1]}`) {
  const [dbPath, key] = process.argv.slice(2);
  if (!dbPath) {
    console.error('usage: node scripts/db-metadata.mjs <db-path> [key]');
    process.exit(2);
  }
  process.stdout.write(
    key ? readMetadataKey(dbPath, key) : JSON.stringify(readAllMetadata(dbPath))
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test scripts/db-metadata.test.mjs`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add scripts/db-metadata.mjs scripts/db-metadata.test.mjs
git commit -m "Add DB metadata reader util"
```

---

## Task 4: Release-tag + manifest builder (`build-manifest.mjs`) — TDD

**Files:**

- Create: `scripts/build-manifest.mjs`
- Test: `scripts/build-manifest.test.mjs`

- [ ] **Step 1: Write the failing test**

`scripts/build-manifest.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import Database from 'better-sqlite3';
import { buildManifest } from './build-manifest.mjs';

function makeFixture(metadata) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'avman-'));
  const dbPath = path.join(dir, 'db.sqlite');
  const db = new Database(dbPath);
  db.exec('CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  const ins = db.prepare('INSERT INTO metadata (key, value) VALUES (?, ?)');
  for (const [k, v] of Object.entries(metadata)) ins.run(k, v);
  db.close();
  const gzPath = path.join(dir, 'db.sqlite.gz');
  fs.writeFileSync(gzPath, zlib.gzipSync(fs.readFileSync(dbPath)));
  return { dbPath, gzPath };
}

test('buildManifest derives tag and hashes', () => {
  const { dbPath, gzPath } = makeFixture({
    schema_version: '1',
    cifp_cycle: '2506',
    dtpp_cycle_number: '2505'
  });
  const { tag, manifest } = buildManifest({
    dbPath,
    gzPath,
    builtAt: '2026-06-14T00:00:00.000Z'
  });
  assert.equal(tag, 'data-2506-2505-s1');
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.cifpCycle, '2506');
  assert.equal(manifest.dtppCycle, '2505');
  assert.match(manifest.gzSha256, /^[0-9a-f]{64}$/);
  assert.match(manifest.dbSha256, /^[0-9a-f]{64}$/);
  assert.equal(manifest.builtAt, '2026-06-14T00:00:00.000Z');
});

test('buildManifest throws on missing metadata', () => {
  const { dbPath, gzPath } = makeFixture({ schema_version: '1' });
  assert.throws(() => buildManifest({ dbPath, gzPath, builtAt: 'x' }), /missing 'cifp_cycle'/);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test scripts/build-manifest.test.mjs`
Expected: FAIL — cannot find module `./build-manifest.mjs`.

- [ ] **Step 3: Implement `build-manifest.mjs`**

`scripts/build-manifest.mjs`:

```js
import fs from 'node:fs';
import crypto from 'node:crypto';
import { readAllMetadata } from './db-metadata.mjs';

function sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

export function buildManifest({ dbPath, gzPath, builtAt }) {
  const md = readAllMetadata(dbPath);
  for (const key of ['schema_version', 'cifp_cycle', 'dtpp_cycle_number']) {
    if (!md[key]) {
      throw new Error(`DB metadata missing '${key}' (got ${JSON.stringify(md)})`);
    }
  }
  const tag = `data-${md.cifp_cycle}-${md.dtpp_cycle_number}-s${md.schema_version}`;
  return {
    tag,
    manifest: {
      tag,
      schemaVersion: Number(md.schema_version),
      cifpCycle: md.cifp_cycle,
      dtppCycle: md.dtpp_cycle_number,
      dbSha256: sha256(dbPath),
      gzSha256: sha256(gzPath),
      builtAt
    }
  };
}

// CLI: node scripts/build-manifest.mjs <db> <gz> <manifest-out>  -> prints TAG
if (import.meta.url === `file://${process.argv[1]}`) {
  const [dbPath, gzPath, outPath] = process.argv.slice(2);
  if (!dbPath || !gzPath || !outPath) {
    console.error('usage: node scripts/build-manifest.mjs <db> <gz> <manifest-out>');
    process.exit(2);
  }
  const { tag, manifest } = buildManifest({
    dbPath,
    gzPath,
    builtAt: new Date().toISOString()
  });
  fs.writeFileSync(outPath, JSON.stringify(manifest, null, 2));
  process.stdout.write(tag);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test scripts/build-manifest.test.mjs`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add scripts/build-manifest.mjs scripts/build-manifest.test.mjs
git commit -m "Add release-tag + manifest builder"
```

---

## Task 5: Wire the script tests into `npm run test`

**Files:**

- Modify: `package.json` (`scripts` block)

- [ ] **Step 1: Add the `test:scripts` script and append it to `test`**

In `package.json`, change:

```json
    "test": "npm run test:parser && npm run test:geometry && npm run test:layers && npm run test:mrms && npm run test:workers && npm run test:routes",
```

to:

```json
    "test": "npm run test:parser && npm run test:geometry && npm run test:layers && npm run test:mrms && npm run test:workers && npm run test:routes && npm run test:scripts",
    "test:scripts": "node --test scripts/db-metadata.test.mjs scripts/build-manifest.test.mjs",
```

- [ ] **Step 2: Run the full suite**

Run: `npm run test`
Expected: all existing suites pass plus `test:scripts` (5 tests across the two files).

- [ ] **Step 3: Commit**

```bash
git add package.json
git commit -m "Run script unit tests in npm run test"
```

---

## Task 6: Publisher workflow (`publish-data.yml`)

**Files:**

- Create: `.github/workflows/publish-data.yml`

- [ ] **Step 1: Create the workflow**

`.github/workflows/publish-data.yml`:

```yaml
# Builds the nav DB from FAA sources and publishes it as a GitHub Release so the
# Vercel/dev build can download a prebuilt artifact instead of fetching FAA data
# at deploy time. Idempotent: skips when a release for this dataset already exists.
name: Publish Nav Data

on:
  schedule:
    - cron: '0 9 * * *' # daily ~09:00 UTC
  workflow_dispatch:

permissions:
  contents: write # create releases; commit the pin-bump branch
  pull-requests: write # open the pin-bump PR

jobs:
  publish:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - name: Checkout
        uses: actions/checkout@v5

      - name: Setup Node.js
        uses: actions/setup-node@v6
        with:
          node-version: 22
          cache: npm

      - name: Install dependencies
        run: npm ci

      - name: Prepare data (fetch FAA sources + build DB)
        run: npm run prepare-data
        env:
          GITHUB_TOKEN: ${{ github.token }}

      - name: Gzip DB and build manifest
        id: manifest
        run: |
          gzip -kf data/approach-viz.sqlite
          TAG="$(node scripts/build-manifest.mjs \
            data/approach-viz.sqlite \
            data/approach-viz.sqlite.gz \
            data/manifest.json)"
          echo "tag=$TAG" >> "$GITHUB_OUTPUT"
          echo "Computed tag: $TAG"

      - name: Check whether release already exists
        id: release_exists
        env:
          GH_TOKEN: ${{ github.token }}
        run: |
          if gh release view "${{ steps.manifest.outputs.tag }}" >/dev/null 2>&1; then
            echo "exists=true" >> "$GITHUB_OUTPUT"
            echo "Release ${{ steps.manifest.outputs.tag }} already exists; nothing to publish."
          else
            echo "exists=false" >> "$GITHUB_OUTPUT"
          fi

      - name: Create release
        if: steps.release_exists.outputs.exists == 'false'
        env:
          GH_TOKEN: ${{ github.token }}
        run: |
          gh release create "${{ steps.manifest.outputs.tag }}" \
            data/approach-viz.sqlite.gz \
            data/manifest.json \
            --title "${{ steps.manifest.outputs.tag }}" \
            --notes "Prebuilt approach-viz.sqlite. See manifest.json for cycles and hashes."

      - name: Check whether pin file exists (skip auto-PR during bootstrap)
        id: pin_exists
        run: |
          if [ -f data-version.json ]; then
            echo "exists=true" >> "$GITHUB_OUTPUT"
          else
            echo "exists=false" >> "$GITHUB_OUTPUT"
          fi

      - name: Write new pin value
        if: steps.release_exists.outputs.exists == 'false' && steps.pin_exists.outputs.exists == 'true'
        run: |
          node --input-type=commonjs -e '
            const fs = require("fs");
            fs.writeFileSync("data-version.json", JSON.stringify({ tag: process.argv[1] }, null, 2) + "\n");
          ' "${{ steps.manifest.outputs.tag }}"

      - name: Open pin-bump PR
        if: steps.release_exists.outputs.exists == 'false' && steps.pin_exists.outputs.exists == 'true'
        uses: peter-evans/create-pull-request@v6
        with:
          commit-message: 'Bump nav data pin to ${{ steps.manifest.outputs.tag }}'
          title: 'Bump nav data pin to ${{ steps.manifest.outputs.tag }}'
          body: 'Automated pin bump after publishing release `${{ steps.manifest.outputs.tag }}`.'
          branch: 'auto/nav-data-${{ steps.manifest.outputs.tag }}'
          add-paths: data-version.json
```

- [ ] **Step 2: Validate the workflow YAML parses**

Run: `node --input-type=commonjs -e 'const fs=require("fs");const s=fs.readFileSync(".github/workflows/publish-data.yml","utf8");if(!/name:\s*Publish Nav Data/.test(s)){throw new Error("workflow name missing")}console.log("workflow file present and well-formed enough")'`
Expected: prints the confirmation line. (Full YAML linting happens when GitHub parses it on push.)

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/publish-data.yml
git commit -m "Add daily nav-data publisher workflow"
```

- [ ] **Step 4: Open PR #1**

```bash
git push -u origin prebuilt-nav-data-pipeline
gh pr create --fill --title "Nav data publisher + schema_version foundation"
```

Wait for CI (`npm run test`, `npx next build`, `cargo` jobs) to pass, then merge. The deploy path is unchanged in this PR, so Vercel still builds normally.

---

# PHASE 1.5 — Manual gate: cut the first release

These are manual operator steps (no code change). They must happen **after PR #1 is merged to `master`** and **before PR #2 flips the build**.

- [ ] **Step 1: Dispatch the publisher against `master`**

```bash
gh workflow run "Publish Nav Data" --ref master
```

- [ ] **Step 2: Wait for it to finish and confirm success**

```bash
gh run list --workflow "Publish Nav Data" --limit 1
# then watch the latest run:
gh run watch "$(gh run list --workflow 'Publish Nav Data' --limit 1 --json databaseId --jq '.[0].databaseId')"
```

Expected: the run succeeds and creates a release (it will NOT open an auto-PR yet, because `data-version.json` does not exist — that is intentional during bootstrap).

- [ ] **Step 3: Capture the released tag (used in Task 9)**

```bash
gh release list --json tagName,createdAt \
  --jq 'map(select(.tagName|startswith("data-")))|sort_by(.createdAt)|last|.tagName'
```

Expected: prints something like `data-2506-2505-s1`. Record this value — Task 9 reads it programmatically, so no manual copy is strictly required, but note it for sanity-checking.

---

# PHASE 2 — PR #2: Flip the consumer

Start from an up-to-date `master` after PR #1 merged:

```bash
git checkout master && git pull
git checkout -b nav-data-consumer-flip
```

## Task 7: Schema-guard verifier (`verify-db.mjs`) — TDD

**Files:**

- Create: `scripts/verify-db.mjs`
- Test: `scripts/verify-db.test.mjs`

- [ ] **Step 1: Write the failing test**

`scripts/verify-db.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { verifyDb } from './verify-db.mjs';

function makeDb(metadata) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'avverify-'));
  const dbPath = path.join(dir, 'db.sqlite');
  const db = new Database(dbPath);
  db.exec('CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  const ins = db.prepare('INSERT INTO metadata (key, value) VALUES (?, ?)');
  for (const [k, v] of Object.entries(metadata)) ins.run(k, v);
  db.close();
  return dbPath;
}

test('verifyDb passes when schema matches', () => {
  const dbPath = makeDb({ schema_version: '3' });
  assert.equal(verifyDb(dbPath, 3), 3);
});

test('verifyDb throws on mismatch', () => {
  const dbPath = makeDb({ schema_version: '2' });
  assert.throws(() => verifyDb(dbPath, 3), /schema mismatch/);
});

test('verifyDb throws when schema_version absent', () => {
  const dbPath = makeDb({ cifp_cycle: '2506' });
  assert.throws(() => verifyDb(dbPath, 1), /no metadata.schema_version/);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test scripts/verify-db.test.mjs`
Expected: FAIL — cannot find module `./verify-db.mjs`.

- [ ] **Step 3: Implement `verify-db.mjs`**

`scripts/verify-db.mjs`:

```js
import fs from 'node:fs';
import path from 'node:path';
import { readAllMetadata } from './db-metadata.mjs';

const SCHEMA_VERSION_PATH = path.join(process.cwd(), 'scripts', 'data-schema-version.json');

export function expectedSchemaVersion() {
  const parsed = JSON.parse(fs.readFileSync(SCHEMA_VERSION_PATH, 'utf8'));
  if (typeof parsed.schemaVersion !== 'number') {
    throw new Error(`Invalid schemaVersion in ${SCHEMA_VERSION_PATH}`);
  }
  return parsed.schemaVersion;
}

export function verifyDb(dbPath, expected = expectedSchemaVersion()) {
  const md = readAllMetadata(dbPath);
  if (!('schema_version' in md)) {
    throw new Error(`DB ${dbPath} has no metadata.schema_version`);
  }
  const actual = Number(md.schema_version);
  if (actual !== expected) {
    throw new Error(
      `DB schema mismatch: ${dbPath} is schema v${actual}, code expects v${expected}. ` +
        `Republish data (dispatch the "Publish Nav Data" workflow on this branch and ` +
        `bump data-version.json) or run 'npm run prepare-data' to build from source.`
    );
  }
  return actual;
}

// CLI: node scripts/verify-db.mjs <db-path>
if (import.meta.url === `file://${process.argv[1]}`) {
  const dbPath = process.argv[2];
  if (!dbPath) {
    console.error('usage: node scripts/verify-db.mjs <db-path>');
    process.exit(2);
  }
  try {
    const v = verifyDb(dbPath);
    console.log(`✅ DB schema v${v} matches code`);
  } catch (err) {
    console.error(`❌ ${err.message}`);
    process.exit(1);
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test scripts/verify-db.test.mjs`
Expected: PASS (3 tests).

- [ ] **Step 5: Extend `test:scripts` and run the full suite**

In `package.json`, change `test:scripts` to:

```json
    "test:scripts": "node --test scripts/db-metadata.test.mjs scripts/build-manifest.test.mjs scripts/verify-db.test.mjs",
```

Run: `npm run test`
Expected: all suites pass, including the 3 new verify-db tests.

- [ ] **Step 6: Commit**

```bash
git add scripts/verify-db.mjs scripts/verify-db.test.mjs package.json
git commit -m "Add fail-loud DB schema-version guard"
```

---

## Task 8: Consumer download script (`fetch-data.sh`)

**Files:**

- Create: `scripts/fetch-data.sh`

- [ ] **Step 1: Create the script**

`scripts/fetch-data.sh`:

```bash
#!/bin/bash
set -euo pipefail

# Consumer path: download the prebuilt approach-viz.sqlite pinned by
# data-version.json from a GitHub Release. No FAA/aeronav fetch, no build-db.
# Because we pin an exact tag, we use the public direct release-asset CDN URL
# (no api.github.com calls, so no anonymous rate limits / 504s).

REPO="${APPROACH_VIZ_DATA_REPO:-andyfangdz/approach-viz}"
DB_DIR="data"
DB_PATH="$DB_DIR/approach-viz.sqlite"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

curl_retry() {
  curl -fsSL --retry 5 --retry-connrefused "$@"
}

read_json_field() {
  # $1 = json file path, $2 = field name
  node --input-type=commonjs -e '
    const fs = require("fs");
    const [file, field] = process.argv.slice(1);
    const v = JSON.parse(fs.readFileSync(file, "utf8"))[field];
    if (v === undefined || v === null || v === "") {
      console.error(`Missing field "${field}" in ${file}`);
      process.exit(1);
    }
    process.stdout.write(String(v));
  ' "$1" "$2"
}

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

if [ ! -f data-version.json ]; then
  echo "❌ data-version.json not found at repo root" >&2
  exit 1
fi

TAG="$(read_json_field data-version.json tag)"
BASE_URL="https://github.com/$REPO/releases/download/$TAG"
echo "📥 Fetching prebuilt nav DB: $REPO @ $TAG"

# Private-repo support: forward a token if present (public assets ignore it).
AUTH=()
if [ -n "${GITHUB_TOKEN:-}" ]; then
  AUTH=(-H "Authorization: Bearer $GITHUB_TOKEN")
fi

curl_retry "${AUTH[@]+"${AUTH[@]}"}" "$BASE_URL/manifest.json" -o "$TMP_DIR/manifest.json"
curl_retry "${AUTH[@]+"${AUTH[@]}"}" "$BASE_URL/approach-viz.sqlite.gz" -o "$TMP_DIR/approach-viz.sqlite.gz"

EXPECTED_GZ_SHA="$(read_json_field "$TMP_DIR/manifest.json" gzSha256)"
ACTUAL_GZ_SHA="$(sha256_of "$TMP_DIR/approach-viz.sqlite.gz")"
if [ "$EXPECTED_GZ_SHA" != "$ACTUAL_GZ_SHA" ]; then
  echo "❌ gz sha256 mismatch for $TAG (expected $EXPECTED_GZ_SHA, got $ACTUAL_GZ_SHA)" >&2
  exit 1
fi

mkdir -p "$DB_DIR"
gunzip -c "$TMP_DIR/approach-viz.sqlite.gz" > "$DB_PATH"

node scripts/verify-db.mjs "$DB_PATH"

echo "✅ Nav DB ready at $DB_PATH ($(wc -c < "$DB_PATH" | tr -d ' ') bytes, tag $TAG)"
```

- [ ] **Step 2: Syntax-check the script**

Run: `bash -n scripts/fetch-data.sh && echo OK`
Expected: `OK`

- [ ] **Step 3: Commit**

```bash
git add scripts/fetch-data.sh
git commit -m "Add fetch-data.sh consumer download script"
```

---

## Task 9: Add the pin file and end-to-end verify the download

**Files:**

- Create: `data-version.json` (repo root)

- [ ] **Step 1: Write `data-version.json` from the published release tag**

```bash
TAG="$(gh release list --json tagName,createdAt \
  --jq 'map(select(.tagName|startswith("data-")))|sort_by(.createdAt)|last|.tagName')"
test -n "$TAG" # fail loudly if no release exists yet (do Phase 1.5 first)
node --input-type=commonjs -e 'const fs=require("fs");fs.writeFileSync("data-version.json", JSON.stringify({tag: process.argv[1]}, null, 2)+"\n")' "$TAG"
cat data-version.json
```

Expected: `data-version.json` contains `{ "tag": "data-2506-2505-s1" }` (your actual tag).

- [ ] **Step 2: Run the consumer path end-to-end against the real release**

```bash
rm -f data/approach-viz.sqlite
npm run fetch-data
```

Expected: downloads the manifest + gz, passes the sha256 check, unpacks, prints `✅ DB schema v1 matches code`, then `✅ Nav DB ready ...`.

- [ ] **Step 3: Confirm the app still builds against the downloaded DB**

Run: `npm run build:sw && npx next build`
Expected: build succeeds (this mirrors what Vercel will run minus the data step, but the DB is now present from Step 2).

- [ ] **Step 4: Commit**

```bash
git add data-version.json
git commit -m "Pin nav data to first published release"
```

---

## Task 10: Flip `build` and `dev` to the consumer path

**Files:**

- Modify: `package.json` (`build` and `dev` scripts)

- [ ] **Step 1: Add `fetch-data` and flip the scripts**

In `package.json`:

Add to `scripts`:

```json
    "fetch-data": "bash scripts/fetch-data.sh",
```

Change `dev` from:

```json
    "dev": "npm run build:sw && { [ -f data/approach-viz.sqlite ] || npm run prepare-data; } && node scripts/dev-with-ddtrace.mjs",
```

to:

```json
    "dev": "npm run build:sw && { [ -f data/approach-viz.sqlite ] || npm run fetch-data; } && node scripts/dev-with-ddtrace.mjs",
```

Change `build` from:

```json
    "build": "npm run build:sw && npm run prepare-data && next build",
```

to:

```json
    "build": "npm run build:sw && npm run fetch-data && next build",
```

(Leave `prepare-data`, `download-data`, `build-db` untouched — the publisher and local fresh-builds still use them.)

- [ ] **Step 2: Simulate the Vercel build from a clean data dir**

```bash
rm -f data/approach-viz.sqlite data/approach-viz.sqlite.gz
npm run build
```

Expected: `build:sw` runs, `fetch-data` downloads + verifies the pinned DB, `next build` succeeds. No FAA/aeronav requests occur.

- [ ] **Step 3: Run the quality gates**

Run: `npm run format:check && npm run typecheck && npm run lint && npm run test`
Expected: all pass.

- [ ] **Step 4: Commit**

```bash
git add package.json
git commit -m "Build/dev fetch the pinned prebuilt DB instead of building from FAA"
```

---

## Task 11: Update documentation

**Files:**

- Modify: `AGENTS.md`
- Modify: `docs/data-sources.md`

- [ ] **Step 1: Update `AGENTS.md` Core Commands (App/Data section)**

After the `Full data refresh: \`npm run prepare-data\`` line, add:

```markdown
- Fetch prebuilt DB (pinned release): `npm run fetch-data`
```

- [ ] **Step 2: Replace the Vercel/CI bullet** added earlier so it reflects the new model

Find the bullet beginning `- Vercel (preview + production) deliberately runs the full \`npm run build\`` and replace it with:

```markdown
- Vercel (preview + production) and local `dev` no longer build the DB at deploy time. `npm run build` runs `build:sw` + `fetch-data` + `next build`: `scripts/fetch-data.sh` reads the pinned release tag from `data-version.json` and downloads the prebuilt `data/approach-viz.sqlite` (gzipped) from that GitHub Release's direct asset URL — a public, unauthenticated, CDN-backed path that makes no `api.github.com` calls. It verifies the gzip sha256 against the release `manifest.json` and runs `scripts/verify-db.mjs` (fails loudly if the DB's `metadata.schema_version` does not match `scripts/data-schema-version.json`). The FAA/source fetch + `build-db` now run only in the `Publish Nav Data` GitHub Action (`.github/workflows/publish-data.yml`, daily cron + manual dispatch), which builds the DB, publishes it as release `data-<cifp_cycle>-<dtpp_cycle>-s<schemaVersion>` (skipping when that tag already exists), and opens an auto-PR bumping `data-version.json`. `prepare-data` remains the local "build fresh from FAA source" escape hatch. Changing the DB schema requires bumping `scripts/data-schema-version.json`, dispatching the publisher to cut a release at the new schema, and pinning it in the same PR (otherwise the schema guard fails the build).
```

- [ ] **Step 3: Update the `download-data.sh` bullet** to note it is now publisher-side

In the bullet beginning `- \`scripts/download-data.sh\` pins the Class B/C/D airspace`, append this sentence at the end:

```markdown
`download-data.sh` + `build-db` now run only in the `Publish Nav Data` workflow (and local `prepare-data`), not on every Vercel deploy.
```

- [ ] **Step 4: Document the model in `docs/data-sources.md`**

Read `docs/data-sources.md` first to match its style, then add a section:

```markdown
## Build-time data delivery (publish-and-pin)

The runtime SQLite DB (`data/approach-viz.sqlite`) is a generated artifact required
by the server (read-only, traced into serverless functions). It is **not** built on
every deploy. Instead:

- **Publisher** — `.github/workflows/publish-data.yml` (daily cron + manual dispatch)
  runs `npm run prepare-data` (fetch FAA CIFP, `approaches.json`, airspace; build the
  DB), gzips it, and creates a GitHub Release tagged
  `data-<cifp_cycle>-<dtpp_cycle>-s<schemaVersion>` with `approach-viz.sqlite.gz` and
  `manifest.json`. It skips when that tag already exists, and opens an auto-PR bumping
  the pin.
- **Pin** — `data-version.json` (repo root) records the exact release tag a given
  commit deploys with, so deploys are reproducible.
- **Consumer** — `npm run fetch-data` (`scripts/fetch-data.sh`), invoked by `build`
  and `dev`, downloads the pinned release's assets from the public direct-asset CDN
  URL (no `api.github.com` calls), verifies the gzip sha256, unpacks the DB, and runs
  the `scripts/verify-db.mjs` schema-version guard.
- **Schema version** — `scripts/data-schema-version.json` is the shared source of
  truth; `build-db.ts` writes it into `metadata.schema_version` and `verify-db.mjs`
  enforces it. Bump it whenever the DB schema changes, and cut + pin a matching
  release in the same PR.
- **Escape hatch** — `npm run prepare-data` still builds the DB from FAA source
  locally.
```

- [ ] **Step 5: Verify formatting**

Run: `npm run format:check`
Expected: passes (Markdown is checked; `.sh` is skipped by Prettier).

- [ ] **Step 6: Commit**

```bash
git add AGENTS.md docs/data-sources.md
git commit -m "Document publish-and-pin nav data pipeline"
```

- [ ] **Step 7: Open PR #2**

```bash
git push -u origin nav-data-consumer-flip
gh pr create --fill --title "Flip build/dev to pinned prebuilt nav DB"
```

The PR's Vercel preview deploy is the real end-to-end proof: it runs `npm run build`
→ `fetch-data` against the pinned release with no FAA dependency. Confirm the preview
deploys green before merging.

---

## Self-Review notes (for the executor)

- **Schema-drift edge case** is handled by Task 7's guard message and the workflow's
  `workflow_dispatch` (dispatch on a feature branch to cut a release at a new schema).
- **Bootstrap ordering** is enforced: the publisher's auto-PR steps are gated on
  `data-version.json` already existing, so the first (pre-PR-#2) dispatch creates only
  the release, not a conflicting pin PR.
- **Empty-array expansion** in `fetch-data.sh` uses `"${AUTH[@]+"${AUTH[@]}"}"` so it
  is safe under `set -u` on macOS bash 3.2 as well as Linux bash 5.

```

```
