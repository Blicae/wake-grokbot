/**
 * Test-only injection for the core engine. Internal module: not re-exported from the package root, never read
 * from the CLI, the environment or the config. Hooks are attached per Engine instance and are off by default.
 */
import type { DeliveryContext } from "./delivery.js";
import type { deliver, SinkContext } from "./sinks.js";

export interface CoreTestHooks {
  /** Called at each persistence point; throwing simulates a crash there. */
  fault?: (point: string) => void;
  /** Replaces the real sinks `deliver` (contract tests). */
  deliverFn?: typeof deliver;
  /** Sees every sink context the core passes to `deliver`. */
  onDeliver?: (ctx: SinkContext & { delivery: DeliveryContext }) => void;
}

const hooks = new WeakMap<object, CoreTestHooks>();

/** Attach (or with `undefined`, remove) test hooks for one engine. Tests only. */
export function _setCoreTestHooks(engine: object, h: CoreTestHooks | undefined): void {
  if (h) hooks.set(engine, h);
  else hooks.delete(engine);
}

export function coreTestHooks(engine: object): CoreTestHooks | undefined {
  return hooks.get(engine);
}
