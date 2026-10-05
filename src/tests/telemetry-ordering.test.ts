import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { buildApp } from '../app';

const T = 1_700_000_000_000;

type App = ReturnType<typeof buildApp>;
type ReplayEvent = { id: string; timestamp: number; sequence: number; payload: Record<string, unknown> };

const storeDir = () => mkdtempSync(join(tmpdir(), 'twin-store-'));

const sample = (eventId: string, assetId: string, value: number, observedAt: number, metric = 'pressure') =>
  ({ eventId, assetId, metric, value, unit: 'kPa', observedAt, quality: 'good' as const });

const ingest = async (app: App, body: Record<string, unknown>) => {
  const res = await app.inject({ method: 'POST', url: '/telemetry', payload: body });
  assert.equal(res.statusCode, 200);
  return res.json();
};

const replay = async (app: App, from: number, to: number): Promise<ReplayEvent[]> => {
  const res = await app.inject({ method: 'GET', url: `/telemetry/replay?from=${from}&to=${to}` });
  assert.equal(res.statusCode, 200);
  return res.json();
};

test('same-timestamp events replay in identical order regardless of write order', async () => {
  const appA = buildApp();
  const appB = buildApp();
  const batch = [
    sample('evt-alpha', 'pump-1', 11, T),
    sample('evt-beta', 'pump-1', 12, T),
    sample('evt-gamma', 'valve-1', 13, T),
    sample('evt-delta', 'valve-1', 14, T),
    sample('evt-epsilon', 'reactor-1', 15, T),
  ];
  for (const e of batch) await ingest(appA, e);
  for (const e of [batch[3], batch[0], batch[4], batch[1], batch[2]]) await ingest(appB, e);

  const a = await replay(appA, T - 1, T + 1);
  const b = await replay(appB, T - 1, T + 1);
  assert.equal(a.length, 5);
  assert.deepEqual(b.map(e => e.id), a.map(e => e.id));
  assert.deepEqual(b.map(e => e.sequence), a.map(e => e.sequence));
  await appA.close();
  await appB.close();
});

test('out-of-order submission keeps business-time precedence and repeated replays are identical', async () => {
  const app = buildApp();
  const events = [
    sample('evt-t3', 'pump-1', 3, T + 2000),
    sample('evt-t1b', 'pump-1', 1.2, T),
    sample('evt-t2', 'pump-1', 2, T + 1000),
    sample('evt-t1a', 'pump-1', 1.1, T),
    sample('evt-t0', 'pump-1', 0.5, T - 1000),
  ];
  for (const e of events) await ingest(app, e);

  const first = await replay(app, T - 2000, T + 3000);
  assert.deepEqual(await replay(app, T - 2000, T + 3000), first);
  assert.deepEqual(await replay(app, T - 2000, T + 3000), first);

  // existing precedence across different business times is never reshuffled
  assert.deepEqual(first.map(e => e.timestamp), [T - 1000, T, T, T + 1000, T + 2000]);
  assert.equal(first[0].id, 'evt-t0');
  assert.equal(first[3].id, 'evt-t2');
  assert.equal(first[4].id, 'evt-t3');
  await app.close();
});

test('duplicate eventId never inserts extra nodes', async () => {
  const app = buildApp();
  const e1 = await ingest(app, sample('evt-dup', 'pump-1', 42, T));
  const e2 = await ingest(app, sample('evt-dup', 'pump-1', 42, T)); // exact retry
  const e3 = await ingest(app, sample('evt-dup', 'pump-1', 43, T)); // same id, conflicting content
  assert.equal(e2.id, e1.id);
  assert.equal(e3.id, e1.id);

  // no eventId supplied: identical content is the same event and dedupes as well
  const noId = { assetId: 'valve-1', metric: 'flow', value: 7, unit: 'm3/h', observedAt: T, quality: 'good' };
  const g1 = await ingest(app, noId);
  const g2 = await ingest(app, noId);
  assert.equal(g2.id, g1.id);

  const events = await replay(app, T - 1, T + 1);
  assert.equal(events.length, 2);
  assert.equal(events.filter(e => e.id === e1.id).length, 1);
  assert.equal(events.filter(e => e.id === g1.id).length, 1);
  // first write wins for a conflicting duplicate
  assert.equal(events.find(e => e.id === e1.id)?.payload.value, 42);
  await app.close();
});

test('identical telemetry content gets identical identity in independent instances', async () => {
  const appA = buildApp();
  const appB = buildApp();
  const payload = { assetId: 'pump-1', metric: 'pressure', value: 9.5, unit: 'kPa', observedAt: T, quality: 'good' };
  const a = await ingest(appA, payload);
  const b = await ingest(appB, payload);
  assert.equal(a.id, b.id);
  assert.equal(a.sequence, b.sequence);
  await appA.close();
  await appB.close();
});

