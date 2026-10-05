import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SnapshotStore } from '../domain/persistence';
import { TwinStore } from '../domain/store';
import { TelemetryService } from '../services/telemetry-service';
import { DomainEvent } from '../domain/types';

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'twin-svc-'));
  const file = join(dir, 'state.json');
  const snapshots = new SnapshotStore(file);
  const { store } = snapshots.load();
  const svc = new TelemetryService(store, () => snapshots.save(store, []));
  return { dir, file, snapshots, store, svc };
}

const ids = (events: DomainEvent[]) => events.map(e => e.id);

test('同一业务时间乱序写入：回放次序与到达顺序无关', () => {
  const a = setup();
  const b = setup();
  try {
    const T = 1000;
    const sample = (id: string, value: number) => ({ eventId: id, assetId: 'p1', metric: 'rpm', value, unit: 'rpm', observedAt: T, quality: 'good' as const });

    // 实例 A 写入顺序：c, a, b（乱序）
    a.svc.ingest(sample('evt-c', 3));
    a.svc.ingest(sample('evt-a', 1));
    a.svc.ingest(sample('evt-b', 2));

    // 实例 B 以完全相反的到达顺序提交同一批数据
    b.svc.ingest(sample('evt-b', 2));
    b.svc.ingest(sample('evt-a', 1));
    b.svc.ingest(sample('evt-c', 3));

    const expected = ['evt-a', 'evt-b', 'evt-c'];
    assert.deepEqual(ids(a.svc.replay(0, 10_000)), expected);
    assert.deepEqual(ids(b.svc.replay(0, 10_000)), expected);

    // 乱序补提交：晚到的事件插入后，系统序列重排但最终次序仍确定
    const c = setup();
    c.svc.ingest(sample('evt-c', 3));
    c.svc.ingest(sample('evt-a', 1)); // 同时间晚到，按 eventId 仍排在 c 前
    assert.deepEqual(ids(c.svc.replay(0, 10_000)), ['evt-a', 'evt-c']);
  } finally {
    rmSync(a.dir, { recursive: true, force: true });
    rmSync(b.dir, { recursive: true, force: true });
  }
});


