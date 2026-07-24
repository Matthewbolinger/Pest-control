import { z } from "zod";
import {
  calculateRecurrenceRisk,
  huntleyCandidates,
  TriageResultSchema,
  type TriageResult,
} from "../domain";
import {
  calculateActualEconomics,
  calculateExpectedEconomics,
  finalizeEconomics,
  ActualEconomicsSnapshotSchema,
  ExpectedEconomicsSnapshotSchema,
  FinalEconomicsSnapshotSchema,
} from "../domain/economics";
import {
  EvidencePhaseSchema,
  EvidencePolicySchema,
  EvidenceSubjectSchema,
  evaluateEvidencePolicy,
} from "../domain/evidence-policy";
import {
  OutcomeStatusSchema,
  OutcomeVerificationSourceSchema,
} from "../domain/outcomes";

export const FIELDPROOF_DEMO = {
  workflowId: "WF-JOB-2048",
  serviceRequestId: "SR-1048",
  jobId: "JOB-2048",
  propertyId: "PROP-118",
  playbookVersionId: "PBV-ROD-3.2",
  zoneIds: ["ZONE-BASEMENT"] as const,
  candidateTechnicians: {
    "SC-2401": "TECH-04",
    "SC-2402": "TECH-07",
    "SC-2403": "TECH-02",
  } as const,
} as const;

export const RODENT_EVIDENCE_POLICY = EvidencePolicySchema.parse({
  policyVersion: "rodent-inspection-evidence-v1",
  requirements: [
    {
      id: "REQ-BEFORE-OVERVIEW",
      label: "Before-service area overview",
      phase: "BEFORE",
      subject: "AREA_OVERVIEW",
      zoneId: "ZONE-BASEMENT",
      minimumCount: 1,
    },
    {
      id: "REQ-DURING-ENTRY",
      label: "Entry-point or pest-finding detail",
      phase: "DURING",
      subject: "ENTRY_POINT",
      zoneId: "ZONE-BASEMENT",
      minimumCount: 1,
    },
  ],
});

export const EvidenceRecordSchema = z
  .object({
    id: z.string().regex(/^EV-[0-9a-f-]{36}$/i),
    kind: z.literal("FIELD_PHOTO"),
    phase: EvidencePhaseSchema.default("DURING"),
    subject: EvidenceSubjectSchema.default("OTHER"),
    caption: z.string().trim().max(240).nullable().default(null),
    contentType: z.enum(["image/jpeg", "image/png", "image/webp"]),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    capturedAt: z.number().int().nonnegative(),
    uploadedAt: z.number().int().nonnegative().optional(),
    zoneId: z.string().min(1).max(128),
  })
  .strict();

export type EvidenceRecord = z.infer<typeof EvidenceRecordSchema>;

const VerificationSchema = z
  .object({
    result: z.enum([
      "RESOLVED",
      "PARTIALLY_RESOLVED",
      "UNRESOLVED",
      "CUSTOMER_UNREACHABLE",
    ]),
    source: OutcomeVerificationSourceSchema,
    note: z.string().trim().min(3).max(2000),
    verifiedAt: z.string().datetime(),
    verifiedById: z.string().min(1).max(128),
  })
  .strict();

const ActualInputsSchema = z
  .object({
    driveMinutes: z.number().int().min(0).max(600),
    materialCostCents: z.number().int().min(0).max(1_000_000),
    laborMinutes: z.number().int().min(1).max(1_440),
    technicianNote: z.string().trim().min(3).max(2000),
  })
  .strict();

