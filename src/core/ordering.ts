import { DomainEvent, Telemetry } from '../domain/types';

/**
 * 事件回放的稳定全序：
 *  1. 业务时间（timestamp）—— 不同时间的既有先后关系永不改变；
 *  2. 同一业务时间内的系统序列 timeSequence —— 与写入顺序无关、可持久化，
 *     由事件内容（eventId）确定性推导，乱序提交、重复查询、重启加载后均一致；
 *  3. eventId 作为最终兜底，保证同一 timeSequence 下仍有确定全序。
 */
export function compareBusinessOrder(a: DomainEvent, b: DomainEvent): number {
  if (a.timestamp !== b.timestamp) return a.timestamp - b.timestamp;
  if (a.timeSequence !== b.timeSequence) return a.timeSequence - b.timeSequence;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** 遥测样本的稳定次序：业务时间优先，其次 eventId。 */
export function compareTelemetry(a: Telemetry, b: Telemetry): number {
  if (a.observedAt !== b.observedAt) return a.observedAt - b.observedAt;
  const ai = a.eventId ?? '';
  const bi = b.eventId ?? '';
  return ai < bi ? -1 : ai > bi ? 1 : 0;
}
