import { newId } from '../core/id';

export interface AuditEntry { id: string; action: string; entityId: string; at: number; metadata: Record<string, unknown> }

export class AuditService {
  entries: AuditEntry[] = [];

  constructor(
    initial: AuditEntry[] = [],
    private readonly onChange: () => void = () => {},
  ) {
    this.entries = [...initial];
  }

  record(action: string, entityId: string, metadata: Record<string, unknown> = {}) {
    const e: AuditEntry = { id: newId('audit'), action, entityId, at: Date.now(), metadata };
    this.entries.push(e);
    this.onChange();
    return e;
  }

  list(entityId?: string) {
    return entityId ? this.entries.filter(e => e.entityId === entityId) : [...this.entries];
  }
}
