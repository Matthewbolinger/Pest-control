import { z } from "zod";
import { NonNegativeCentsSchema } from "./economics";

const IdentifierSchema = z.string().trim().min(1).max(128);
const CommandIdSchema = z
  .string()
  .min(8)
  .max(128)
  .regex(/^[A-Za-z0-9:_-]+$/);

export const OutcomeStatusSchema = z.enum([
  "PENDING_VERIFICATION",
  "RESOLVED",
  "PARTIALLY_RESOLVED",
  "UNRESOLVED",
  "RESERVICE_REQUIRED",
  "CUSTOMER_UNREACHABLE",
]);

export type OutcomeStatus = z.infer<typeof OutcomeStatusSchema>;

export const OutcomeVerificationSourceSchema = z.enum([
  "CUSTOMER_CONFIRMATION",
  "STAFF_RECORDED_CUSTOMER_CONFIRMATION",
  "TECHNICIAN_FOLLOW_UP",
  "MANAGER_REVIEW",
  "REPEAT_SERVICE_REQUEST",
  "INTERNAL_REVIEW",
]);

export type OutcomeVerificationSource = z.infer<
  typeof OutcomeVerificationSourceSchema
>;

export const ReserviceLinkSchema = z
  .object({
    jobId: IdentifierSchema,
    linkedAt: z.string().datetime(),
    costStatus: z.enum(["PENDING", "FINALIZED"]),
    directCostCents: NonNegativeCentsSchema.nullable(),
    finalizedAt: z.string().datetime().nullable(),
  })
  .strict()
  .superRefine((link, context) => {
    if (
      (link.costStatus === "PENDING" &&
        (link.directCostCents !== null || link.finalizedAt !== null)) ||
      (link.costStatus === "FINALIZED" &&
        (link.directCostCents === null || link.finalizedAt === null))
    ) {
      context.addIssue({
        code: "custom",
        message:
          "Reservice cost status must agree with its cost and finalization timestamp.",
      });
    }
  });

export type ReserviceLink = z.infer<typeof ReserviceLinkSchema>;

export const OutcomeSnapshotSchema = z
  .object({
    organizationId: IdentifierSchema,
    jobId: IdentifierSchema,
    version: z.number().int().min(1),
    lastCommandId: CommandIdSchema.nullable(),
    status: OutcomeStatusSchema,
    completedAt: z.string().datetime(),
    completedByUserId: IdentifierSchema,
    initialRiskReview: z.enum(["CLEAR", "UNRESOLVED"]),
    verifiedAt: z.string().datetime().nullable(),
    verifiedByUserId: IdentifierSchema.nullable(),
    verificationSource: OutcomeVerificationSourceSchema.nullable(),
    verificationNote: z.string().trim().min(3).max(2_000).nullable(),
    reserviceLinks: z.array(ReserviceLinkSchema).max(100),
    actualReserviceCostCents: NonNegativeCentsSchema,
    updatedAt: z.string().datetime(),
  })
  .strict()
  .superRefine((outcome, context) => {
    const ids = new Set<string>();
    for (const [index, link] of outcome.reserviceLinks.entries()) {
      if (ids.has(link.jobId)) {
        context.addIssue({
          code: "custom",
          path: ["reserviceLinks", index, "jobId"],
          message: "A reservice job may be linked only once.",
        });
      }
      ids.add(link.jobId);
      if (
        new Date(link.linkedAt).getTime() <=
        new Date(outcome.completedAt).getTime()
      ) {
        context.addIssue({
          code: "custom",
          path: ["reserviceLinks", index, "linkedAt"],
          message: "A reservice link must occur after original completion.",
        });
      }
      if (
        link.finalizedAt &&
        new Date(link.finalizedAt).getTime() <
          new Date(link.linkedAt).getTime()
      ) {
        context.addIssue({
          code: "custom",
          path: ["reserviceLinks", index, "finalizedAt"],
          message: "Reservice cost cannot be finalized before linkage.",
        });
      }
    }

    const expectedCost = outcome.reserviceLinks.reduce(
      (total, link) => total + (link.directCostCents ?? 0),
      0,
    );
    if (expectedCost !== outcome.actualReserviceCostCents) {
      context.addIssue({
        code: "custom",
        path: ["actualReserviceCostCents"],
        message:
          "Actual reservice cost must equal the sum of finalized reservice links.",
      });
    }

    const verificationFields = [
      outcome.verifiedAt,
      outcome.verifiedByUserId,
      outcome.verificationSource,
      outcome.verificationNote,
    ];
    const hasVerification = verificationFields.every((value) => value !== null);
    const hasPartialVerification = verificationFields.some(
      (value) => value !== null,
    );
    if (hasPartialVerification && !hasVerification) {
      context.addIssue({
        code: "custom",
        message: "Outcome verification fields must be recorded together.",
      });
    }
    if (
      outcome.status === "PENDING_VERIFICATION" &&
      hasVerification
    ) {
      context.addIssue({
        code: "custom",
        message: "A pending outcome cannot already contain verification.",
      });
    }
    if (
      outcome.status === "PENDING_VERIFICATION" &&
      outcome.reserviceLinks.length > 0
    ) {
      context.addIssue({
        code: "custom",
        path: ["reserviceLinks"],
        message: "A pending outcome cannot already contain reservice links.",
      });
    }
    if (
      outcome.status === "RESERVICE_REQUIRED" &&
      outcome.reserviceLinks.length === 0
    ) {
      context.addIssue({
        code: "custom",
        path: ["reserviceLinks"],
        message: "Reservice-required status must reference a linked reservice job.",
      });
    }
    if (
      outcome.status !== "PENDING_VERIFICATION" &&
      outcome.status !== "RESERVICE_REQUIRED" &&
      !hasVerification
    ) {
      context.addIssue({
        code: "custom",
        message: "A verified terminal status requires independent verification.",
      });
    }
    if (
      hasVerification &&
      outcome.verifiedByUserId === outcome.completedByUserId
    ) {
      context.addIssue({
        code: "custom",
        path: ["verifiedByUserId"],
        message: "The completion actor cannot independently verify the outcome.",
      });
    }
    if (
      hasVerification &&
      new Date(outcome.verifiedAt!).getTime() <=
        new Date(outcome.completedAt).getTime()
    ) {
      context.addIssue({
        code: "custom",
        path: ["verifiedAt"],
        message: "Verification must occur after job completion.",
      });
    }
    if (
      new Date(outcome.updatedAt).getTime() <
      new Date(outcome.completedAt).getTime()
    ) {
      context.addIssue({
        code: "custom",
        path: ["updatedAt"],
        message: "Outcome updates cannot predate job completion.",
      });
    }
  });

