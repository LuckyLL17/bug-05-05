import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FastifyInstance } from 'fastify';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildApp } from '../app';

let dirs: string[] = [];
function newStateFile() {
  const dir = mkdtempSync(join(tmpdir(), 'twin-e2e-'));
  dirs.push(dir);
  return join(dir, 'state.json');
}

async function post(app: FastifyInstance, url: string, body: unknown) {
  const res = await app.inject({ method: 'POST', url, payload: body as never });
  return { status: res.statusCode, body: res.json<any>() };
}

async function getJson(app: FastifyInstance, url: string) {
  const res = await app.inject({ method: 'GET', url });
  return { status: res.statusCode, body: res.json<any>() };
}

test.after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

const telemetry = (eventId: string, observedAt: number, value: number) => ({
  eventId, assetId: 'reactor-1', metric: 'temperature', value, unit: 'C', observedAt, quality: 'good' as const,
});

test('HTTP：同时间戳乱序写入 + 多次 /telemetry/replay 顺序一致', async () => {
  const file = newStateFile();
  const app = buildApp({ stateFile: file });

  try {
    // 乱序到达：同业务时间 5000 的三个事件按 c, a, b 顺序提交
    await post(app, '/telemetry', telemetry('evt-c', 5000, 120));
    await post(app, '/telemetry', telemetry('evt-a', 5000, 100));
    await post(app, '/telemetry', telemetry('evt-b', 5000, 110));
    // 另一个时间点
    await post(app, '/telemetry', telemetry('evt-z', 4000, 90));

    const replay1 = (await getJson(app, '/telemetry/replay?from=0&to=99999')).body.map((e: any) => e.id);
    const replay2 = (await getJson(app, '/telemetry/replay?from=0&to=99999')).body;
    assert.deepEqual(replay1, ['evt-z', 'evt-a', 'evt-b', 'evt-c'], '先按业务时间，再按同时间系统序列');
    assert.deepEqual(replay2.map((e: any) => e.id), replay1, '重复查询结果一致');
    assert.deepEqual(replay2.map((e: any) => [e.timestamp, e.timeSequence]), [
      [4000, 0], [5000, 0], [5000, 1], [5000, 2],
    ]);

    // 重复 eventId 不产生额外节点（HTTP 幂等）
    const dup = await post(app, '/telemetry', telemetry('evt-a', 5000, 100));
    assert.equal(dup.body.id, 'evt-a');
    assert.equal((await getJson(app, '/telemetry/replay?from=0&to=99999')).body.length, 4);
  } finally {
    await app.close();
  }
});

test('HTTP：服务重启后读取同一快照，回放与根因路径保持稳定', async () => {
  const file = newStateFile();

  // 第一个进程实例：发布拓扑并乱序写入同时间戳遥测
  const app1 = buildApp({ stateFile: file });
  let incidentId: string;
  try {
    await post(app1, '/topology', {
      version: 1, effectiveAt: 0,
      edges: [
        { from: 'valve-1', to: 'reactor-1', weight: 0.8 },
        { from: 'pump-1', to: 'reactor-1', weight: 0.5 },
        { from: 'sensor-1', to: 'reactor-1', weight: 0.8 },
      ],
    });
    // 同业务时间、乱序提交；阈值检测的证据顺序也必须稳定
    await post(app1, '/telemetry', telemetry('evt-c', 5000, 220));
    await post(app1, '/telemetry', telemetry('evt-a', 5000, 180));
    await post(app1, '/telemetry', telemetry('evt-b', 5000, 200));

    const detected = await post(app1, '/anomalies/detect', { assetId: 'reactor-1', metric: 'temperature', threshold: 100 });
    assert.equal(detected.status, 200);
    incidentId = detected.body.id;
  } finally {
    await app1.close();
  }

  // 模拟服务重启：重新从磁盘加载
  const app2 = buildApp({ stateFile: file });
  try {
    const replay = (await getJson(app2, '/telemetry/replay?from=0&to=99999')).body;
    assert.deepEqual(replay.map((e: any) => e.id), ['evt-a', 'evt-b', 'evt-c']);
    assert.deepEqual(replay.map((e: any) => [e.timestamp, e.timeSequence, e.sequence]), [
      [5000, 0, 2], [5000, 1, 3], [5000, 2, 1],
    ], '同时间按系统序列输出；全局 arrival sequence 反映真实到达顺序且已持久化');

    // 再次重启（重复加载同一文件）结果必须完全相同
    await app2.close();
    const app3 = buildApp({ stateFile: file });
    const again = (await getJson(app3, '/telemetry/replay?from=0&to=99999')).body;
    assert.deepEqual(again.map((e: any) => e.id), ['evt-a', 'evt-b', 'evt-c']);

    // 根因分析：权重降序，权重相同的候选按节点 ID 稳定排序；traceId 确定性
    const rc1 = (await getJson(app3, `/incidents/${incidentId}/root-cause`)).body;
    assert.deepEqual(rc1.candidates.map((c: any) => c.assetId), ['sensor-1', 'valve-1', 'pump-1']);
    assert.deepEqual(rc1.candidates.map((c: any) => [c.assetId, c.weight, c.traceId]), [
      ['sensor-1', 0.8, 'trace_sensor-1_reactor-1'],
      ['valve-1', 0.8, 'trace_valve-1_reactor-1'],
      ['pump-1', 0.5, 'trace_pump-1_reactor-1'],
    ]);

    // 重复根因分析结果一致
    const rc2 = (await getJson(app3, `/incidents/${incidentId}/root-cause`)).body;
    assert.deepEqual(rc2, rc1);

    // 再重启一次，根因路径仍然一致
    await app3.close();
    const app4 = buildApp({ stateFile: file });
    const rc3 = (await getJson(app4, `/incidents/${incidentId}/root-cause`)).body;
    assert.deepEqual(rc3.candidates.map((c: any) => c.assetId), ['sensor-1', 'valve-1', 'pump-1']);
    assert.equal(rc3.confidence, rc1.confidence);
    await app4.close();
  } finally {
    // app2 可能已在上面 close，重复 close 安全
    await app2.close().catch(() => {});
  }
});

test('HTTP：重启后补提交的事件获得单调全局序列号且不改变跨时间先后', async () => {
  const file = newStateFile();
  const app1 = buildApp({ stateFile: file });
  try {
    await post(app1, '/telemetry', telemetry('evt-old', 1000, 10));
  } finally {
    await app1.close();
  }

  const app2 = buildApp({ stateFile: file });
  try {
    // 晚到一个业务时间更早的事件：业务时间排序不变，全局序列号在计数器之后延续
    await post(app2, '/telemetry', telemetry('evt-late', 900, 9));
    const replay = (await getJson(app2, '/telemetry/replay?from=0&to=99999')).body;
    assert.deepEqual(replay.map((e: any) => e.id), ['evt-late', 'evt-old']);
    const late = replay.find((e: any) => e.id === 'evt-late');
    const old = replay.find((e: any) => e.id === 'evt-old');
    assert.equal(late.sequence, 2);
    assert.equal(old.sequence, 1);
  } finally {
    await app2.close();
  }
});
