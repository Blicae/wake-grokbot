/** The engine behind the CLI: accept (send/ingest), wake outbox pump, ack, reply, status. */
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { type ChannelContext, makeChannel, type WakeOutcome, type WakePayload } from "./channels/index.js";
import { configInfo, HARD_HOURLY_PER_ROUTINE, HARD_HOURLY_TOTAL, type Loaded } from "./config.js";
import { CliError, EXIT, rule, usage } from "./errors.js";
import { contentHash, type Envelope, isExpired, isTerminal, type Status, sign, validate, VERSION, verify } from "./envelope.js";
import { atomicCreate, readJson, renameRetry } from "./fsutil.js";
import { ENV } from "./paths.js";
import { mask } from "./secrets.js";
import { type DeliveryContext, type DeliveryRecord, OUTCOME_MISSING_DETAIL, outcomeMissing, outcomeOf, replaySafe, type ReplyIntent } from "./delivery.js";
import { deliver, type SinkContext } from "./sinks.js";
import { type Receipt, Store, type WakeState } from "./store.js";

/** Rate-limited wakes without Retry-After back off 15, 30, 60 ... minutes (ordinary 4xx: 1, 2, 4 ... 60). */
const RATE_LIMIT_START_MINUTES = 15;
const RATE_LIMIT_MAX_MINUTES = 240;
/** Rate limits do not count toward max_attempts; a run of them gives up after this long without any other result. */
const RATE_LIMIT_GIVE_UP_MS = 24 * 3600_000;

export interface EngineOptions {
  env?: NodeJS.ProcessEnv;
  stdinKey?: string;
  now?: () => number;
  /** Test-only crash injection: called at each persistence point; throwing simulates a crash there. Off by default. */
  fault?: (point: string) => void;
  /**
   * Test-only replace for `deliver`. Defaults to the real sinks `deliver`. Never read from CLI/env/config.
   * Used to assert contract handling (e.g. a result with no `outcome`).
   */
  deliverFn?: typeof deliver;
}

/** An attempt older than this with no recorded result belongs to a dead process. */
const STALE_ATTEMPT_MIN_MS = 10 * 60_000;

export interface Result {
  code: number;
  receipt: Receipt;
  message: string;
}

export function codeFor(state: WakeState): number {
  if (state === "unknown") return EXIT.UNKNOWN;
  if (state === "not_started" || state === "dead" || state === "disabled" || state === "capped") return EXIT.NOT_WOKEN;
  return EXIT.OK;
}

export class Engine {
  readonly store: Store;
  readonly env: NodeJS.ProcessEnv;
  private readonly now: () => number;

  constructor(
    readonly loaded: Loaded,
    private readonly opts: EngineOptions = {},
  ) {
    this.store = new Store(loaded.inbox, loaded.state);
    this.env = opts.env ?? process.env;
    this.now = opts.now ?? Date.now;
  }

  /** Test hook: sees every sink context the core passes to `deliver`. */
  onDeliver?: (ctx: SinkContext & { delivery: DeliveryContext }) => void;

  private fault(point: string): void {
    this.opts.fault?.(point);
  }

  get cfg() {
    return this.loaded.cfg;
  }

  /** Kill switch: WAKE_GROKBOT_DISABLED (anything but "", "0", "false") or a `disabled` file in the state folder. */
  disabled(): string | null {
    const v = (this.env[ENV.DISABLED] ?? "").trim().toLowerCase();
    if (v && v !== "0" && v !== "false") return `${ENV.DISABLED} is set`;
    if (fs.existsSync(path.join(this.store.state, "disabled"))) return "the kill-switch file `disabled` exists in the state folder";
    return null;
  }

  signKey(): Buffer | null {
    const f = this.cfg.sign.key_file;
    if (!f) return null;
    let k: Buffer;
    try {
      k = fs.readFileSync(f);
    } catch {
      throw usage("cannot read sign.key_file");
    }
    k = Buffer.from(k.toString("utf8").trim());
    if (k.length < 16) throw usage("sign.key_file: key must be at least 16 bytes (content not shown)");
    return k;
  }

  private targetFor(to: string): string | undefined {
    return this.cfg.wake.targets[this.store.side(to)];
  }

  private newReceipt(e: Envelope, hash: string, file: string, target: string | undefined, ingestedFrom?: string): Receipt {
    const now = new Date(this.now()).toISOString();
    return {
      v: "wake-receipt/1",
      id: e.id,
      hash,
      type: e.type,
      from: e.from,
      to: e.to,
      title: e.title,
      path: path.relative(this.store.inbox, file).split(path.sep).join("/"),
      status: e.status ?? "queued",
      wake: target ? { state: "queued", target } : { state: "none" },
      replies: [],
      next: e.next,
      created_at: now,
      updated_at: now,
      ...(ingestedFrom ? { ingested_from: ingestedFrom } : {}),
    };
  }