export type OutcomeSnapshot = z.infer<typeof OutcomeSnapshotSchema>;

export const CreatePendingOutcomeSchema = z
  .object({
    organizationId: IdentifierSchema,
    jobId: IdentifierSchema,
    completedAt: z.string().datetime(),
    completedByUserId: IdentifierSchema,
    initialRiskReview: z.enum(["CLEAR", "UNRESOLVED"]),
  })
  .strict();

const OutcomeCommandBase = {
  commandId: CommandIdSchema,
  expectedVersion: z.number().int().min(1),
} as const;

export const OutcomeCommandSchema = z.discriminatedUnion("type", [
  z
    .object({
      ...OutcomeCommandBase,
      type: z.literal("VERIFY_OUTCOME"),
      result: z.enum([
        "RESOLVED",
        "PARTIALLY_RESOLVED",
        "UNRESOLVED",
        "CUSTOMER_UNREACHABLE",
      ]),
      source: OutcomeVerificationSourceSchema,
      verifiedAt: z.string().datetime(),
      verifiedByUserId: IdentifierSchema,
      note: z.string().trim().min(3).max(2_000),
    })
    .strict(),
  z
    .object({
      ...OutcomeCommandBase,
      type: z.literal("LINK_RESERVICE"),
      reserviceJobId: IdentifierSchema,
      linkedAt: z.string().datetime(),
    })
    .strict(),
  z
    .object({
      ...OutcomeCommandBase,
      type: z.literal("FINALIZE_RESERVICE_COST"),
      reserviceJobId: IdentifierSchema,
      directCostCents: NonNegativeCentsSchema,
      finalizedAt: z.string().datetime(),
    })
    .strict(),
]);

export type OutcomeCommand = z.infer<typeof OutcomeCommandSchema>;

export class OutcomeTransitionError extends Error {
  constructor(
    readonly code:
      | "VERSION_CONFLICT"
      | "INVALID_TRANSITION"
      | "INDEPENDENT_VERIFICATION_REQUIRED"
      | "INVALID_VERIFICATION_TIME"
      | "RESERVICE_ALREADY_LINKED"
      | "RESERVICE_NOT_LINKED"
      | "RESERVICE_COST_ALREADY_FINALIZED",
    message: string,
  ) {
    super(message);
    this.name = "OutcomeTransitionError";
  }
}

export function createPendingOutcome(
  inputValue: unknown,
): OutcomeSnapshot {
  const input = CreatePendingOutcomeSchema.parse(inputValue);
  return OutcomeSnapshotSchema.parse({
    organizationId: input.organizationId,
    jobId: input.jobId,
    version: 1,
    lastCommandId: null,
    status: "PENDING_VERIFICATION",
    completedAt: input.completedAt,
    completedByUserId: input.completedByUserId,
    initialRiskReview: input.initialRiskReview,
    verifiedAt: null,
    verifiedByUserId: null,
    verificationSource: null,
    verificationNote: null,
    reserviceLinks: [],
    actualReserviceCostCents: 0,
    updatedAt: input.completedAt,
  });
}

