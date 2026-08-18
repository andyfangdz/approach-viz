# Vendored anti-slop Oxlint plugin

Copied from https://github.com/dmmulroy/anti-slop (`446268e5d15baa968eaec669ff65358d36ae6259`).

This plugin is meant to be owned locally after the initial copy. Re-run `npm run lint:anti-slop` to scan TypeScript/JavaScript for low-evidence patterns. The scan is configured in `.oxlintrc.json` and is not part of required CI until findings are cleaned.

The TypeScript plugin entry (`index.ts`) needs Node `^20.19 || >=22.18` so Oxlint can load it with native type-stripping.