  /** send / ingest: validate, check the signature, store idempotently, queue a wake. */
  async accept(raw: unknown, o: { ingestedFrom?: string; requireSig?: boolean; noWake?: boolean; rejectExpired?: boolean } = {}): Promise<Result> {
    const problems = validate(raw);
    if (problems.length) throw rule("invalid envelope: " + problems.join("; "));
    const e = raw as Envelope;
    const key = this.signKey();
    if (e.sig) {
      if (!key) throw new CliError("envelope is signed but no sign.key_file is configured", EXIT.SIG);
      const v = verify(e, key);
      if (v !== "ok") throw new CliError(`envelope signature ${v}`, EXIT.SIG);
    } else if (o.requireSig || this.cfg.sign.require) {
      throw new CliError("envelope signature missing (signing is required)", EXIT.SIG);
    } else if (key && !o.ingestedFrom) {
      e.sig = sign(e, key);
    }
    const hash = contentHash(e);
    const target = this.targetFor(e.to);
    const accepted = this.store.lock(() => {
      this.store.ensure();
      const old = this.store.readReceipt(e.id);
      const existing = old ? null : this.store.findEnvelope(e.id);
      // order: a known id follows the idempotency rules (0 / 7, no expiry check); then pruned ids; then expiry for new ids
      if (!old && !existing && this.store.wasPruned(e.id)) throw rule(`id ${e.id} was already used and its receipt was pruned; nothing written, use a new id`);
      if (!old && !existing && o.rejectExpired && isExpired(e, this.now())) throw rule(`envelope expired at ${e.expires_at}; nothing written`);
      if (old) {
        if (old.hash !== hash) throw new CliError(`id ${e.id} was already used with different content; nothing written`, EXIT.CONFLICT);
        return { receipt: old, fresh: false, requeued: this.requeueIfLost(old) };
      }
      let file: string;
      if (existing) {
        // crash after the envelope, before its receipt: the envelope file is the source of truth (a known id: no expiry check)
        if (contentHash(readJson<Envelope>(existing)) !== hash) throw new CliError(`id ${e.id} was already used with different content; nothing written`, EXIT.CONFLICT);
        if (this.store.readIntent(e.id)) throw rule(`id ${e.id} belongs to a reply in progress; nothing written`);
        file = existing;
        this.store.log("recovered", { id: e.id, what: "receipt" });
      } else {
        file = path.join(this.store.msgDir(e.to), `${e.id}.json`);
        atomicCreate(file, JSON.stringify(e, null, 2) + "\n");
        this.fault("accept:after-envelope");
      }
      const r = this.newReceipt(e, hash, file, target, o.ingestedFrom);
      this.store.writeReceipt(r);
      this.fault("accept:after-receipt");
      if (target) {
        const ob = this.store.loadOutbox();
        this.store.target(ob, target).queue.push(e.id);
        this.store.saveOutbox(ob);
      }
      return { receipt: r, fresh: true, requeued: false };
    });
    if (!accepted.fresh && accepted.requeued && !o.noWake) await this.pump(accepted.receipt.wake.target);
    if (!accepted.fresh) {
      const r = accepted.requeued ? this.store.readReceipt(e.id)! : accepted.receipt;
      return { code: codeFor(r.wake.state), receipt: r, message: `already accepted (same content): ${e.id}` };
    }
    if (target && !o.noWake) await this.pump(target);
    const r = this.store.readReceipt(e.id)!;
    return { code: codeFor(o.noWake ? "queued" : r.wake.state), receipt: r, message: wakeMessage(r) };
  }

  /** A receipt that says `queued` but sits in no queue and no in-flight wake (crash before the outbox write): queue it. Call under the lock. */
  private requeueIfLost(r: Receipt): boolean {
    if (r.wake.state !== "queued" || !r.wake.target) return false;
    const ob = this.store.loadOutbox();
    if (this.store.inOutbox(ob, r.id)) return false;
    this.store.target(ob, r.wake.target).queue.push(r.id);
    this.store.saveOutbox(ob);
    this.store.log("recovered", { id: r.id, what: "queue" });
    return true;
  }

  private setWake(ids: string[], state: WakeState, target: string, detail: string, onlyIf?: WakeState[]): void {
    const at = new Date(this.now()).toISOString();
    for (const id of ids) {
      const r = this.store.readReceipt(id);
      if (!r || (onlyIf && !onlyIf.includes(r.wake.state))) continue;
      r.wake = { state, target, at, detail };
      this.store.writeReceipt(r);
    }
  }

