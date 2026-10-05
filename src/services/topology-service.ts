import { DomainError } from '../core/errors'; import { stableId } from '../core/sequence'; import { TwinStore } from '../domain/store'; import { TopologyVersion } from '../domain/types';
export class TopologyService {
 constructor(private store:TwinStore){}
 publish(version:TopologyVersion){ if(version.version !== this.store.topology.length+1) throw new DomainError('VERSION_GAP','topology version must be sequential'); this.store.topology.push(structuredClone(version)); this.store.persist(); return version; }
 current(at:number){ const candidates=this.store.topology.filter(v=>v.effectiveAt<=at); if(!candidates.length) throw new DomainError('NO_TOPOLOGY','no effective topology'); return candidates[candidates.length-1]; }
 impact(assetId:string,at:number){ const t=this.current(at); return t.edges.filter(e=>e.from===assetId||e.to===assetId).sort((a,b)=>b.weight-a.weight||a.from.localeCompare(b.from)||a.to.localeCompare(b.to)).map(e=>({...e, traceId:stableId('trace',t.version,e.from,e.to,e.weight)})); }
}
