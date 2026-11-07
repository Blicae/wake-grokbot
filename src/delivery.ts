/**
 * Delivery contract between the core and the reply sinks (RD-001-G interface freeze v1).
 * Shared public types live here (owned by the core); sink-only types stay in sinks.ts.
 * Core always calls the real sinks exports (`sinkReplaySafe`, `outcome`/`state` on SinkResult).
 * A result with no `outcome` is a contract violation: treated as `unknown`, never inferred as not_sent.
 */
import type { Envelope, ReplyTo } from "./envelope.js";
import { sinkReplaySafe, type SinkOutcome, type SinkResult, type SinkState } from "./sinks.js";

/** Passed as `ctx.delivery` on every core call to `deliver`. `revision` is per task, monotonic, kept on redelivery. */
export interface DeliveryContext {
  taskId: string;
  replyHash: string;
  revision: number;
}

export type DeliveryOutcome = SinkOutcome;
export type { SinkState };

/** SinkResult as returned by the sinks module; `outcome` is required under freeze v1. */
export type ExtendedSinkResult = SinkResult;

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
  /** The sink returned no `outcome`: never replayed automatically, even for a replay-safe sink. */
  contract_violation?: boolean;
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
  /** terminal report footer (quota + execution time), fixed when the intent is written so every redelivery writes the same bytes */
  report_footer?: string;
  created_at: string;
}

/** Direct passthrough to the sinks module; no local sink-kind fallback. */
export function replaySafe(to: ReplyTo): boolean {
  return sinkReplaySafe(to);
}

export const OUTCOME_MISSING_DETAIL =
  "sink returned no outcome (contract violation); treated as unknown, not resent automatically";

/**
 * Map a sink result to a delivery outcome. Missing `outcome` is a contract break → `unknown`
 * (never inferred from `ok` or `state`; never treated as not_sent).
 */
export function outcomeOf(res: ExtendedSinkResult): DeliveryOutcome {
  if (res.outcome === "delivered" || res.outcome === "not_sent" || res.outcome === "unknown") return res.outcome;
  return "unknown";
}

export function outcomeMissing(res: ExtendedSinkResult): boolean {
  return res.outcome !== "delivered" && res.outcome !== "not_sent" && res.outcome !== "unknown";
}