  /** Deliver queued wakes: one in-flight wake per target; everything queued meanwhile rides on the next one. */
  async pump(only?: string, opts: { ignoreBackoff?: boolean } = {}): Promise<{ target: string; state: string; detail: string }[]> {
    const events: { target: string; state: string; detail: string }[] = [];
    const names = only ? [only] : Object.keys(this.cfg.targets);
    for (const name of names) {
      const tcfg = this.cfg.targets[name];
      if (!tcfg) continue;
      const ttlMs = this.cfg.wake.inflight_ttl_minutes * 60_000;
      const timeoutMs = this.cfg.wake.timeout_seconds * 1000;
      const routine = String(tcfg.routine ?? name);
      const pick = this.store.lock(() => {
        const ob = this.store.loadOutbox();
        const ts = this.store.target(ob, name);
        const now = this.now();
        if (ts.inflight) {
          const age = now - Date.parse(ts.inflight.at);
          if ((ts.inflight.sending && age > timeoutMs * 3) || (!ts.inflight.sending && age > ttlMs)) {
            this.store.log("inflight_expired", { target: name, ids: ts.inflight.ids });
            if (ts.inflight.sending) this.setWake(ts.inflight.ids, "unknown", name, "wake process died; outcome unknown", ["queued", "coalesced"]);
            ts.inflight = null;
          }
        }
        // expiry is checked right before execution: an item that expired while queued is not woken (status unchanged)
        ts.queue = ts.queue.filter((id) => {
          const env = this.store.readEnvelope(id);
          const r = this.store.readReceipt(id);
          if (!isExpired(env, now) || (r && isTerminal(r.status as Status))) return true;
          this.setWake([id], "not_started", name, `expired at ${env!.expires_at}; not woken`);
          this.store.log("expired", { target: name, id });
          return false;
        });
        let skip: { state: WakeState; detail: string } | null = null;
        const off = this.disabled();
        if (!ts.queue.length) skip = null;
        else if (off) skip = { state: "disabled", detail: `kill switch: ${off}` };
        else if (ts.inflight) skip = { state: "coalesced", detail: "a wake is already in flight; this item rides on the next wake" };
        else if (!opts.ignoreBackoff && ts.next_at && Date.parse(ts.next_at) > now) skip = { state: "not_started", detail: `backing off until ${ts.next_at}` };
        else {
          const hour = now - 3600_000;
          const recent = ob.sent.filter((s) => Date.parse(s.at) >= hour);
          const total = Math.min(this.cfg.wake.hourly_cap, HARD_HOURLY_TOTAL);
          const per = Math.min(Number(tcfg.per_routine_hourly_cap ?? HARD_HOURLY_PER_ROUTINE), HARD_HOURLY_PER_ROUTINE);
          if (recent.length >= total) skip = { state: "capped", detail: `hourly cap reached (${total}/h total)` };
          else if (recent.filter((s) => s.routine === routine).length >= per) skip = { state: "capped", detail: `hourly cap reached (${per}/h for routine ${routine})` };
        }
        if (!ts.queue.length) {
          this.store.saveOutbox(ob);
          return null;
        }
        if (skip) {
          this.setWake(ts.queue, skip.state, name, skip.detail, skip.state === "not_started" ? undefined : ["queued", "coalesced", "disabled", "capped", "not_started"]);
          this.store.saveOutbox(ob);
          events.push({ target: name, ...skip });
          return null;
        }
        const ids = ts.queue;
        ts.queue = [];
        ts.inflight = { ids, at: new Date(now).toISOString(), sending: true, unknown: false };
        this.store.saveOutbox(ob);
        return ids;
      });
      if (!pick) continue;
      const lastId = pick[pick.length - 1]!;
      const last = this.store.readEnvelope(lastId);
      const payload: WakePayload = {
        id: lastId,
        type: last?.type ?? "task",
        summary: summarize(last),
        inbox_path: this.store.msgDir(last?.to ?? "worker"),
        ids: pick,
        count: pick.length,
      };
      const ctx: ChannelContext = { env: this.env, timeoutMs, stdinKey: this.opts.stdinKey };
      let outcome: WakeOutcome;
      try {
        const ch = makeChannel(name, tcfg);
        ch.check(ctx);
        outcome = await ch.wake(payload, ctx);
      } catch (err) {
        outcome = { state: "not_started", detail: mask((err as Error).message) };
      }
      this.store.lock(() => {
        const ob = this.store.loadOutbox();
        const ts = this.store.target(ob, name);
        const at = new Date(this.now()).toISOString();
        // Any result other than a rate limit ends the current run of rate limits.
        if (!(outcome.state === "not_started" && outcome.rateLimited)) {
          ts.rate_limited_since = null;
          ts.rate_limit_count = 0;
        }
        if (outcome.state === "started") {
          ts.inflight = { ids: pick, at, sending: false, unknown: false };
          ts.attempts = 0;
          ts.next_at = null;
          ob.sent.push({ at, target: name, routine });
          this.setWake(pick, "started", name, outcome.detail);
        } else if (outcome.state === "unknown") {
          ts.inflight = { ids: pick, at, sending: false, unknown: true };
          ob.sent.push({ at, target: name, routine });
          this.setWake(pick, "unknown", name, outcome.detail);
        } else if (outcome.rateLimited) {
          ts.inflight = null;
          ts.rate_limited_since ??= at;
          ts.rate_limit_count = (ts.rate_limit_count ?? 0) + 1;
          if (Date.parse(at) - Date.parse(ts.rate_limited_since) > RATE_LIMIT_GIVE_UP_MS) {
            ts.dead.push({ ids: pick, at, detail: outcome.detail });
            ts.next_at = null;
            const since = ts.rate_limited_since;
            ts.rate_limited_since = null;
            ts.rate_limit_count = 0;
            this.setWake(pick, "dead", name, `${outcome.detail}; gave up after more than 24 hours of rate limits (since ${since})`);
          } else {
            ts.queue = [...pick, ...ts.queue];
            const n = ts.rate_limit_count;
            const backoff = outcome.retryAfterMs ?? Math.min(RATE_LIMIT_MAX_MINUTES, RATE_LIMIT_START_MINUTES * 2 ** (n - 1)) * 60_000;
            ts.next_at = new Date(this.now() + backoff).toISOString();
            this.setWake(pick, "not_started", name, `${outcome.detail}; retry after ${ts.next_at}`);
          }
        } else {
          ts.inflight = null;
          ts.attempts += 1;
          if (ts.attempts >= this.cfg.wake.max_attempts) {
            ts.dead.push({ ids: pick, at, detail: outcome.detail });
            ts.attempts = 0;
            ts.next_at = null;
            this.setWake(pick, "dead", name, `${outcome.detail}; gave up after ${this.cfg.wake.max_attempts} attempts`);
          } else {
            ts.queue = [...pick, ...ts.queue];
            const backoff = Math.min(60, 2 ** (ts.attempts - 1)) * 60_000;
            ts.next_at = new Date(this.now() + backoff).toISOString();
            this.setWake(pick, "not_started", name, `${outcome.detail}; retry after ${ts.next_at}`);
          }
        }
        this.store.saveOutbox(ob);
      });
      this.store.log("wake", { target: name, state: outcome.state, ids: pick, detail: outcome.detail });
      events.push({ target: name, state: outcome.state, detail: outcome.detail });
    }
    return events;
  }