test('多次回放与不同时间先后关系：结果稳定且不同时间顺序不变', () => {
  const { svc, dir } = setup();
  try {
    svc.ingest({ eventId: 'z-200', assetId: 'p', metric: 'm', value: 9, unit: 'u', observedAt: 200, quality: 'good' });
    svc.ingest({ eventId: 'b-100', assetId: 'p', metric: 'm', value: 7, unit: 'u', observedAt: 100, quality: 'good' });
    svc.ingest({ eventId: 'a-200', assetId: 'p', metric: 'm', value: 8, unit: 'u', observedAt: 200, quality: 'good' });
    svc.ingest({ eventId: 'a-100', assetId: 'p', metric: 'm', value: 6, unit: 'u', observedAt: 100, quality: 'good' });

    const expected = ['a-100', 'b-100', 'a-200', 'z-200'];
    assert.deepEqual(ids(svc.replay(0, 9999)), expected);
    // 重复查询：多次回放完全一致
    assert.deepEqual(ids(svc.replay(0, 9999)), expected);
    assert.deepEqual(ids(svc.replay(0, 9999)), expected);
    // 时间窗口过滤仍遵守同一序列
    assert.deepEqual(ids(svc.replay(100, 100)), ['a-100', 'b-100']);
    // 同业务时间的系统序列连续且按 eventId 确定
    const seq = Object.fromEntries(svc.replay(0, 9999).map(e => [e.id, e.timeSequence]));
    assert.deepEqual(seq, { 'a-100': 0, 'b-100': 1, 'a-200': 0, 'z-200': 1 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('重复 eventId 幂等：不插入额外节点', () => {
  const { svc, store, dir } = setup();
  try {
    const first = svc.ingest({ eventId: 'dup-1', assetId: 'p', metric: 'm', value: 1, unit: 'u', observedAt: 500, quality: 'good' });
    const second = svc.ingest({ eventId: 'dup-1', assetId: 'p', metric: 'm', value: 999, unit: 'u', observedAt: 500, quality: 'bad' });

    assert.equal(second, first, '重复提交应返回既有事件');
    assert.equal(store.events.filter(e => e.id === 'dup-1').length, 1);
    assert.equal(store.telemetry.filter(t => t.eventId === 'dup-1').length, 1);
    assert.deepEqual(ids(svc.replay(0, 9999)), ['dup-1']);
    // 全局序列号不被重复请求推进
    assert.equal(store.eventSequence, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('快照重新加载：序列、次序、去重全部保持一致', () => {
  const ctx = setup();
  try {
    const T = 700;
    ctx.svc.ingest({ eventId: 'evt-x', assetId: 'p', metric: 'm', value: 1, unit: 'u', observedAt: T, quality: 'good' });
    ctx.svc.ingest({ eventId: 'evt-w', assetId: 'p', metric: 'm', value: 2, unit: 'u', observedAt: T, quality: 'good' });
    ctx.svc.ingest({ eventId: 'evt-y', assetId: 'p', metric: 'm', value: 3, unit: 'u', observedAt: T, quality: 'good' });
    const before = ctx.svc.replay(0, 9999);

    // 模拟服务重启：从同一文件重新读取
    const reloaded = new SnapshotStore(ctx.file).load();
    const svc2 = new TelemetryService(reloaded.store, () => ctx.snapshots.save(reloaded.store, []));
    assert.deepEqual(ids(svc2.replay(0, 9999)), ['evt-w', 'evt-x', 'evt-y']);
    assert.deepEqual(ids(svc2.replay(0, 9999)), ids(before));
    assert.equal(reloaded.store.eventSequence, 3, '全局序列号计数器跨重启恢复');

    // 重启后继续接入：序列号单调延续，不与既有事件冲突
    svc2.ingest({ eventId: 'evt-v', assetId: 'p', metric: 'm', value: 4, unit: 'u', observedAt: T, quality: 'good' });
    const joined = svc2.replay(0, 9999);
    assert.deepEqual(ids(joined), ['evt-v', 'evt-w', 'evt-x', 'evt-y']);
    assert.deepEqual(new Set(joined.map(e => e.sequence)).size, joined.length, '全局序列号无碰撞');

    // 重启后重复 eventId 仍然幂等
    svc2.ingest({ eventId: 'evt-w', assetId: 'p', metric: 'm', value: 2, unit: 'u', observedAt: T, quality: 'good' });
    assert.equal(reloaded.store.events.length, 4);
  } finally {
    rmSync(ctx.dir, { recursive: true, force: true });
  }
});

test('无 eventId 时由系统分配，历史查询次序也稳定', () => {
  const { svc, dir } = setup();
  try {
    const e1 = svc.ingest({ assetId: 'p', metric: 'm', value: 1, unit: 'u', observedAt: 10, quality: 'good' });
    const e2 = svc.ingest({ assetId: 'p', metric: 'm', value: 2, unit: 'u', observedAt: 10, quality: 'good' });
    assert.match(e1.id, /^evt_/);
    assert.notEqual(e1.id, e2.id);
    const history = svc.history('p', 'm');
    assert.deepEqual(history.map(t => t.eventId), svc.history('p', 'm').map(t => t.eventId));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('损坏/缺字段的输入被拒绝，不产生事件', () => {
  const { svc, store, dir } = setup();
  try {
    assert.throws(() => svc.ingest({ assetId: '', metric: 'm', value: 1, unit: 'u', observedAt: 1, quality: 'good' }));
    assert.throws(() => svc.ingest({ assetId: 'p', metric: 'm', value: 1, unit: 'u', observedAt: NaN, quality: 'good' }));
    assert.equal(store.events.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