export const WorkflowSnapshotSchema = z
  .object({
    workflowId: z.string().min(1).max(128),
    serviceRequestId: z.string().min(1).max(128),
    jobId: z.string().min(1).max(128),
    propertyId: z.string().min(1).max(128),
    playbookVersionId: z
      .string()
      .min(1)
      .max(128)
      .default(FIELDPROOF_DEMO.playbookVersionId),
    assignedTechnicianId: z.string().min(1).nullable(),
    version: z.number().int().min(1),
    lastCommandId: z.string().min(8).max(128).nullable(),
    triageStatus: z.enum(["NEW", "PROPOSED", "APPROVED"]),
    triageProposal: TriageResultSchema.nullable(),
    scheduled: z.boolean(),
    selectedCandidateId: z
      .enum(["SC-2401", "SC-2402", "SC-2403"])
      .nullable(),
    checkedIn: z.boolean(),
    checkedInAt: z.string().datetime().nullable().default(null),
    checklist: z.tuple([
      z.boolean(),
      z.boolean(),
      z.boolean(),
      z.boolean(),
    ]),
    evidence: z.array(EvidenceRecordSchema),
    evidenceCount: z.number().int().nonnegative(),
    evidencePolicyVersion: z
      .string()
      .min(1)
      .default(RODENT_EVIDENCE_POLICY.policyVersion),
    evidenceRequirementsSatisfied: z.boolean().default(false),
    missingEvidenceRequirementIds: z.array(z.string()).default(
      RODENT_EVIDENCE_POLICY.requirements.map((item) => item.id),
    ),
    observation: z.string().min(3).max(1000).nullable(),
    observationCategory: z
      .enum(["PEST_EVIDENCE", "ENTRY_POINT", "CONDITION", "OTHER"])
      .nullable()
      .default(null),
    riskReview: z.enum(["NOT_REVIEWED", "CLEAR", "UNRESOLVED"]),
    completed: z.boolean(),
    completedAt: z.string().datetime().nullable().default(null),
    completedByUserId: z.string().min(1).max(128).nullable().default(null),
    technicianAssessment: z
      .enum(["CLEAR", "OPEN_RISK"])
      .nullable()
      .default(null),
    outcome: OutcomeStatusSchema.nullable(),
    outcomeVersion: z.number().int().min(0).default(0),
    verificationWindowEndsAt: z.string().datetime().nullable().default(null),
    verification: VerificationSchema.nullable().default(null),
    reserviceJobIds: z.array(z.string().min(1).max(128)).default([]),
    reserviceCosts: z
      .array(
        z
          .object({
            jobId: z.string().min(1).max(128),
            directCostCents: z.number().int().nonnegative(),
          })
          .strict(),
      )
      .default([]),
    actualReserviceCostCents: z.number().int().nonnegative().default(0),
    followUpCreated: z.boolean(),
    proofGenerated: z.boolean(),
    proofId: z.string().min(1).max(128).nullable().default(null),
    proofRevision: z.number().int().min(0).default(0),
    proofSha256: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .nullable()
      .default(null),
    proofDeliveryStatus: z
      .enum([
        "NOT_QUEUED",
        "QUEUED",
        "SENDING",
        "SENT",
        "DELIVERED",
        "BOUNCED",
        "FAILED_RETRYABLE",
        "FAILED_FINAL",
      ])
      .default("NOT_QUEUED"),
    proofSent: z.boolean(),
    exceptionOwnerUserId: z.string().min(1).max(128).nullable().default(null),
    exceptionResolutionNote: z
      .string()
      .min(3)
      .max(1000)
      .nullable()
      .default(null),
    exceptionResolved: z.boolean(),
    expectedEconomics: ExpectedEconomicsSnapshotSchema.nullable().default(null),
    actualEconomics: ActualEconomicsSnapshotSchema.nullable().default(null),
    finalEconomics: FinalEconomicsSnapshotSchema.nullable().default(null),
    actualInputs: ActualInputsSchema.nullable().default(null),
    riskScore: z.number().int().min(0).max(100),
    updatedAt: z.string().datetime(),
  })
  .strict()
  .superRefine((snapshot, context) => {
    if (snapshot.evidenceCount !== snapshot.evidence.length) {
      context.addIssue({
        code: "custom",
        path: ["evidenceCount"],
        message: "Evidence count must match the persisted evidence ledger.",
      });
    }
    if (snapshot.proofSent && snapshot.proofDeliveryStatus !== "DELIVERED") {
      context.addIssue({
        code: "custom",
        path: ["proofSent"],
        message: "Proof may be marked sent only after confirmed delivery.",
      });
    }
    if (
      snapshot.outcome === "PENDING_VERIFICATION" &&
      snapshot.verification !== null
    ) {
      context.addIssue({
        code: "custom",
        path: ["verification"],
        message: "A pending outcome cannot contain a verification result.",
      });
    }
    const costIds = snapshot.reserviceCosts.map((item) => item.jobId);
    if (
      new Set(costIds).size !== costIds.length ||
      costIds.some((id) => !snapshot.reserviceJobIds.includes(id)) ||
      snapshot.reserviceJobIds.some((id) => !costIds.includes(id))
    ) {
      context.addIssue({
        code: "custom",
        path: ["reserviceCosts"],
        message:
          "Reservice cost provenance must match each distinct linked reservice job.",
      });
    }
    if (
      snapshot.reserviceCosts.reduce(
        (total, item) => total + item.directCostCents,
        0,
      ) !== snapshot.actualReserviceCostCents
    ) {
      context.addIssue({
        code: "custom",
        path: ["actualReserviceCostCents"],
        message:
          "Actual reservice cost must equal the linked job cost provenance.",
      });
    }
  });

