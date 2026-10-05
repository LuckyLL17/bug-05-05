import { FastifyInstance } from 'fastify';
import { TwinStore } from '../domain/store';
import { TelemetryService } from '../services/telemetry-service';
import { AnomalyService } from '../services/anomaly-service';
import { TopologyService } from '../services/topology-service';
import { RootCauseService } from '../services/root-cause-service';
import { WorkflowService } from '../services/workflow-service';
import { AuditService } from '../services/audit-service';

export function registerRoutes(app: FastifyInstance, store: TwinStore, persist: () => void, audit: AuditService) {
  const telemetry = new TelemetryService(store, persist);
  const anomalies = new AnomalyService(store, persist);
  const topology = new TopologyService(store, persist);
  const causes = new RootCauseService(store, topology);
  const workflows = new WorkflowService(store, persist);

  app.get('/health', async () => ({ ok: true }));

  app.post('/topology', async (req, res) => {
    try { return topology.publish(req.body as any); }
    catch (e: any) { return res.code(400).send({ code: e.code, message: e.message }); }
  });

  app.post('/telemetry', async (req, res) => {
    try {
      const e = telemetry.ingest(req.body as any);
      audit.record('telemetry.ingest', e.id, { assetId: e.assetId });
      return e;
    } catch (err: any) {
      return res.code(400).send({ code: err.code, message: err.message });
    }
  });

  app.get('/telemetry/replay', async req => {
    const q = req.query as any;
    return telemetry.replay(Number(q.from), Number(q.to));
  });

  app.post('/anomalies/detect', async (req, res) => {
    try {
      const b = req.body as any;
      return anomalies.detect(b.assetId, b.metric, Number(b.threshold));
    } catch (e: any) {
      return res.code(400).send({ message: e.message });
    }
  });

  app.get('/incidents/:id/root-cause', async (req, res) => {
    try { return causes.analyze((req.params as any).id); }
    catch (e: any) { return res.code(404).send({ message: e.message }); }
  });

  app.post('/work-orders', async (req, res) => {
    try {
      return workflows.create((req.body as any).incidentId, (req.body as any).steps || []);
    } catch (e: any) {
      return res.code(400).send({ code: e.code, message: e.message });
    }
  });

  app.post('/work-orders/:id/transition', async (req, res) => {
    try {
      return workflows.transition((req.params as any).id, (req.body as any).state);
    } catch (e: any) {
      return res.code(400).send({ code: e.code, message: e.message });
    }
  });

  app.get('/audit', async req => audit.list((req.query as any).entityId));
}
