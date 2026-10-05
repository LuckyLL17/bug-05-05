import { DomainError } from '../core/errors';
import { TwinStore } from '../domain/store';
import { TopologyVersion } from '../domain/types';

interface ImpactEdge { from: string; to: string; weight: number; traceId: string }

export class TopologyService {
  constructor(private store: TwinStore, private readonly onChange: () => void = () => {}) {}

  publish(version: TopologyVersion) {
    if (version.version !== this.store.topology.length + 1) {
      throw new DomainError('VERSION_GAP', 'topology version must be sequential');
    }
    const cloned = structuredClone(version);
    // 边也按 (weight desc, from, to) 规范化存储，保证遍历结果不依赖提交顺序
    cloned.edges.sort(edgeOrder);
    this.store.topology.push(cloned);
    this.onChange();
    return cloned;
  }

  current(at: number) {
    const candidates = this.store.topology.filter(v => v.effectiveAt <= at);
    if (!candidates.length) throw new DomainError('NO_TOPOLOGY', 'no effective topology');
    return candidates[candidates.length - 1];
  }

  /** 影响链：权重降序，权重相同按 from/to 节点 ID 排序；traceId 由边内容确定性生成。 */
  impact(assetId: string, at: number): ImpactEdge[] {
    const t = this.current(at);
    return t.edges
      .filter(e => e.from === assetId || e.to === assetId)
      .sort(edgeOrder)
      .map(e => ({ ...e, traceId: `trace_${e.from}_${e.to}` }));
  }
}

const edgeOrder = (a: { from: string; to: string; weight: number }, b: { from: string; to: string; weight: number }) =>
  b.weight - a.weight
  || (a.from < b.from ? -1 : a.from > b.from ? 1 : 0)
  || (a.to < b.to ? -1 : a.to > b.to ? 1 : 0);
