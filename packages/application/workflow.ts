import { z } from "zod";
import {
  calculateRecurrenceRisk,
  huntleyCandidates,
  TriageResultSchema,
  type TriageResult,
} from "../domain";

export const FIELDPROOF_DEMO = {
  workflowId: "WF-JOB-2048",
  serviceRequestId: "SR-1048",
  jobId: "JOB-2048",
  propertyId: "PROP-118",
  zoneIds: ["ZONE-BASEMENT"] as const,
  candidateTechnicians: {
    "SC-2401": "TECH-04",
    "SC-2402": "TECH-07",
    "SC-2403": "TECH-02",
  } as const,
} as const;

export const EvidenceRecordSchema = z
  .object({
    id: z.string().regex(/^EV-[0-9a-f-]{36}$/i),
    kind: z.literal("FIELD_PHOTO"),
    contentType: z.enum(["image/jpeg", "image/png", "image/webp"]),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    capturedAt: z.number().int().nonnegative(),
    zoneId: z.enum(FIELDPROOF_DEMO.zoneIds),
  })
  .strict();

export type EvidenceRecord = z.infer<typeof EvidenceRecordSchema>;

export const WorkflowSnapshotSchema = z
  .object({
    workflowId: z.literal(FIELDPROOF_DEMO.workflowId),
    serviceRequestId: z.literal(FIELDPROOF_DEMO.serviceRequestId),
    jobId: z.literal(FIELDPROOF_DEMO.jobId),
    propertyId: z.literal(FIELDPROOF_DEMO.propertyId),
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
    checklist: z.tuple([
      z.boolean(),
      z.boolean(),
      z.boolean(),
      z.boolean(),
    ]),
    evidence: z.array(EvidenceRecordSchema),
    evidenceCount: z.number().int().nonnegative(),
    observation: z.string().min(3).max(1000).nullable(),
    riskReview: z.enum(["NOT_REVIEWED", "CLEAR", "UNRESOLVED"]),
    completed: z.boolean(),
    outcome: z.enum(["RESOLVED", "PARTIALLY_RESOLVED"]).nullable(),
    followUpCreated: z.boolean(),
    proofGenerated: z.boolean(),
    proofSent: z.boolean(),
    exceptionResolved: z.boolean(),
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
    })
    .strict(),
  z
    .object({
      ...CommandBase,
      type: z.literal("REVIEW_RISK"),
      unresolved: z.boolean(),
    })
    .strict(),
  z.object({ ...CommandBase, type: z.literal("COMPLETE_JOB") }).strict(),
  z.object({ ...CommandBase, type: z.literal("SEND_PROOF") }).strict(),
  z.object({ ...CommandBase, type: z.literal("RESOLVE_EXCEPTION") }).strict(),
  z.object({ ...CommandBase, type: z.literal("RESET_DEMO") }).strict(),
]);

export type WorkflowCommand = z.infer<typeof WorkflowCommandSchema>;

export type WorkflowServerFacts = {
  triageProposal?: TriageResult;
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
  return {
    workflowId: FIELDPROOF_DEMO.workflowId,
    serviceRequestId: FIELDPROOF_DEMO.serviceRequestId,
    jobId: FIELDPROOF_DEMO.jobId,
    propertyId: FIELDPROOF_DEMO.propertyId,
    assignedTechnicianId: null,
    version: 1,
    lastCommandId: null,
    triageStatus: "NEW",
    triageProposal: null,
    scheduled: false,
    selectedCandidateId: null,
    checkedIn: false,
    checklist: [false, false, false, false],
    evidence: [],
    evidenceCount: 0,
    observation: null,
    riskReview: "NOT_REVIEWED",
    completed: false,
    outcome: null,
    followUpCreated: false,
    proofGenerated: false,
    proofSent: false,
    exceptionResolved: false,
    riskScore: workflowRiskScore(false),
    updatedAt,
  };
}

export function applyWorkflowCommand(
  current: WorkflowSnapshot,
  command: WorkflowCommand,
  updatedAt = new Date().toISOString(),
  serverFacts: WorkflowServerFacts = {},
): WorkflowSnapshot {
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
        triageProposal: TriageResultSchema.parse(
          serverFacts.triageProposal,
        ),
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
      };
      break;
    }
    case "CHECK_IN":
      requireTransition(
        current.scheduled && !current.checkedIn && !current.completed,
        "The assigned job must be scheduled and not already checked in.",
      );
      patch = { checkedIn: true };
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
      patch = { observation: command.note };
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
      requireTransition(
        current.evidenceCount >= 2,
        "At least two persisted evidence records are required.",
      );
      requireTransition(
        current.observation !== null,
        "A structured observation is required.",
      );
      requireTransition(
        current.riskReview !== "NOT_REVIEWED",
        "Risk must be explicitly reviewed as clear or unresolved.",
      );
      const unresolved = current.riskReview === "UNRESOLVED";
      patch = {
        completed: true,
        outcome: unresolved ? "PARTIALLY_RESOLVED" : "RESOLVED",
        followUpCreated: unresolved,
        proofGenerated: true,
        riskScore: workflowRiskScore(unresolved),
      };
      break;
    }
    case "SEND_PROOF":
      requireTransition(
        current.completed && current.proofGenerated && !current.proofSent,
        "A generated Service Proof that has not been queued is required.",
      );
      patch = { proofSent: true };
      break;
    case "RESOLVE_EXCEPTION":
      requireTransition(
        current.followUpCreated && !current.exceptionResolved,
        current.exceptionResolved
          ? "The exception is already resolved."
          : "No unresolved-risk follow-up exception exists.",
      );
      patch = { exceptionResolved: true };
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

  return {
    ...current,
    ...patch,
    evidenceCount: current.evidence.length,
    version: current.version + 1,
    lastCommandId: command.commandId,
    updatedAt,
  };
}

export function appendEvidenceRecord(
  current: WorkflowSnapshot,
  record: EvidenceRecord,
  commandId: string,
  updatedAt = new Date().toISOString(),
): WorkflowSnapshot {
  requireActiveFieldJob(current);
  requireTransition(
    !current.evidence.some((item) => item.id === record.id),
    "The evidence record already exists.",
  );
  const evidence = [...current.evidence, record];
  return {
    ...current,
    evidence,
    evidenceCount: evidence.length,
    version: current.version + 1,
    lastCommandId: commandId,
    updatedAt,
  };
}

function requireActiveFieldJob(current: WorkflowSnapshot) {
  requireTransition(
    current.scheduled && current.checkedIn && !current.completed,
    "An active, checked-in field job is required.",
  );
}

function requireTransition(condition: boolean, message: string): asserts condition {
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
