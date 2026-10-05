import { stableSequence, telemetryEventId } from '../core/sequence'; import { compareEvents, compareTelemetry } from '../domain/ordering'; import { TwinStore } from '../domain/store'; import { DomainEvent, Telemetry } from '../domain/types';
export interface TelemetryInput extends Telemetry { eventId?:string }
export class TelemetryService {
 constructor(private store:TwinStore){}
 ingest(input:TelemetryInput){
  // Identity comes from the client-supplied eventId or, failing that, from the
  // telemetry content itself — never from arrival order or a random generator.
  const id=input.eventId??telemetryEventId(input);
  // Idempotent ingest: a duplicate eventId returns the already-stored event and
  // never inserts an extra node into the causal chain.
  const existing=this.store.events.find(e=>e.id===id);
  if(existing) return existing;
  const event:DomainEvent={id,type:'telemetry',assetId:input.assetId,timestamp:input.observedAt,sequence:stableSequence(id),payload:{metric:input.metric,value:input.value,quality:input.quality}};
  this.store.telemetry.push({assetId:input.assetId,metric:input.metric,value:input.value,unit:input.unit,observedAt:input.observedAt,quality:input.quality,eventId:id});
  this.store.events.push(event);
  this.store.persist();
  return event;
 }
 history(assetId:string,metric?:string){return this.store.telemetry.filter(t=>t.assetId===assetId&&(!metric||t.metric===metric)).sort(compareTelemetry)}
 replay(from:number,to:number){return this.store.events.filter(e=>e.timestamp>=from&&e.timestamp<=to).sort(compareEvents)}
}