  /** Clear the in-flight wake that covered `id`: the worker is demonstrably awake. */
  private settleInflight(id: string): string[] {
    const ob = this.store.loadOutbox();
    const freed: string[] = [];
    for (const [name, ts] of Object.entries(ob.targets)) {
      if (ts.inflight && ts.inflight.ids.includes(id)) {
        this.setWake(ts.inflight.ids, "started", name, "confirmed: the worker picked it up", ["unknown"]);
        ts.inflight = null;
        freed.push(name);
      }
    }
    this.store.saveOutbox(ob);
    return freed;
  }

  private markRead(id: string): void {
    const p = this.store.findEnvelope(id);
    if (p && path.basename(path.dirname(p)) === "unread") {
      const dst = path.join(path.dirname(path.dirname(p)), "read", path.basename(p));
      if (!fs.existsSync(dst)) renameRetry(p, dst);
    }
  }

  async ack(id: string, status: Status = "working"): Promise<Result> {
    const r = this.store.lock(() => {
      const r = this.store.readReceipt(id);
      if (!r) throw rule(`no such id: ${id}`);
      if (!isTerminal(r.status as Status)) r.status = status;
      r.acked_at = new Date(this.now()).toISOString();
      this.store.writeReceipt(r);
      this.markRead(id);
      return { r, freed: this.settleInflight(id) };
    });
    for (const t of r.freed) await this.pump(t);
    const fresh = this.store.readReceipt(id)!;
    return { code: EXIT.OK, receipt: fresh, message: `acknowledged ${id} (${fresh.status})` };
  }

