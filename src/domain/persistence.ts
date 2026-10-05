import { existsSync, mkdirSync, renameSync, writeFileSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { AuditEntry } from '../services/audit-service';
import { TwinStore } from '../domain/store';
import { compareBusinessOrder } from '../core/ordering';
import { Asset, DomainEvent, Incident, Telemetry, TopologyVersion, WorkOrder } from '../domain/types';

interface Snapshot {
  version: 1;
  eventSequence: number;
  assets: Asset[];
  telemetry: Telemetry[];
  events: DomainEvent[];
  incidents: Incident[];
  workOrders: WorkOrder[];
  topology: TopologyVersion[];
  audit: AuditEntry[];
}

/**
 * 基于 JSON 文件的状态快照。服务每次状态变更后同步原子落盘，
 * 使系统序列（全局 sequence 与同业务时间 timeSequence）可持久化：
 * 进程重启后读取同一文件即可恢复完全一致的事件次序。
 */
export class SnapshotStore {
  constructor(private readonly filePath: string) {}

  save(store: TwinStore, audit: AuditEntry[]): void {
    const snapshot: Snapshot = {
      version: 1,
      eventSequence: store.eventSequence,
      assets: [...store.assets.values()],
      telemetry: store.telemetry,
      events: store.events,
      incidents: [...store.incidents.values()],
      workOrders: [...store.workOrders.values()],
      topology: store.topology,
      audit,
    };
    mkdirSync(dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(snapshot), 'utf8');
    renameSync(tmp, this.filePath);
  }

  /** 加载快照；文件不存在时返回空存储。 */
  load(): { store: TwinStore; audit: AuditEntry[] } {
    const store = new TwinStore();
    if (!existsSync(this.filePath)) return { store, audit: [] };

    const raw = JSON.parse(readFileSync(this.filePath, 'utf8')) as Partial<Snapshot>;
    for (const a of raw.assets ?? []) store.assets.set(a.id, a);
    for (const i of raw.incidents ?? []) store.incidents.set(i.id, i);
    for (const w of raw.workOrders ?? []) store.workOrders.set(w.id, w);
    store.topology = raw.topology ?? [];

    // telemetry 按 eventId 去重，重复 eventId 只保留一条
    const seenTelemetry = new Set<string>();
    for (const t of raw.telemetry ?? []) {
      const key = t.eventId ?? '';
      if (key) {
        if (seenTelemetry.has(key)) continue;
        seenTelemetry.add(key);
      }
      store.telemetry.push(t);
    }

    // 事件按 id 去重；忽略结构损坏的记录，避免污染重建过程
    const seenEvents = new Set<string>();
    for (const e of raw.events ?? []) {
      if (!e || typeof e.id !== 'string' || typeof e.timestamp !== 'number') continue;
      if (seenEvents.has(e.id)) continue;
      seenEvents.add(e.id);
      store.events.push(e);
    }

    rebuildOrdering(store);
    store.eventSequence = Math.max(raw.eventSequence ?? 0, ...store.events.map(e => e.sequence || 0), 0);
    return { store, audit: raw.audit ?? [] };
  }
}

/**
 * 为每个业务时间戳重建系统序列：同 timestamp 的事件按 eventId 排序后
 * 从 0 开始连续编号。该序列只依赖事件集合本身（内容），
 * 因此无论以何种写入顺序提交、重启加载或重新查询，结果完全一致。
 */
export function rebuildOrdering(store: TwinStore): void {
  const byTimestamp = new Map<number, DomainEvent[]>();
  for (const e of store.events) {
    const bucket = byTimestamp.get(e.timestamp);
    if (bucket) bucket.push(e);
    else byTimestamp.set(e.timestamp, [e]);
  }
  for (const bucket of byTimestamp.values()) {
    bucket.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    bucket.forEach((e, idx) => { e.timeSequence = idx; });
  }
  store.events.sort(compareBusinessOrder);
}
