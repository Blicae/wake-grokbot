/** Inbox layout, receipts and the wake outbox. All writes are atomic; state changes run under one lock. */
import * as fs from "node:fs";
import * as path from "node:path";
import type { Envelope, Status } from "./envelope.js";
import { atomicWrite, readJson, withLock } from "./fsutil.js";

export const INBOX_DIRS = ["msg/to-worker/unread", "msg/to-worker/read", "msg/to-dispatcher/unread", "msg/to-dispatcher/read", "receipts", "replies"];

export type WakeState = "none" | "queued" | "coalesced" | "started" | "unknown" | "not_started" | "dead" | "disabled" | "capped";

export interface ReplyRecord {
  id: string;
  status: Status;
  at: string;
  sink?: string;
  sink_result?: string;
}

export interface Receipt {
  v: "wake-receipt/1";
  id: string;
  hash: string;
  type: Envelope["type"];
  from: string;
  to: string;
  title?: string;
  path: string;
  status: "queued" | Status;
  wake: { state: WakeState; target?: string; at?: string; detail?: string };
  acked_at?: string;
  replies: ReplyRecord[];
  next?: string;
  created_at: string;
  updated_at: string;
  ingested_from?: string;
}

export interface TargetState {
  inflight: { ids: string[]; at: string; sending: boolean; unknown: boolean } | null;
  queue: string[];
  attempts: number;
  next_at: string | null;
  dead: { ids: string[]; at: string; detail: string }[];
}

export interface Outbox {
  targets: Record<string, TargetState>;
  sent: { at: string; target: string; routine: string }[];
}

export class Store {
  constructor(
    readonly inbox: string,
    readonly state: string,
  ) {}

  ensure(): void {
    for (const d of INBOX_DIRS) fs.mkdirSync(path.join(this.inbox, d), { recursive: true });
    fs.mkdirSync(this.state, { recursive: true });
  }

  side(to: string): "worker" | "dispatcher" {
    return to === "worker" ? "worker" : "dispatcher";
  }

  msgDir(to: string, sub: "unread" | "read" = "unread"): string {
    return path.join(this.inbox, "msg", `to-${this.side(to)}`, sub);
  }

  receiptPath(id: string): string {
    return path.join(this.inbox, "receipts", `${id}.json`);
  }

  readReceipt(id: string): Receipt | null {
    const p = this.receiptPath(id);
    return fs.existsSync(p) ? readJson<Receipt>(p) : null;
  }

  writeReceipt(r: Receipt): void {
    r.updated_at = new Date().toISOString();
    atomicWrite(this.receiptPath(r.id), JSON.stringify(r, null, 2) + "\n");
  }

  /** Find an envelope file by id in either side's unread/read folders. */
  findEnvelope(id: string): string | null {
    for (const side of ["worker", "dispatcher"])
      for (const sub of ["unread", "read"] as const) {
        const p = path.join(this.msgDir(side, sub), `${id}.json`);
        if (fs.existsSync(p)) return p;
      }
    return null;
  }

  readEnvelope(id: string): Envelope | null {
    const p = this.findEnvelope(id);
    return p ? readJson<Envelope>(p) : null;
  }

  lock<T>(fn: () => T): T {
    return withLock(path.join(this.state, "state.lock"), fn);
  }

  outboxPath(): string {
    return path.join(this.state, "outbox.json");
  }

  loadOutbox(): Outbox {
    const p = this.outboxPath();
    const o = fs.existsSync(p) ? readJson<Outbox>(p) : { targets: {}, sent: [] };
    o.targets ??= {};
    o.sent ??= [];
    return o;
  }

  saveOutbox(o: Outbox): void {
    const cutoff = Date.now() - 2 * 3600_000;
    o.sent = o.sent.filter((s) => Date.parse(s.at) >= cutoff);
    atomicWrite(this.outboxPath(), JSON.stringify(o, null, 2) + "\n");
  }

  target(o: Outbox, name: string): TargetState {
    return (o.targets[name] ??= { inflight: null, queue: [], attempts: 0, next_at: null, dead: [] });
  }

  log(line: string): void {
    try {
      fs.mkdirSync(this.state, { recursive: true });
      fs.appendFileSync(path.join(this.state, "wake.log"), `${new Date().toISOString()} ${line}\n`);
    } catch {
      /* logging never breaks a command */
    }
  }
}