  /** Answer a task: write the reply envelope, update the task's receipt, deliver to its sink, wake the other side. */
  async reply(id: string, input: Partial<Envelope> & { status: Status }): Promise<Result & { replyId: string }> {
    const orig = this.store.readEnvelope(id);
    if (!orig) throw rule(`no such id: ${id}`);
    const reply: Envelope = {
      v: VERSION,
      id: input.id ?? randomUUID(),
      type: input.type ?? (isTerminal(input.status) ? "receipt" : "answer"),
      from: input.from ?? orig.to,
      to: input.to ?? orig.from,
      ...(orig.project ? { project: orig.project } : {}),
      title: input.title ?? orig.title,
      status: input.status,
      summary: input.summary,
      ...(input.question ? { question: input.question } : {}),
      ...(input.body !== undefined ? { body: input.body } : {}),
      ...(input.next ? { next: input.next } : {}),
      thread: orig.thread ?? orig.id,
      ...(orig.task ? { task: orig.task } : {}),
      sent_at: input.sent_at ?? new Date(this.now()).toISOString(),
    };
    if (reply.title === undefined) delete reply.title;
    if (reply.summary === undefined) delete reply.summary;
    const problems = validate(reply);
    if (problems.length) throw rule("invalid reply: " + problems.join("; "));
    const key = this.signKey();
    if (key) reply.sig = sign(reply, key);
    const hash = contentHash(reply);
    const target = this.targetFor(reply.to);
    const intent = this.store.lock((): ReplyIntent => {
      this.store.ensure();
      const old = this.store.readReceipt(reply.id);
      const pending = this.store.readIntent(reply.id);
      if (old || pending) {
        const oldHash = old?.hash ?? pending!.hash;
        if (oldHash !== hash) throw new CliError(`id ${reply.id} already exists`, EXIT.CONFLICT);
        // same reply sent again: finish an interrupted one, never write it twice
        if (!pending) throw new CliError(`id ${reply.id} already exists`, EXIT.RULE);
        return pending;
      }
      const task = this.store.readReceipt(id);
      const revision = Math.max(task?.last_revision ?? 0, ...(task?.replies ?? []).map((x) => x.revision ?? 0), task?.replies.length ?? 0) + 1;
      if (task) {
        task.last_revision = revision;
        this.store.writeReceipt(task);
      }
      const i: ReplyIntent = {
        v: 1,
        taskId: id,
        replyId: reply.id,
        hash,
        revision,
        ...(target ? { target } : {}),
        reply,
        ...(orig.reply_to ? { reply_to: orig.reply_to } : {}),
        created_at: new Date(this.now()).toISOString(),
      };
      this.store.writeIntent(i);
      this.fault("reply:after-intent");
      return i;
    });
    const freed = this.store.lock(() => this.applyIntent(intent));
    let code: number = EXIT.OK;
    let msg = `replied to ${id} with ${reply.status} (${reply.id})`;
    if (intent.reply_to) {
      const d = await this.deliverIntent(intent);
      if (d) {
        const sinkLabel =
          d.state === "delivered"
            ? "delivered"
            : d.state === "unknown"
              ? "outcome UNKNOWN (not resent automatically)"
              : d.state === "not_sent"
                ? d.sink_state === "conflict"
                  ? "not sent (conflict)"
                  : d.sink_state === "superseded"
                    ? "not sent (superseded)"
                    : "not sent"
                : "FAILED";
        msg += `; sink ${sinkLabel}: ${d.detail ?? ""}`;
        if (d.state !== "delivered") code = EXIT.NOT_WOKEN;
      }
    }
    for (const t of new Set([...freed, ...(target ? [target] : [])])) await this.pump(t);
    if (target && code === EXIT.OK) code = codeFor(this.store.readReceipt(reply.id)!.wake.state);
    return { code, receipt: this.store.readReceipt(id) ?? this.store.readReceipt(reply.id)!, message: msg, replyId: reply.id };
  }

