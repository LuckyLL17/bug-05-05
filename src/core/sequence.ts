import { createHash } from 'node:crypto';

const sha256 = (input: string): string => createHash('sha256').update(input).digest('hex');

/**
 * Deterministic id derived from content. Same input always yields the same id,
 * regardless of arrival order, process restarts or repeated ingestion.
 */
export const stableId = (prefix: string, ...parts: unknown[]): string =>
  `${prefix}_${sha256(JSON.stringify(parts)).slice(0, 32)}`;

/**
 * Deterministic system sequence for an event, derived from its identity.
 * 52-bit safe integer, persistable alongside the event. Because it depends only
 * on the event id (never on ingestion order or store size), the same batch of
 * events always produces the same sequence assignment.
 */
export const stableSequence = (eventId: string): number =>
  parseInt(sha256(eventId).slice(0, 13), 16);

/** Deterministic event id for a telemetry sample when the client does not supply one. */
export const telemetryEventId = (t: {
  assetId: string; metric: string; value: number; unit: string; observedAt: number; quality: string;
}): string => stableId('evt', t.assetId, t.metric, t.value, t.unit, t.observedAt, t.quality);
