import { EventEmitter } from 'events';

/**
 * The border forwarder's module — F2a ships ONLY the event bus.
 *
 * WHY A NEAR-EMPTY FILE IS THE RIGHT DELIVERABLE HERE: `router.ts` needs to
 * announce "a row was enqueued for this alias" the moment F2a's remote branch
 * exists, and F2b's forwarder needs to hear it. If the emitter arrived with the
 * forwarder, F2a's import would not resolve and the remote branch could not
 * ship independently. So the SEAM lands first and the machine lands second —
 * and every symbol crossing that boundary says which phase created it.
 *
 * F2b adds: the `Forwarder` class, the drain query, the token bucket and
 * in-flight cap, outcome handling, and the `create(row)` factory that
 * `POST /outbound-peers` refuses to work without.
 */

/**
 * Enqueue notifications, one per outbound alias.
 *
 * FIRE-AND-FORGET BY CONTRACT. `routeDirect` emits AFTER its synchronous
 * section — after the duplicate check, the insert and the ack — and never
 * awaits. An await between the duplicate check and the insert lets two frames
 * interleave, both pass the check, and the second insert throw; that invariant
 * is why this is an EventEmitter and not a promise-returning call.
 *
 * A listener that throws must not reach the router: EventEmitter delivers
 * synchronously, so F2b's handler owns its own try/catch. Stated here because
 * the coupling is invisible from the emit site.
 */
export const borderEvents = new EventEmitter();

/** Payload of the only event F2a emits: the alias whose queue just grew. */
export type EnqueuedEvent = string;