  /** Write every file of a reply that is still missing (idempotent). Call under the lock. Returns targets freed. */
  private applyIntent(i: ReplyIntent): string[] {
    const reply = i.reply;
    if (!this.store.findEnvelope(reply.id)) {
      atomicCreate(path.join(this.store.msgDir(reply.to), `${reply.id}.json`), JSON.stringify(reply, null, 2) + "\n");
    }
    this.fault("reply:after-envelope");
    const rr = this.store.readReceipt(reply.id);
    if (!rr) {
      const file = this.store.findEnvelope(reply.id)!;
      const fresh = this.newReceipt(reply, i.hash, file, i.target);
      this.store.writeReceipt(fresh);
      this.fault("reply:after-receipt");
      this.requeueIfLost(fresh);
    } else this.requeueIfLost(rr);
    this.fault("reply:after-enqueue");
    const r = this.store.readReceipt(i.taskId);
    if (r && !r.replies.some((x) => x.id === reply.id)) {
      if (i.revision > (r.status_revision ?? 0)) {
        r.status = reply.status!;
        r.next = reply.next;
        r.status_revision = i.revision;
      }
      r.acked_at ??= reply.sent_at;
      r.last_revision = Math.max(r.last_revision ?? 0, i.revision);
      r.replies.push({
        id: reply.id,
        status: reply.status!,
        at: reply.sent_at,
        revision: i.revision,
        ...(i.reply_to ? { sink: i.reply_to.sink, delivery: { state: "pending", attempts: 0 } as DeliveryRecord } : {}),
      });
      this.store.writeReceipt(r);
    }
    this.fault("reply:after-task");
    this.markRead(i.taskId);
    if (!i.reply_to || !r) this.store.removeIntent(i.replyId);
    return this.settleInflight(i.taskId);
  }

  /**
   * Deliver one reply to its sink at most once per call. `attempt_started_at` is persisted before the sink runs;
   * only a record that is `pending` / `not_sent` with no open attempt is sent. Returns the final record.
   */
  private async deliverIntent(i: ReplyIntent): Promise<DeliveryRecord | null> {
    const to = i.reply_to!;
    const go = this.store.lock(() => {
      const r = this.store.readReceipt(i.taskId);
      const rec = r?.replies.find((x) => x.id === i.replyId);
      const d = rec?.delivery;
      if (!r || !rec || !d) return null;
      if ((d.state !== "pending" && d.state !== "not_sent") || d.attempt_started_at) return null;
      d.attempt_started_at = new Date(this.now()).toISOString();
      d.attempts += 1;
      this.store.writeReceipt(r);
      return true;
    });
    if (!go) return null;
    this.fault("reply:before-deliver");
    const ctx = {
      cfg: this.cfg,
      inbox: this.store.inbox,
      env: this.env,
      timeoutMs: this.cfg.wake.timeout_seconds * 1000,
      delivery: { taskId: i.taskId, replyHash: i.hash, revision: i.revision },
    };
    this.onDeliver?.(ctx);
    const deliverFn = this.opts.deliverFn ?? deliver;
    const res = await deliverFn(i.reply, to, ctx);
    this.fault("reply:after-deliver");
    return this.store.lock(() => {
      const r = this.store.readReceipt(i.taskId);
      const rec = r?.replies.find((x) => x.id === i.replyId);
      if (!r || !rec?.delivery) return null;
      const missing = outcomeMissing(res);
      const outcome = outcomeOf(res);
      const d = rec.delivery;
      delete d.attempt_started_at;
      d.state = outcome === "not_sent" && d.attempts >= this.cfg.wake.max_attempts ? "failed" : outcome;
      d.at = new Date(this.now()).toISOString();
      d.detail = missing ? (res.detail ? `${res.detail}; ${OUTCOME_MISSING_DETAIL}` : OUTCOME_MISSING_DETAIL) : res.detail;
      const st = res.state;
      if (st) d.sink_state = st;
      rec.sink_result = (outcome === "delivered" ? "ok: " : "failed: ") + (d.detail ?? "");
      this.store.writeReceipt(r);
      if (d.state !== "not_sent" && d.state !== "unknown") this.store.removeIntent(i.replyId);
      this.store.log("delivery", {
        task: i.taskId,
        reply: i.replyId,
        state: d.state,
        detail: d.detail,
        ...(missing ? { contract: "missing_outcome" } : {}),
      });
      return d;
    });
  }

