import { TwinStore } from '../domain/store';
import { TopologyService } from './topology-service';

interface ImpactEdge { from: string; to: string; weight: number; traceId: string }

export class RootCauseService {
  constructor(private store: TwinStore, private topology: TopologyService) {}

  analyze(incidentId: string) {
    const incident = this.store.incidents.get(incidentId);
    if (!incident) throw new Error('incident not found');

    const focus = incident.assetIds[0];
    const graph: ImpactEdge[] = incident.assetIds
      .flatMap(id => this.topology.impact(id, incident.detectedAt));

    // 因果候选：只保留指向焦点资产的上游边；权重降序，权重相同按来源节点 ID 定序，
    // 使同一批数据在乱序写入、重复查询、重新加载后得到完全一致的根因路径。
    const upstream = graph
      .filter(e => e.to === focus)
      .sort((a, b) =>
        b.weight - a.weight
        || (a.from < b.from ? -1 : a.from > b.from ? 1 : 0));

    return {
      incidentId,
      confidence: Math.min(.99, .55 + upstream.length * .1),
      candidates: upstream.map(e => ({
        assetId: e.from,
        weight: e.weight,
        reason: 'topology dependency',
        traceId: e.traceId,
      })),
    };
  }
}
