import { stableSequence, telemetryEventId } from '../core/sequence';
import { DomainEvent, Telemetry } from './types';

const compareStrings = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Canonical replay order: business time first, then the stable system sequence,
 * then the event id as a final deterministic tiebreak. This is a pure function of
 * the event set — it never depends on ingestion order or internal traversal order.
 */
export const compareEvents = (a: DomainEvent, b: DomainEvent): number =>
  a.timestamp - b.timestamp || a.sequence - b.sequence || compareStrings(a.id, b.id);

const sequenceOf = (t: Telemetry): number => stableSequence(t.eventId ?? telemetryEventId(t));
const idOf = (t: Telemetry): string => t.eventId ?? telemetryEventId(t);

/** Same canonical ordering applied to raw telemetry samples (history / anomaly detection). */
export const compareTelemetry = (a: Telemetry, b: Telemetry): number =>
  a.observedAt - b.observedAt || sequenceOf(a) - sequenceOf(b) || compareStrings(idOf(a), idOf(b));
