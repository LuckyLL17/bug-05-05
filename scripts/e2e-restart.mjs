import { strict as assert } from 'node:assert';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = 34197;
const BASE = `http://127.0.0.1:${PORT}`;
const T = 1_700_000_000_000;
const dir = mkdtempSync(join(tmpdir(), 'twin-e2e-'));
const storePath = join(dir, 'store.json');

const startServer = () => {
  const child = spawn('node', ['dist/index.js'], {
    env: { ...process.env, PORT: String(PORT), TWIN_STORE_PATH: storePath },
    stdio: 'ignore',
  });
  return child;
};

const waitReady = async () => {
  for (let i = 0; i < 100; i++) {
    try {
      const res = await fetch(`${BASE}/health`);
      if (res.ok) return;
    } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('server did not start');
};

const post = (url, body) => fetch(`${BASE}${url}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(r => r.json());
const get = (url) => fetch(`${BASE}${url}`).then(r => r.json());

const T1 = async () => {
  const server = startServer();
  await waitReady();
  await post('/topology', { version: 1, effectiveAt: T - 10_000, edges: [
    { from: 'pump-1', to: 'valve-1', weight: 0.9 },
    { from: 'sensor-1', to: 'valve-1', weight: 0.7 },
    { from: 'valve-1', to: 'reactor-1', weight: 0.8 },
  ] });
  // same business timestamp, deliberately shuffled arrival order, plus out-of-order timestamps
  const batch = [
    { eventId: 'evt-c', assetId: 'valve-1', metric: 'pressure', value: 15, unit: 'kPa', observedAt: T, quality: 'good' },
    { eventId: 'evt-a', assetId: 'valve-1', metric: 'pressure', value: 12, unit: 'kPa', observedAt: T, quality: 'good' },
    { eventId: 'evt-z', assetId: 'valve-1', metric: 'pressure', value: 9, unit: 'kPa', observedAt: T + 1000, quality: 'good' },
    { eventId: 'evt-b', assetId: 'valve-1', metric: 'pressure', value: 18, unit: 'kPa', observedAt: T, quality: 'good' },
    { eventId: 'evt-pre', assetId: 'valve-1', metric: 'pressure', value: 11, unit: 'kPa', observedAt: T - 1000, quality: 'good' },
  ];
  for (const e of batch) await post('/telemetry', e);
  // duplicate retries must not add nodes
  await post('/telemetry', batch[0]);
  await post('/telemetry', batch[0]);
  const replay1 = await get(`/telemetry/replay?from=${T - 2000}&to=${T + 2000}`);
  const replay2 = await get(`/telemetry/replay?from=${T - 2000}&to=${T + 2000}`);
  assert.deepEqual(replay2, replay1, 'repeated replays differ');
  assert.equal(replay1.length, 5, 'duplicate eventId inserted extra nodes');
  const incident = await post('/anomalies/detect', { assetId: 'valve-1', metric: 'pressure', threshold: 10 });
  const cause1 = await get(`/incidents/${incident.id}/root-cause`);
  server.kill();
  await new Promise(r => server.on('exit', r));
  return { replay1, incident, cause1 };
};

const T2 = async ({ replay1, incident, cause1 }) => {
  const server = startServer();
  await waitReady();
  const replayAfter = await get(`/telemetry/replay?from=${T - 2000}&to=${T + 2000}`);
  assert.deepEqual(replayAfter, replay1, 'replay order changed after service restart');
  const causeAfter = await get(`/incidents/${incident.id}/root-cause`);
  assert.deepEqual(causeAfter, cause1, 'root-cause path changed after service restart');
  server.kill();
  await new Promise(r => server.on('exit', r));
  const order = replay1.map(e => `${e.id}@t${e.timestamp - T}`);
  console.log('stable replay order across restart:', order.join('  '));
  console.log('stable causal path:', cause1.candidates.map(c => `${c.assetId}(${c.weight})`).join(' -> '), `confidence=${cause1.confidence}`);
};

const first = await T1();
await T2(first);
rmSync(dir, { recursive: true, force: true });
console.log('E2E restart verification passed');