export type WorkflowSnapshot = z.infer<typeof WorkflowSnapshotSchema>;

const CommandBase = {
  commandId: z
    .string()
    .min(8)
    .max(128)
    .regex(/^[A-Za-z0-9:_-]+$/, "Use a stable opaque command identifier."),
  expectedVersion: z.number().int().min(1),
};

export const WorkflowCommandSchema = z.discriminatedUnion("type", [
  z.object({ ...CommandBase, type: z.literal("RUN_TRIAGE") }).strict(),
  z.object({ ...CommandBase, type: z.literal("APPROVE_TRIAGE") }).strict(),
  z
    .object({
      ...CommandBase,
      type: z.literal("APPROVE_SCHEDULE"),
      candidateId: z.enum(["SC-2401", "SC-2402", "SC-2403"]),
    })
    .strict(),
  z.object({ ...CommandBase, type: z.literal("CHECK_IN") }).strict(),
  z
    .object({
      ...CommandBase,
      type: z.literal("SET_CHECKLIST_STEP"),
      index: z.number().int().min(0).max(3),
      complete: z.boolean(),
    })
    .strict(),
  z
    .object({
      ...CommandBase,
      type: z.literal("ADD_OBSERVATION"),
      note: z.string().trim().min(3).max(1000),
      category: z
        .enum(["PEST_EVIDENCE", "ENTRY_POINT", "CONDITION", "OTHER"])
        .default("PEST_EVIDENCE"),
    })
    .strict(),
  z
    .object({
      ...CommandBase,
      type: z.literal("REVIEW_RISK"),
      unresolved: z.boolean(),
    })
    .strict(),
  z
    .object({
      ...CommandBase,
      type: z.literal("COMPLETE_JOB"),
      actualDriveMinutes: z.number().int().min(0).max(600).default(11),
      actualMaterialCostCents: z
        .number()
        .int()
        .min(0)
        .max(1_000_000)
        .default(800),
      technicianNote: z
        .string()
        .trim()
        .min(3)
        .max(2000)
        .default("Inspection documentation completed."),
    })
    .strict(),
  z
    .object({
      ...CommandBase,
      type: z.literal("SEND_PROOF"),
      channel: z.enum(["EMAIL", "SMS"]).default("EMAIL"),
      recipient: z
        .string()
        .trim()
        .min(3)
        .max(320)
        .default("jamie.morrison@example.test"),
    })
    .strict(),
  z
    .object({
      ...CommandBase,
      type: z.literal("VERIFY_OUTCOME"),
      result: z.enum([
        "RESOLVED",
        "PARTIALLY_RESOLVED",
        "UNRESOLVED",
        "CUSTOMER_UNREACHABLE",
      ]),
      source: OutcomeVerificationSourceSchema,
      note: z.string().trim().min(3).max(2000),
    })
    .strict(),
  z
    .object({
      ...CommandBase,
      type: z.literal("RECORD_RESERVICE"),
      reserviceJobId: z.string().trim().min(1).max(128),
      reason: z.string().trim().min(3).max(1000),
      directCostCents: z.number().int().min(0).max(10_000_000),
    })
    .strict(),
  z
    .object({
      ...CommandBase,
      type: z.literal("RESOLVE_EXCEPTION"),
      ownerUserId: z.string().trim().min(1).max(128).default("USER-OWNER"),
      resolutionNote: z
        .string()
        .trim()
        .min(3)
        .max(1000)
        .default("Assigned to the pilot owner and follow-up accepted."),
    })
    .strict(),
  z.object({ ...CommandBase, type: z.literal("RESET_DEMO") }).strict(),
]);