test('replay order survives a service restart and stays stable when new events arrive', async () => {
  const dir = storeDir();
  const path = join(dir, 'store.json');
  const app1 = buildApp(path);
  const batch = [
    sample('evt-r3', 'pump-1', 3, T),
    sample('evt-r1', 'pump-1', 1, T - 500),
    sample('evt-r4', 'valve-1', 4, T),
    sample('evt-r2', 'pump-1', 2, T),
    sample('evt-r5', 'valve-1', 5, T + 500),
  ];
  for (const e of batch) await ingest(app1, e);
  const before = await replay(app1, T - 1000, T + 1000);
  await app1.close();

  // restart: a fresh service instance over the same store file
  const app2 = buildApp(path);
  const after = await replay(app2, T - 1000, T + 1000);
  assert.deepEqual(after, before);

  // appending a new same-timestamp event must not reshuffle existing ones
  await ingest(app2, sample('evt-r6', 'pump-1', 6, T));
  const extended = await replay(app2, T - 1000, T + 1000);
  const beforeIds = before.map(e => e.id);
  assert.deepEqual(extended.map(e => e.id).filter(id => id !== 'evt-r6'), beforeIds);
  // duplicates submitted after the restart still dedupe against persisted events
  const again = await ingest(app2, batch[0]);
  assert.equal(again.id, 'evt-r3');
  assert.equal((await replay(app2, T - 1000, T + 1000)).length, extended.length);
  await app2.close();
  rmSync(dir, { recursive: true, force: true });
});

test('causal path from replay to root cause is stable across repeats and a restart', async () => {
  const dir = storeDir();
  const path = join(dir, 'store.json');
  const topology = {
    version: 1,
    effectiveAt: T - 10_000,
    edges: [
      { from: 'pump-1', to: 'valve-1', weight: 0.9 },
      { from: 'sensor-1', to: 'valve-1', weight: 0.7 },
      { from: 'valve-1', to: 'reactor-1', weight: 0.8 },
    ],
  };
  const readings = [
    sample('evt-a1', 'valve-1', 12, T),
    sample('evt-a2', 'valve-1', 15, T),
    sample('evt-a3', 'valve-1', 11, T - 1000),
    sample('evt-a4', 'valve-1', 18, T),
  ];

  const app1 = buildApp(path);
  const topoRes = await app1.inject({ method: 'POST', url: '/topology', payload: topology });
  assert.equal(topoRes.statusCode, 200);
  for (const e of [...readings].reverse()) await ingest(app1, e); // shuffled write order
  const detectRes = await app1.inject({ method: 'POST', url: '/anomalies/detect', payload: { assetId: 'valve-1', metric: 'pressure', threshold: 10 } });
  assert.equal(detectRes.statusCode, 200);
  const incident = detectRes.json();
  const replayBefore = await replay(app1, T - 2000, T + 2000);
  const cause1 = (await app1.inject({ method: 'GET', url: `/incidents/${incident.id}/root-cause` })).json();
  const cause2 = (await app1.inject({ method: 'GET', url: `/incidents/${incident.id}/root-cause` })).json();
  assert.deepEqual(cause2, cause1); // repeated root-cause analysis is stable
  await app1.close();

  // restart and re-read: replay and causal path must be byte-identical
  const app2 = buildApp(path);
  assert.deepEqual(await replay(app2, T - 2000, T + 2000), replayBefore);
  const cause3 = (await app2.inject({ method: 'GET', url: `/incidents/${incident.id}/root-cause` })).json();
  assert.deepEqual(cause3, cause1);
  await app2.close();

  // the causal path itself: upstream dependencies ordered by weight
  assert.deepEqual(cause1.candidates.map((c: { assetId: string }) => c.assetId), ['pump-1', 'sensor-1']);
  assert.equal(cause1.confidence, 0.75);
  // evidence follows canonical (business time, system sequence) order, not write order
  const evidenceTimes = incident.evidence.map((e: string) => Number(e.split('@')[1]));
  assert.deepEqual(evidenceTimes, [...evidenceTimes].sort((x, y) => x - y));
  rmSync(dir, { recursive: true, force: true });
});

test('same batch written in different orders yields the same causal path', async () => {
  const topology = {
    version: 1,
    effectiveAt: T - 10_000,
    edges: [
      { from: 'pump-1', to: 'valve-1', weight: 0.9 },
      { from: 'sensor-1', to: 'valve-1', weight: 0.7 },
    ],
  };
  const readings = [
    sample('evt-b1', 'valve-1', 12, T),
    sample('evt-b2', 'valve-1', 15, T),
    sample('evt-b3', 'valve-1', 11, T),
    sample('evt-b4', 'valve-1', 18, T),
    sample('evt-b5', 'valve-1', 14, T),
  ];
  const runPipeline = async (order: number[]) => {
    const app = buildApp();
    await app.inject({ method: 'POST', url: '/topology', payload: topology });
    for (const i of order) await ingest(app, readings[i]);
    const incident = (await app.inject({ method: 'POST', url: '/anomalies/detect', payload: { assetId: 'valve-1', metric: 'pressure', threshold: 10 } })).json();
    const events = await replay(app, T - 1, T + 1);
    const cause = (await app.inject({ method: 'GET', url: `/incidents/${incident.id}/root-cause` })).json();
    await app.close();
    return { events, incident, cause };
  };
  const a = await runPipeline([0, 1, 2, 3, 4]);
  const b = await runPipeline([2, 4, 1, 0, 3]);

  assert.deepEqual(b.events.map(e => e.id), a.events.map(e => e.id));
  assert.deepEqual(b.incident.evidence, a.incident.evidence);
  assert.equal(b.incident.detectedAt, a.incident.detectedAt);
  assert.deepEqual(b.cause.candidates, a.cause.candidates);
  assert.equal(b.cause.confidence, a.cause.confidence);
});
