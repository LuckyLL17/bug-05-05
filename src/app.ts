import Fastify, { FastifyInstance } from 'fastify';
import { SnapshotStore } from './domain/persistence';
import { TwinStore } from './domain/store';
import { registerRoutes } from './routes/app-routes';
import { AuditService } from './services/audit-service';

export interface AppContext {
  app: FastifyInstance;
  store: TwinStore;
  snapshots: SnapshotStore | null;
  audit: AuditService;
}

export function buildApp(options: { stateFile?: string } = {}): FastifyInstance {
  const app = Fastify({ logger: false });
  const snapshots = options.stateFile ? new SnapshotStore(options.stateFile) : null;

  const { store, audit: loadedAudit } = snapshots
    ? snapshots.load()
    : { store: new TwinStore(), audit: [] };

  const audit = new AuditService(loadedAudit, () => snapshots?.save(store, audit.entries));
  registerRoutes(app, store, () => snapshots?.save(store, audit.entries), audit);
  return app;
}
