/** Exit codes. Documented in docs/protocol.md#exit-codes and `wake-grokbot --help`. */
export const EXIT = {
  OK: 0,
  /** Refused by a rule or nothing to do. */
  RULE: 1,
  /** Usage or configuration error. */
  USAGE: 2,
  /** Internal error or state lock timeout. */
  INTERNAL: 3,
  /** Missing or wrong envelope signature. */
  SIG: 4,
  /** Written, but the wake was not started (4xx, dead, capped, disabled). Safe to retry later. */
  NOT_WOKEN: 5,
  /** Written and the wake was sent, but its outcome is unknown (timeout / 5xx). Never resend automatically. */
  UNKNOWN: 6,
  /** Idempotency conflict: same id was already used with different content. */
  CONFLICT: 7,
} as const;

export class CliError extends Error {
  constructor(
    message: string,
    readonly code: number,
  ) {
    super(message);
  }
}

export const usage = (m: string) => new CliError(m, EXIT.USAGE);
export const rule = (m: string) => new CliError(m, EXIT.RULE);