export type WorkflowCommand = z.infer<typeof WorkflowCommandSchema>;

export type WorkflowServerFacts = {
  triageProposal?: TriageResult;
  actorId?: string;
  verifierId?: string;
  verifiedAt?: string;
  verificationWindowDays?: number;
};

export class WorkflowTransitionError extends Error {
  readonly code = "INVALID_TRANSITION";

  constructor(message: string) {
    super(message);
    this.name = "WorkflowTransitionError";
  }
}

export function createInitialWorkflowSnapshot(
  updatedAt = new Date().toISOString(),
): WorkflowSnapshot {
  return WorkflowSnapshotSchema.parse({
    workflowId: FIELDPROOF_DEMO.workflowId,
    serviceRequestId: FIELDPROOF_DEMO.serviceRequestId,
    jobId: FIELDPROOF_DEMO.jobId,
    propertyId: FIELDPROOF_DEMO.propertyId,
    playbookVersionId: FIELDPROOF_DEMO.playbookVersionId,
    assignedTechnicianId: null,
    version: 1,
    lastCommandId: null,
    triageStatus: "NEW",
    triageProposal: null,
    scheduled: false,
    selectedCandidateId: null,
    checkedIn: false,
    checkedInAt: null,
    checklist: [false, false, false, false],
    evidence: [],
    evidenceCount: 0,
    evidencePolicyVersion: RODENT_EVIDENCE_POLICY.policyVersion,
    evidenceRequirementsSatisfied: false,
    missingEvidenceRequirementIds: RODENT_EVIDENCE_POLICY.requirements.map(
      (item) => item.id,
    ),
    observation: null,
    observationCategory: null,
    riskReview: "NOT_REVIEWED",
    completed: false,
    completedAt: null,
    completedByUserId: null,
    technicianAssessment: null,
    outcome: null,
    outcomeVersion: 0,
    verificationWindowEndsAt: null,
    verification: null,
    reserviceJobIds: [],
    reserviceCosts: [],
    actualReserviceCostCents: 0,
    followUpCreated: false,
    proofGenerated: false,
    proofId: null,
    proofRevision: 0,
    proofSha256: null,
    proofDeliveryStatus: "NOT_QUEUED",
    proofSent: false,
    exceptionOwnerUserId: null,
    exceptionResolutionNote: null,
    exceptionResolved: false,
    expectedEconomics: null,
    actualEconomics: null,
    finalEconomics: null,
    actualInputs: null,
    riskScore: workflowRiskScore(false),
    updatedAt,
  });
}

