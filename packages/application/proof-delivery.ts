import { z } from "zod";
import {
  decideIntegrationRetry,
  type IntegrationError,
} from "../integrations";

export const ProofDeliveryStatusSchema = z.enum([
  "QUEUED",
  "SENDING",
  "DELIVERED",
  "FAILED_RETRYABLE",
  "FAILED_FINAL",
  "BOUNCED",
]);

export type ProofDeliveryStatus = z.infer<
  typeof ProofDeliveryStatusSchema
>;

export const DeliveryFailurePlanSchema = z
  .object({
    deliveryStatus: z.enum(["FAILED_RETRYABLE", "FAILED_FINAL"]),
    outboxStatus: z.enum(["PENDING", "DEAD_LETTER"]),
    availableAt: z.number().int().nonnegative(),
    attempt: z.number().int().min(1),
    failureReason: z.string().trim().min(1).max(1000),
  })
  .strict();

export type DeliveryFailurePlan = z.infer<
  typeof DeliveryFailurePlanSchema
>;

/**
 * Converts an adapter failure into durable outbox state. A retryable failure is
 * never called delivered; terminal failures are made visible in dead-letter
 * state instead of silently disappearing.
 */
export function planProofDeliveryFailure(input: {
  currentAttempts: number;
  error: IntegrationError;
  nowMs: number;
}): DeliveryFailurePlan {
  const attempt = z.number().int().nonnegative().parse(
    input.currentAttempts,
  ) + 1;
  const decision = decideIntegrationRetry({
    attempt,
    error: input.error,
    nowMs: input.nowMs,
  });
  return DeliveryFailurePlanSchema.parse({
    deliveryStatus:
      decision.action === "RETRY" ? "FAILED_RETRYABLE" : "FAILED_FINAL",
    outboxStatus:
      decision.action === "RETRY" ? "PENDING" : "DEAD_LETTER",
    availableAt:
      decision.nextAttemptAt === null
        ? input.nowMs
        : new Date(decision.nextAttemptAt).getTime(),
    attempt,
    failureReason: `${input.error.code}: ${input.error.message}`,
  });
}

export function isProofDeliveryTerminal(status: unknown) {
  const parsed = ProofDeliveryStatusSchema.safeParse(status);
  return (
    parsed.success &&
    ["DELIVERED", "FAILED_FINAL", "BOUNCED"].includes(parsed.data)
  );
}
