import test from 'node:test';
import assert from 'node:assert';
import {
  buildNexradRequestUrl,
  buildEchoTopRequestUrl,
  extractPhaseDebugHeaderValues
} from './nexrad-decode';

test('buildNexradRequestUrl returns local API path when MRMS_BINARY_BASE_URL is unset', () => {
  const params = new URLSearchParams({ lat: '40', lon: '-90', range: '100' });
  const url = buildNexradRequestUrl(params);
  assert.ok(url.startsWith('/api/weather/nexrad?'));
  assert.ok(url.includes('lat=40'));
});

test('buildEchoTopRequestUrl returns local API path when MRMS_BINARY_BASE_URL is unset', () => {
  const params = new URLSearchParams({ lat: '40', lon: '-90', range: '100' });
  const url = buildEchoTopRequestUrl(params);
  assert.ok(url.startsWith('/api/weather/nexrad/echo-tops?'));
  assert.ok(url.includes('lat=40'));
});

test('extractPhaseDebugHeaderValues parses numeric and string headers', () => {
  const headers = new Headers({
    'x-av-phase-mode': 'thermo',
    'x-av-phase-detail': 'dual-pol corrected',
    'x-av-zdr-age-seconds': '120',
    'x-av-rhohv-age-seconds': 'not-a-number'
  });
  const values = extractPhaseDebugHeaderValues(headers);
  assert.strictEqual(values.phaseMode, 'thermo');
  assert.strictEqual(values.phaseDetail, 'dual-pol corrected');
  assert.strictEqual(values.zdrAgeSeconds, 120);
  assert.strictEqual(values.rhohvAgeSeconds, null);
  assert.strictEqual(values.zdrTimestamp, null);
});