export function applyWorkflowCommand(
  currentInput: WorkflowSnapshot,
  commandInput: WorkflowCommand,
  updatedAt = new Date().toISOString(),
  serverFacts: WorkflowServerFacts = {},
): WorkflowSnapshot {
  const current = WorkflowSnapshotSchema.parse(currentInput);
  const command = WorkflowCommandSchema.parse(commandInput);
  if (command.expectedVersion !== current.version) {
    throw new WorkflowTransitionError(
      `Expected workflow version ${command.expectedVersion}, but the current version is ${current.version}.`,
    );
  }

  let patch: Partial<WorkflowSnapshot>;
  switch (command.type) {
    case "RUN_TRIAGE":
      requireTransition(
        current.triageStatus === "NEW",
        "Triage can only run for a new service request.",
      );
      requireTransition(
        serverFacts.triageProposal !== undefined,
        "A server-validated triage proposal is required.",
      );
      patch = {
        triageStatus: "PROPOSED",
        triageProposal: TriageResultSchema.parse(serverFacts.triageProposal),
      };
      break;
    case "APPROVE_TRIAGE":
      requireTransition(
        current.triageStatus === "PROPOSED" &&
          current.triageProposal?.serviceable === true,
        "A validated, serviceable triage proposal must exist before approval.",
      );
      patch = { triageStatus: "APPROVED" };
      break;
    case "APPROVE_SCHEDULE": {
      requireTransition(
        current.triageStatus === "APPROVED" && !current.scheduled,
        "An approved, unscheduled request is required before choosing a schedule.",
      );
      const candidate = huntleyCandidates.find(
        (item) => item.id === command.candidateId,
      );
      requireTransition(
        candidate !== undefined && candidate.eligible,
        "The selected schedule candidate is not eligible.",
      );
      patch = {
        scheduled: true,
        selectedCandidateId: command.candidateId,
        assignedTechnicianId: candidate.technicianId,
        expectedEconomics: expectedEconomicsFor(candidate),
      };
      break;
    }
    case "CHECK_IN":
      requireTransition(
        current.scheduled && !current.checkedIn && !current.completed,
        "The assigned job must be scheduled and not already checked in.",
      );
      patch = { checkedIn: true, checkedInAt: updatedAt };
      break;
    case "SET_CHECKLIST_STEP": {
      requireActiveFieldJob(current);
      const checklist = [...current.checklist] as WorkflowSnapshot["checklist"];
      checklist[command.index] = command.complete;
      requireTransition(
        checklist[command.index] !== current.checklist[command.index],
        "The checklist step is already in the requested state.",
      );
      patch = { checklist };
      break;
    }
    case "ADD_OBSERVATION":
      requireActiveFieldJob(current);
      requireTransition(
        current.observation !== command.note,
        "That observation has already been recorded.",
      );
      patch = {
        observation: command.note,
        observationCategory: command.category,
      };
      break;
    case "REVIEW_RISK":
      requireActiveFieldJob(current);
      requireTransition(
        current.observation !== null,
        "Record an observation before reviewing recurrence risk.",
      );
      requireTransition(
        current.riskReview === "NOT_REVIEWED" ||
          current.riskReview !== (command.unresolved ? "UNRESOLVED" : "CLEAR"),
        "The risk review is already in the requested state.",
      );
      patch = {
        riskReview: command.unresolved ? "UNRESOLVED" : "CLEAR",
        riskScore: workflowRiskScore(command.unresolved),
      };
      break;
    case "COMPLETE_JOB": {
      requireActiveFieldJob(current);
      requireTransition(
        current.checklist.every(Boolean),
        "All four required checklist steps must be complete.",
      );
      const evidenceResult = workflowEvidenceResult(current.evidence);
      requireTransition(
        evidenceResult.satisfied,
        `Required evidence is missing: ${evidenceResult.missingRequirementIds.join(", ")}.`,
      );
      requireTransition(
        current.observation !== null,
        "A structured observation is required.",
      );
      requireTransition(
        current.riskReview !== "NOT_REVIEWED",
        "Risk must be explicitly reviewed as clear or unresolved.",
      );
      const expected =
        current.expectedEconomics ??
        expectedEconomicsFor(
          huntleyCandidates.find(
            (item) => item.id === current.selectedCandidateId,
          ) ?? huntleyCandidates[0],
        );
      const laborMinutes = elapsedMinutes(current.checkedInAt, updatedAt);
      const technician = huntleyCandidates.find(
        (item) => item.technicianId === current.assignedTechnicianId,
      );
      const laborRateCents = Math.round(
        (technician?.margin.laborCostPerHour ?? 31) * 100,
      );
      const actualEconomics = calculateActualEconomics({
        expected,
        actualRevenueCents: expected.revenueCents,
        actualLaborMinutes: laborMinutes,
        laborCostPerHourCents: laborRateCents,
        actualDriveMinutes: command.actualDriveMinutes,
        driveCostPerMinuteCents: 72,
        actualMaterialCostCents: command.actualMaterialCostCents,
      });
      const unresolved = current.riskReview === "UNRESOLVED";
      const verificationWindowDays = serverFacts.verificationWindowDays ?? 7;
      patch = {
        completed: true,
        completedAt: updatedAt,
        completedByUserId: serverFacts.actorId ?? "UNCONFIRMED-ACTOR",
        technicianAssessment: unresolved ? "OPEN_RISK" : "CLEAR",
        // Completion proves field work. It never proves customer resolution.
        outcome: "PENDING_VERIFICATION",
        outcomeVersion: 1,
        verificationWindowEndsAt: addDays(
          updatedAt,
          verificationWindowDays,
        ),
        verification: null,
        followUpCreated: unresolved,
        proofGenerated: true,
        proofId: `SP-${current.jobId}`,
        proofRevision: 1,
        proofDeliveryStatus: "NOT_QUEUED",
        proofSent: false,
        evidenceRequirementsSatisfied: true,
        missingEvidenceRequirementIds: [],
        actualInputs: {
          driveMinutes: command.actualDriveMinutes,
          materialCostCents: command.actualMaterialCostCents,
          laborMinutes,
          technicianNote: command.technicianNote,
        },
        expectedEconomics: expected,
        actualEconomics,
        finalEconomics: null,
        riskScore: workflowRiskScore(unresolved),
      };
      break;
    }
    case "SEND_PROOF":
      requireTransition(
        current.completed &&
          current.proofGenerated &&
          current.proofDeliveryStatus === "NOT_QUEUED",
        "A generated Service Proof that has not been queued is required.",
      );
      patch = {
        proofDeliveryStatus: "QUEUED",
        proofSent: false,
      };
      break;
    case "VERIFY_OUTCOME": {
      requireTransition(
        current.completed && current.outcome === "PENDING_VERIFICATION",
        "Only a completed job pending independent verification can be verified.",
      );
      const verifierId = serverFacts.verifierId ?? "SYSTEM-VERIFIER";
      requireTransition(
        verifierId !== current.completedByUserId,
        "Outcome verification must be independent from field completion.",
      );
      const verifiedAt = serverFacts.verifiedAt ?? updatedAt;
      requireTransition(
        current.completedAt !== null &&
          new Date(verifiedAt).getTime() >
            new Date(current.completedAt).getTime(),
        "Outcome verification must occur after field completion.",
      );
      requireTransition(
        current.actualEconomics !== null,
        "Actual completion economics are required before outcome verification.",
      );
      patch = {
        outcome: command.result,
        outcomeVersion: current.outcomeVersion + 1,
        verification: {
          result: command.result,
          source: command.source,
          note: command.note,
          verifiedAt,
          verifiedById: verifierId,
        },
        finalEconomics: finalizeEconomics({
          actual: current.actualEconomics,
          linkedReserviceActuals: [],
        }),
      };
      break;
    }
    case "RECORD_RESERVICE": {
      requireTransition(
        current.completed &&
          current.actualEconomics !== null &&
          current.outcome !== null,
        "A completed job with actual economics is required before linking a reservice.",
      );
      requireTransition(
        command.reserviceJobId !== current.jobId,
        "A job cannot be linked as its own reservice.",
      );
      requireTransition(
        !current.reserviceJobIds.includes(command.reserviceJobId),
        "That reservice job is already linked.",
      );
      const reserviceCosts = [
        ...current.reserviceCosts,
        {
          jobId: command.reserviceJobId,
          directCostCents: command.directCostCents,
        },
      ];
      const cumulativeReserviceCost = reserviceCosts.reduce(
        (total, item) => total + item.directCostCents,
        0,
      );
      patch = {
        outcome: "RESERVICE_REQUIRED",
        outcomeVersion: Math.max(1, current.outcomeVersion + 1),
        reserviceJobIds: [
          ...current.reserviceJobIds,
          command.reserviceJobId,
        ],
        reserviceCosts,
        actualReserviceCostCents: cumulativeReserviceCost,
        finalEconomics: finalizeEconomics({
          actual: current.actualEconomics,
          linkedReserviceActuals: reserviceCosts.map((item) => ({
            jobId: item.jobId,
            actual: syntheticReserviceActual(item.directCostCents),
          })),
        }),
      };
      break;
    }
    case "RESOLVE_EXCEPTION":
      requireTransition(
        current.followUpCreated && !current.exceptionResolved,
        current.exceptionResolved
          ? "The exception is already resolved."
          : "No unresolved-risk follow-up exception exists.",
      );
      patch = {
        exceptionOwnerUserId: command.ownerUserId,
        exceptionResolutionNote: command.resolutionNote,
        exceptionResolved: true,
      };
      break;
    case "RESET_DEMO": {
      const reset = createInitialWorkflowSnapshot(updatedAt);
      return {
        ...reset,
        version: current.version + 1,
        lastCommandId: command.commandId,
      };
    }
  }

  return WorkflowSnapshotSchema.parse({
    ...current,
    ...patch,
    evidenceCount: current.evidence.length,
    version: current.version + 1,
    lastCommandId: command.commandId,
    updatedAt,
  });
}

