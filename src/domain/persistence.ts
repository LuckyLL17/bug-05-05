import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { TwinStore } from './store';
import { Asset, DomainEvent, Incident, Telemetry, TopologyVersion, WorkOrder } from './types';

interface StoreSnapshot {
  version: 1;
  assets: Asset[];
  telemetry: Telemetry[];
  events: DomainEvent[];
  incidents: Incident[];
  workOrders: WorkOrder[];
  topology: TopologyVersion[];
}

const snapshot = (store: TwinStore): StoreSnapshot => ({
  version: 1,
  assets: [...store.assets.values()],
  telemetry: store.telemetry,
  events: store.events,
  incidents: [...store.incidents.values()],
  workOrders: [...store.workOrders.values()],
  topology: store.topology,
});

/** Atomic write: a crash mid-save never leaves a half-written store behind. */
export const saveStore = (store: TwinStore, path: string): void => {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(snapshot(store)));
  renameSync(tmp, path);
};

/**
 * Reloads a previously saved store. Events keep their persisted id/timestamp/sequence,
 * so replay order after a restart is identical to the order before it.
 */
export const loadStore = (path: string): TwinStore => {
  const store = new TwinStore();
  if (!existsSync(path)) return store;
  const data = JSON.parse(readFileSync(path, 'utf8')) as Partial<StoreSnapshot>;
  for (const a of data.assets ?? []) store.assets.set(a.id, a);
  store.telemetry = (data.telemetry ?? []).map(t => ({ ...t }));
  store.events = (data.events ?? []).map(e => ({ ...e, payload: { ...e.payload } }));
  for (const i of data.incidents ?? []) store.incidents.set(i.id, i);
  for (const w of data.workOrders ?? []) store.workOrders.set(w.id, w);
  store.topology = (data.topology ?? []).map(v => structuredClone(v));
  return store;
};

/** Loads (or creates) the store at `path` and persists every subsequent mutation to it. */
export const openStore = (path: string): TwinStore => {
  const store = loadStore(path);
  store.persist = () => saveStore(store, path);
  return store;
};