export function applyOutcomeCommand(
  currentValue: unknown,
  commandValue: unknown,
): OutcomeSnapshot {
  const current = OutcomeSnapshotSchema.parse(currentValue);
  const command = OutcomeCommandSchema.parse(commandValue);

  if (command.expectedVersion !== current.version) {
    throw new OutcomeTransitionError(
      "VERSION_CONFLICT",
      `Expected outcome version ${command.expectedVersion}, but the current version is ${current.version}.`,
    );
  }

  switch (command.type) {
    case "VERIFY_OUTCOME": {
      if (current.status !== "PENDING_VERIFICATION") {
        throw new OutcomeTransitionError(
          "INVALID_TRANSITION",
          "Only a pending outcome may be independently verified.",
        );
      }
      if (command.verifiedByUserId === current.completedByUserId) {
        throw new OutcomeTransitionError(
          "INDEPENDENT_VERIFICATION_REQUIRED",
          "The user who completed the job cannot independently verify its outcome.",
        );
      }
      if (
        new Date(command.verifiedAt).getTime() <=
        new Date(current.completedAt).getTime()
      ) {
        throw new OutcomeTransitionError(
          "INVALID_VERIFICATION_TIME",
          "Outcome verification must occur after job completion.",
        );
      }
      return nextSnapshot(
        current,
        command,
        {
          status: command.result,
          verifiedAt: command.verifiedAt,
          verifiedByUserId: command.verifiedByUserId,
          verificationSource: command.source,
          verificationNote: command.note,
        },
        command.verifiedAt,
      );
    }

    case "LINK_RESERVICE": {
      if (
        current.reserviceLinks.some(
          (link) => link.jobId === command.reserviceJobId,
        )
      ) {
        throw new OutcomeTransitionError(
          "RESERVICE_ALREADY_LINKED",
          "That reservice job is already linked to this outcome.",
        );
      }
      if (command.reserviceJobId === current.jobId) {
        throw new OutcomeTransitionError(
          "INVALID_TRANSITION",
          "A job cannot be its own reservice.",
        );
      }
      if (
        new Date(command.linkedAt).getTime() <=
        new Date(current.completedAt).getTime()
      ) {
        throw new OutcomeTransitionError(
          "INVALID_TRANSITION",
          "A reservice must be linked after the original job is completed.",
        );
      }
      return nextSnapshot(
        current,
        command,
        {
          status: "RESERVICE_REQUIRED",
          reserviceLinks: [
            ...current.reserviceLinks,
            {
              jobId: command.reserviceJobId,
              linkedAt: command.linkedAt,
              costStatus: "PENDING",
              directCostCents: null,
              finalizedAt: null,
            },
          ],
        },
        command.linkedAt,
      );
    }

    case "FINALIZE_RESERVICE_COST": {
      const index = current.reserviceLinks.findIndex(
        (link) => link.jobId === command.reserviceJobId,
      );
      if (index < 0) {
        throw new OutcomeTransitionError(
          "RESERVICE_NOT_LINKED",
          "The reservice job must be linked before its cost is finalized.",
        );
      }
      if (current.reserviceLinks[index].costStatus === "FINALIZED") {
        throw new OutcomeTransitionError(
          "RESERVICE_COST_ALREADY_FINALIZED",
          "The linked reservice cost is already finalized.",
        );
      }
      if (
        new Date(command.finalizedAt).getTime() <
        new Date(current.reserviceLinks[index].linkedAt).getTime()
      ) {
        throw new OutcomeTransitionError(
          "INVALID_TRANSITION",
          "Reservice cost cannot be finalized before the reservice was linked.",
        );
      }

      const reserviceLinks = current.reserviceLinks.map((link, linkIndex) =>
        linkIndex === index
          ? {
              ...link,
              costStatus: "FINALIZED" as const,
              directCostCents: command.directCostCents,
              finalizedAt: command.finalizedAt,
            }
          : link,
      );
      const actualReserviceCostCents = reserviceLinks.reduce(
        (total, link) => total + (link.directCostCents ?? 0),
        0,
      );
      return nextSnapshot(
        current,
        command,
        { reserviceLinks, actualReserviceCostCents },
        command.finalizedAt,
      );
    }
  }
}

function nextSnapshot(
  current: OutcomeSnapshot,
  command: OutcomeCommand,
  patch: Partial<OutcomeSnapshot>,
  updatedAt: string,
): OutcomeSnapshot {
  return OutcomeSnapshotSchema.parse({
    ...current,
    ...patch,
    version: current.version + 1,
    lastCommandId: command.commandId,
    updatedAt,
  });
}