  /**
   * Repair what a crash left behind, idempotently: envelopes without receipts, receipts lost from the queue,
   * half-written replies, and reply deliveries. An open attempt of a sink that is not replay-safe becomes
   * `unknown` and is never sent again automatically; replay-safe sinks and `not_sent` are delivered.
   */
  async recover(): Promise<{ repaired: string[]; delivered: string[] }> {
    const repaired: string[] = [];
    const staleMs = Math.max(this.cfg.wake.timeout_seconds * 3000, STALE_ATTEMPT_MIN_MS);
    const todo = this.store.lock(() => {
      this.store.ensure();
      const intents = this.store.listIntents();
      const replyIds = new Set(intents.map((i) => i.replyId));
      for (const side of ["worker", "dispatcher"])
        for (const sub of ["unread", "read"] as const) {
          const dir = this.store.msgDir(side, sub);
          for (const f of fs.readdirSync(dir)) {
            if (!f.endsWith(".json") || f.startsWith(".")) continue;
            const id = f.slice(0, -5);
            if (replyIds.has(id) || this.store.readReceipt(id)) continue;
            const e = readJson<Envelope>(path.join(dir, f));
            if (e.id !== id) continue;
            const r = this.newReceipt(e, contentHash(e), path.join(dir, f), this.targetFor(e.to));
            this.store.writeReceipt(r);
            this.requeueIfLost(r);
            repaired.push(id);
          }
        }
      const rdir = path.join(this.store.inbox, "receipts");
      for (const f of fs.readdirSync(rdir)) {
        if (!f.endsWith(".json") || f.startsWith(".")) continue;
        const r = readJson<Receipt>(path.join(rdir, f));
        if (this.requeueIfLost(r)) repaired.push(r.id);
      }
      const out: ReplyIntent[] = [];
      for (const i of intents) {
        this.applyIntent(i);
        if (!i.reply_to) continue;
        const r = this.store.readReceipt(i.taskId);
        const rec = r?.replies.find((x) => x.id === i.replyId);
        const d = rec?.delivery;
        if (!r || !d) continue;
        if (d.attempt_started_at) {
          if (this.now() - Date.parse(d.attempt_started_at) < staleMs) continue; // maybe still running elsewhere
          delete d.attempt_started_at;
          if (replaySafe(i.reply_to)) d.state = "pending";
          else {
            d.state = "unknown";
            d.at = new Date(this.now()).toISOString();
            d.detail = "the process died during delivery; outcome unknown, not resent (use redeliver to send again)";
            rec.sink_result = "failed: " + d.detail;
          }
          this.store.writeReceipt(r);
          repaired.push(i.replyId);
        }
        if (d.state === "pending" || d.state === "not_sent") out.push(i);
      }
      return out;
    });
    const delivered: string[] = [];
    for (const i of todo) {
      const d = await this.deliverIntent(i);
      if (d?.state === "delivered") delivered.push(i.replyId);
    }
    if (repaired.length) this.store.log("recovered", { ids: repaired });
    return { repaired, delivered };
  }

  /** Manual redelivery of one reply. An unknown outcome of a sink with outside side effects needs `acceptRisk`. */
  async redeliver(replyId: string, o: { acceptRisk?: boolean } = {}): Promise<Result> {
    const i = this.store.readIntent(replyId);
    if (!i?.reply_to) throw rule(`no undelivered reply ${replyId} (already delivered, or no sink)`);
    this.store.lock(() => {
      const r = this.store.readReceipt(i.taskId);
      const rec = r?.replies.find((x) => x.id === replyId);
      const d = rec?.delivery;
      if (!r || !d) throw rule(`no delivery record for ${replyId}`);
      if (d.state === "delivered") throw rule(`${replyId} was already delivered`);
      if (d.attempt_started_at && this.now() - Date.parse(d.attempt_started_at) < STALE_ATTEMPT_MIN_MS)
        throw rule(`${replyId}: a delivery attempt is in progress`);
      if ((d.state === "unknown" || d.attempt_started_at) && !replaySafe(i.reply_to!) && !o.acceptRisk)
        throw rule(
          `${replyId}: the last ${i.reply_to!.sink} delivery may already have arrived; sending again can duplicate it. Re-run with --accept-duplicate-risk to send anyway`,
        );
      delete d.attempt_started_at;
      d.state = "pending";
      this.store.writeReceipt(r);
    });
    const d = await this.deliverIntent(i);
    const r = this.store.readReceipt(i.taskId)!;
    const ok = d?.state === "delivered";
    return { code: ok ? EXIT.OK : EXIT.NOT_WOKEN, receipt: r, message: `redeliver ${replyId}: ${d?.state ?? "skipped"}${d?.detail ? ` (${d.detail})` : ""}` };
  }

  /**
   * The woken run is finished (like a relay's `/done`): free the in-flight slot of the target(s), then deliver
   * whatever is queued as one wake (also when nothing was in flight). A manual release skips the backoff wait,
   * so a wake that failed with not_started (e.g. a missing key) is retried right away.
   * An `unknown` wake that a run reports on evidently started.
   */
  async release(target?: string): Promise<{ released: string[]; events: { target: string; state: string; detail: string }[] }> {
    if (target && !this.cfg.targets[target])
      throw rule(`unknown target ${target} (known: ${Object.keys(this.cfg.targets).join(", ") || "none"}; ${configInfo(this.loaded)})`);
    const released = this.store.lock(() => {
      const ob = this.store.loadOutbox();
      const out: string[] = [];
      for (const [name, ts] of Object.entries(ob.targets)) {
        if (target && name !== target) continue;
        if (!ts.inflight) continue;
        this.setWake(ts.inflight.ids, "started", name, "confirmed: the run reported it finished", ["unknown"]);
        ts.inflight = null;
        out.push(name);
      }
      this.store.saveOutbox(ob);
      return out;
    });
    for (const t of released) this.store.log("released", { target: t });
    const events = await this.pump(target, { ignoreBackoff: true });
    return { released, events };
  }

