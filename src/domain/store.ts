import { Asset, DomainEvent, Incident, Telemetry, TopologyVersion, WorkOrder } from './types';
export class TwinStore {
  assets = new Map<string,Asset>();
  telemetry:Telemetry[]=[];
  events:DomainEvent[]=[];
  incidents=new Map<string,Incident>();
  workOrders=new Map<string,WorkOrder>();
  topology:TopologyVersion[]=[];
  /** 已分配出的最大全局系统序列号；与快照一起持久化，重启后单调延续。 */
  eventSequence = 0;
}
