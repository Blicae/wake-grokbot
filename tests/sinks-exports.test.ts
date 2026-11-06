import { describe, expect, expectTypeOf, it } from "vitest";
import * as api from "../src/index.js";
import type { SinkContext, SinkDelivery, SinkOutcome, SinkResult, SinkState } from "../src/index.js";

describe("package entry: sink types for building ctx, minimal runtime surface", () => {
  it("exports deliver but not sinkReplaySafe or test hooks", () => {
    expect(typeof api.deliver).toBe("function");
    expect("sinkReplaySafe" in api).toBe(false);
    expect("_testHooks" in api).toBe(false);
  });
  it("types line up", () => {
    expectTypeOf<SinkContext["delivery"]>().toEqualTypeOf<SinkDelivery | undefined>();
    expectTypeOf<SinkResult["outcome"]>().toEqualTypeOf<SinkOutcome | undefined>();
    expectTypeOf<SinkResult["state"]>().toEqualTypeOf<SinkState | undefined>();
    expectTypeOf<SinkDelivery>().toEqualTypeOf<{ taskId: string; replyHash: string; revision: number }>();
  });
});