export function appendEvidenceRecord(
  currentInput: WorkflowSnapshot,
  recordInput: EvidenceRecord,
  commandId: string,
  updatedAt = new Date().toISOString(),
): WorkflowSnapshot {
  const current = WorkflowSnapshotSchema.parse(currentInput);
  const record = EvidenceRecordSchema.parse(recordInput);
  requireActiveFieldJob(current);
  requireTransition(
    !current.evidence.some((item) => item.id === record.id),
    "The evidence record already exists.",
  );
  requireTransition(
    !current.evidence.some(
      (item) =>
        item.sha256 === record.sha256 &&
        item.phase === record.phase &&
        item.subject === record.subject,
    ),
    "An identical evidence file already fills that proof requirement.",
  );
  const evidence = [...current.evidence, record];
  const evidenceResult = workflowEvidenceResult(evidence);
  return WorkflowSnapshotSchema.parse({
    ...current,
    evidence,
    evidenceCount: evidence.length,
    evidenceRequirementsSatisfied: evidenceResult.satisfied,
    missingEvidenceRequirementIds: evidenceResult.missingRequirementIds,
    version: current.version + 1,
    lastCommandId: commandId,
    updatedAt,
  });
}

export function workflowEvidenceResult(evidence: EvidenceRecord[]) {
  return evaluateEvidencePolicy(
    RODENT_EVIDENCE_POLICY,
    evidence.map((item) => ({
      id: item.id,
      phase: item.phase,
      subject: item.subject,
      zoneId: item.zoneId,
      capturedAt: new Date(item.capturedAt).toISOString(),
    })),
  );
}

