import { DomainError } from '../core/errors';
import { newId } from '../core/id';
import { compareBusinessOrder, compareTelemetry } from '../core/ordering';
import { rebuildOrdering } from '../domain/persistence';
import { TwinStore } from '../domain/store';
import { DomainEvent, Telemetry } from '../domain/types';

export class TelemetryService {
  constructor(private store: TwinStore, private readonly onChange: () => void = () => {}) {}

  /**
   * 接入一条遥测并登记为领域事件。
   * - eventId 幂等：相同 eventId 重复提交不会插入额外节点，直接返回既有事件；
   * - 全局系统序列号由持久化计数器单调分配，重启后延续；
   * - 同一业务时间的系统序列由事件内容确定性重建，与写入/到达顺序无关。
   */
  ingest(input: Telemetry): DomainEvent {
    if (!input || typeof input.assetId !== 'string' || !input.assetId) {
      throw new DomainError('INVALID_TELEMETRY', 'assetId is required');
    }
    if (typeof input.observedAt !== 'number' || Number.isNaN(input.observedAt)) {
      throw new DomainError('INVALID_TELEMETRY', 'observedAt must be a number');
    }
    if (typeof input.value !== 'number' || Number.isNaN(input.value)) {
      throw new DomainError('INVALID_TELEMETRY', 'value must be a number');
    }

    const eventId = input.eventId && input.eventId.trim() ? input.eventId : newId('evt');

    // 重复 eventId：不插入额外节点（遥测样本与领域事件均幂等）
    const existing = this.store.events.find(e => e.id === eventId);
    if (existing) return existing;

    const sample: Telemetry = { ...input, eventId };
    this.store.telemetry.push(sample);

    this.store.eventSequence += 1;
    const event: DomainEvent = {
      id: eventId,
      type: 'telemetry',
      assetId: input.assetId,
      timestamp: input.observedAt,
      sequence: this.store.eventSequence,
      timeSequence: 0,
      payload: { metric: input.metric, value: input.value, quality: input.quality },
    };
    this.store.events.push(event);

    // 重建同一业务时间内的稳定系统序列，并按业务次序归位
    rebuildOrdering(this.store);
    this.onChange();
    return event;
  }

  history(assetId: string, metric?: string): Telemetry[] {
    return this.store.telemetry
      .filter(t => t.assetId === assetId && (!metric || t.metric === metric))
      .sort(compareTelemetry);
  }

  /** 回放：先按业务时间，再按同业务时间的系统序列输出。 */
  replay(from: number, to: number): DomainEvent[] {
    return this.store.events
      .filter(e => e.timestamp >= from && e.timestamp <= to)
      .sort(compareBusinessOrder);
  }
}
