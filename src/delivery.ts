/**
 * Delivery contract between the core and the reply sinks (RD-001-G interface freeze v1).
 * Shared public types live here (owned by the core); sink-only types stay in sinks.ts.
 * The sinks module may later export `sinkReplaySafe(to)` and return `outcome`/`state`; until then the
 * conservative local fallbacks below apply (file / hufu-report replay-safe; everything else not).
 */
import type { Envelope, ReplyTo } from "./envelope.js";
import * as sinks from "./sinks.js";
import type { SinkResult } from "./sinks.js";

/** Passed as `ctx.delivery` on every core call to `deliver`. `revision` is per task, monotonic, kept on redelivery. */
export interface DeliveryContext {
  taskId: string;
  replyHash: string;
  revision: number;
}

export type DeliveryOutcome = "delivered" | "not_sent" | "unknown";
export type SinkState = "delivered" | "duplicate" | "superseded" | "conflict" | "failed";

/** What a sink may return under freeze v1 (all extra fields optional; old sinks return plain SinkResult). */
export type ExtendedSinkResult = SinkResult & { outcome?: DeliveryOutcome; state?: SinkState };

/** Delivery state of one reply, kept in the task receipt (`replies[i].delivery`), separate from business status. */
export type DeliveryState = "pending" | DeliveryOutcome | "failed";

export interface DeliveryRecord {
  state: DeliveryState;
  attempts: number;
  /** Persisted before the sink is called; seen on recovery, it means "a side effect may have happened". */
  attempt_started_at?: string;
  at?: string;
  detail?: string;
  sink_state?: SinkState;
}

/** A reply in progress, written before any other file of the reply; removed once settled. */
export interface ReplyIntent {
  v: 1;
  taskId: string;
  replyId: string;
  hash: string;
  revision: number;
  target?: string;
  reply: Envelope;
  reply_to?: ReplyTo;
  created_at: string;
}

export function replaySafe(to: ReplyTo): boolean {
  const f = (sinks as unknown as Record<string, unknown>).sinkReplaySafe;
  if (typeof f === "function") return !!(f as (t: ReplyTo) => boolean)(to);
  return to.sink === "file" || to.sink === "hufu-report";
}

export function outcomeOf(res: ExtendedSinkResult, to: ReplyTo): DeliveryOutcome {
  if (res.state === "delivered" || res.state === "duplicate" || res.state === "superseded") return "delivered";
  if (res.outcome) return res.outcome;
  if (res.ok) return "delivered";
  // old sinks cannot say whether a request left the machine: only replay-safe sinks count as not sent
  return replaySafe(to) ? "not_sent" : "unknown";
}
