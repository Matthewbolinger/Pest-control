import { describe, expect, it } from "vitest";
import {
  isProofDeliveryTerminal,
  planProofDeliveryFailure,
} from "../packages/application/proof-delivery";

describe("proof delivery truth", () => {
  it("keeps retryable adapter failures pending with backoff", () => {
    const plan = planProofDeliveryFailure({
      currentAttempts: 0,
      nowMs: 1_720_000_000_000,
      error: {
        code: "PROVIDER_TIMEOUT",
        message: "The communications provider timed out.",
        retryable: true,
        retryAfterMs: 2_500,
      },
    });
    expect(plan).toEqual({
      deliveryStatus: "FAILED_RETRYABLE",
      outboxStatus: "PENDING",
      availableAt: 1_720_000_002_500,
      attempt: 1,
      failureReason:
        "PROVIDER_TIMEOUT: The communications provider timed out.",
    });
  });

  it("dead-letters non-retryable failures", () => {
    const plan = planProofDeliveryFailure({
      currentAttempts: 2,
      nowMs: 1_720_000_000_000,
      error: {
        code: "INVALID_RECIPIENT",
        message: "The destination is invalid.",
        retryable: false,
        retryAfterMs: null,
      },
    });
    expect(plan.deliveryStatus).toBe("FAILED_FINAL");
    expect(plan.outboxStatus).toBe("DEAD_LETTER");
    expect(plan.attempt).toBe(3);
  });

  it("does not treat queued or retryable work as delivered", () => {
    expect(isProofDeliveryTerminal("QUEUED")).toBe(false);
    expect(isProofDeliveryTerminal("FAILED_RETRYABLE")).toBe(false);
    expect(isProofDeliveryTerminal("DELIVERED")).toBe(true);
    expect(isProofDeliveryTerminal("FAILED_FINAL")).toBe(true);
  });
});