  /** Retention: list (or with apply, delete) read messages and their receipts older than `days`, once settled. */
  prune(days: number, apply: boolean): { files: string[] } {
    const cutoff = this.now() - days * 86_400_000;
    const files: string[] = [];
    const pruned: { id: string; settled_at: string }[] = [];
    return this.store.lock(() => {
      for (const side of ["to-worker", "to-dispatcher"]) {
        const dir = path.join(this.store.inbox, "msg", side, "read");
        if (!fs.existsSync(dir)) continue;
        for (const f of fs.readdirSync(dir)) {
          if (!f.endsWith(".json")) continue;
          const p = path.join(dir, f);
          if (fs.statSync(p).mtimeMs >= cutoff) continue;
          const id = f.slice(0, -5);
          const r = this.store.readReceipt(id);
          const settled = !r || r.type === "note" || r.type === "answer" || r.type === "receipt" || isTerminal(r.status as Status);
          if (!settled) continue;
          files.push(p);
          const rp = this.store.receiptPath(id);
          if (fs.existsSync(rp)) files.push(rp);
          // record every pruned envelope id, also one whose receipt is missing (e.g. after a crash);
          // without a receipt, settled_at falls back to the envelope file's modification time
          pruned.push({ id, settled_at: r?.updated_at ?? new Date(fs.statSync(p).mtimeMs).toISOString() });
        }
      }
      const rdir = path.join(this.store.inbox, "replies");
      if (fs.existsSync(rdir))
        for (const f of fs.readdirSync(rdir)) {
          const p = path.join(rdir, f);
          if (fs.statSync(p).isFile() && fs.statSync(p).mtimeMs < cutoff) files.push(p);
        }
      if (apply) {
        this.store.recordPruned(pruned); // before deleting: a crash in between leaves a record, never a replay hole
        for (const f of files) fs.rmSync(f, { force: true });
      }
      if (apply && files.length) this.store.log("pruned", { count: files.length, days });
      return { files: files.map((f) => path.relative(this.store.inbox, f).split(path.sep).join("/")) };
    });
  }

  /** Manual reconciliation of an `unknown` wake: started (leave it) or not_started (queue it again). */
  markWake(id: string, state: "started" | "not_started"): Receipt {
    return this.store.lock(() => {
      const r = this.store.readReceipt(id);
      if (!r) throw rule(`no such id: ${id}`);
      if (r.wake.state !== "unknown" && r.wake.state !== "dead") throw rule(`wake state is ${r.wake.state}; only unknown or dead can be reconciled`);
      const target = r.wake.target!;
      const ob = this.store.loadOutbox();
      const ts = this.store.target(ob, target);
      if (ts.inflight?.ids.includes(id)) ts.inflight = null;
      if (state === "not_started") {
        ts.queue.unshift(id);
        r.wake = { ...r.wake, state: "queued", detail: "re-queued by hand after an unknown outcome" };
      } else r.wake = { ...r.wake, state: "started", detail: "confirmed started by hand" };
      this.store.saveOutbox(ob);
      this.store.writeReceipt(r);
      return r;
    });
  }
}

function summarize(e: Envelope | null): string {
  if (!e) return "";
  const s = e.summary ?? e.title ?? e.objective ?? "";
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > 160 ? one.slice(0, 157) + "..." : one;
}

export function wakeMessage(r: Receipt): string {
  const w = r.wake;
  switch (w.state) {
    case "none":
      return `accepted ${r.id}; no wake target for ${r.to}, nobody woken`;
    case "queued":
      return `accepted ${r.id}; wake queued (${w.target})`;
    case "coalesced":
      return `accepted ${r.id}; a wake is already in flight for ${w.target}, this item rides on the next one`;
    case "started":
      return `accepted ${r.id}; ${w.target} woken (${w.detail}). Started, not finished: results arrive in the inbox`;
    case "unknown":
      return `accepted ${r.id}; wake outcome UNKNOWN (${w.detail}). Do not resend; check \`status ${r.id}\` later`;
    default:
      return `accepted ${r.id}; not woken: ${w.state} (${w.detail ?? ""})`;
  }
}