function requireActiveFieldJob(current: WorkflowSnapshot) {
  requireTransition(
    current.scheduled && current.checkedIn && !current.completed,
    "An active, checked-in field job is required.",
  );
}

function requireTransition(
  condition: boolean,
  message: string,
): asserts condition {
  if (!condition) throw new WorkflowTransitionError(message);
}

function workflowRiskScore(unresolved: boolean) {
  return calculateRecurrenceRisk({
    relatedIssues: 1,
    reserviceEvents90Days: 0,
    openRisks: unresolved ? 1 : 0,
    missingEvidence: false,
    incompleteSteps: false,
    priorUnresolvedOutcome: false,
    followUpOverdue: false,
    uncertaintyFlag: false,
  }).score;
}

function expectedEconomicsFor(
  candidate: (typeof huntleyCandidates)[number],
) {
  return calculateExpectedEconomics({
    revenueCents: Math.round(candidate.margin.price * 100),
    estimatedLaborMinutes: candidate.margin.laborMinutes,
    laborCostPerHourCents: Math.round(
      candidate.margin.laborCostPerHour * 100,
    ),
    estimatedDriveMinutes: candidate.margin.driveMinutes,
    driveCostPerMinuteCents: Math.round(
      candidate.margin.driveCostPerMinute * 100,
    ),
    materialEstimateCents: Math.round(
      candidate.margin.materialEstimate * 100,
    ),
    reserviceProbabilityBasisPoints: Math.round(
      candidate.margin.reserviceProbability * 10_000,
    ),
    averageReserviceCostCents: Math.round(
      candidate.margin.averageReserviceCost * 100,
    ),
  });
}

function elapsedMinutes(start: string | null, end: string) {
  if (!start) return 1;
  const elapsed = new Date(end).getTime() - new Date(start).getTime();
  return Math.max(1, Math.min(1_440, Math.ceil(elapsed / 60_000)));
}

function addDays(value: string, days: number) {
  return new Date(
    new Date(value).getTime() + days * 24 * 60 * 60 * 1000,
  ).toISOString();
}

function syntheticReserviceActual(directCostCents: number) {
  return ActualEconomicsSnapshotSchema.parse({
    phase: "ACTUAL_AT_COMPLETION",
    revenueCents: 0,
    laborMinutes: 0,
    laborCostCents: 0,
    driveMinutes: 0,
    driveCostCents: 0,
    materialCostCents: directCostCents,
    expectedReserviceCostCents: 0,
    actualReserviceCostCents: 0,
    contributionMarginCents: -directCostCents,
  });
}
