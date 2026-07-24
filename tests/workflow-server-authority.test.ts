import { describe, expect, it } from "vitest";
import {
  appendEvidenceRecord,
  applyWorkflowCommand,
  createInitialWorkflowSnapshot,
  WorkflowCommandSchema,
  WorkflowSnapshotSchema,
  WorkflowTransitionError,
  type EvidenceRecord,
  type WorkflowCommand,
  type WorkflowSnapshot,
} from "../packages/application/workflow";
import type { TriageResult } from "../packages/domain";
import {
  detectEvidenceContentType,
  evidenceExtension,
} from "../packages/application/evidence";
import {
  getRequestIdentity,
  isCrossSiteMutation,
} from "../app/api/v1/request-context";

describe("server-authoritative workflow reducer", () => {
  it("enforces the ordered request, schedule, and check-in transitions", () => {
    let snapshot = initial();

    expect(() =>
      transition(snapshot, {
        type: "APPROVE_TRIAGE",
      }),
    ).toThrow(WorkflowTransitionError);

    snapshot = transition(snapshot, { type: "RUN_TRIAGE" });
    expect(snapshot.triageStatus).toBe("PROPOSED");
    expect(snapshot.triageProposal).toMatchObject({
      issueCategory: "RODENT",
      confidence: 0.94,
      serviceable: true,
    });
    snapshot = transition(snapshot, { type: "APPROVE_TRIAGE" });
    snapshot = transition(snapshot, {
      type: "APPROVE_SCHEDULE",
      candidateId: "SC-2402",
    });

    expect(snapshot.assignedTechnicianId).toBe("TECH-07");
    expect(snapshot.selectedCandidateId).toBe("SC-2402");

    snapshot = transition(snapshot, { type: "CHECK_IN" });
    expect(snapshot.checkedIn).toBe(true);
    expect(snapshot.version).toBe(5);
  });

  it("rejects completion until every persisted-proof gate passes", () => {
    let snapshot = checkedIn();
    expect(() =>
      transition(snapshot, { type: "COMPLETE_JOB" }),
    ).toThrow("All four required checklist steps");

    for (let index = 0; index < 4; index += 1) {
      snapshot = transition(snapshot, {
        type: "SET_CHECKLIST_STEP",
        index,
        complete: true,
      });
    }
    snapshot = transition(snapshot, {
      type: "ADD_OBSERVATION",
      note: "No active entry point remained after inspection.",
    });
    snapshot = transition(snapshot, {
      type: "REVIEW_RISK",
      unresolved: false,
    });

    expect(() =>
      transition(snapshot, { type: "COMPLETE_JOB" }),
    ).toThrow("Required evidence is missing");
  });

  it("completes a clear-risk job without manufacturing a follow-up", () => {
    let snapshot = fieldProofReady(false);
    snapshot = transition(snapshot, { type: "COMPLETE_JOB" });

    expect(snapshot.completed).toBe(true);
    expect(snapshot.technicianAssessment).toBe("CLEAR");
    expect(snapshot.outcome).toBe("PENDING_VERIFICATION");
    expect(snapshot.followUpCreated).toBe(false);
    expect(snapshot.proofGenerated).toBe(true);
    expect(snapshot.riskScore).toBe(32);
  });

  it("creates a partial outcome and follow-up for an unresolved risk", () => {
    let snapshot = fieldProofReady(true);
    snapshot = transition(snapshot, { type: "COMPLETE_JOB" });

    expect(snapshot.technicianAssessment).toBe("OPEN_RISK");
    expect(snapshot.outcome).toBe("PENDING_VERIFICATION");
    expect(snapshot.followUpCreated).toBe(true);
    expect(snapshot.riskScore).toBe(47);

    snapshot = transition(snapshot, { type: "SEND_PROOF" });
    expect(snapshot.proofDeliveryStatus).toBe("QUEUED");
    expect(snapshot.proofSent).toBe(false);
  });

  it("keeps final economics cumulative across multiple linked reservices", () => {
    let snapshot = transition(fieldProofReady(false), {
      type: "COMPLETE_JOB",
    });
    snapshot = applyWorkflowCommand(snapshot, {
      type: "RECORD_RESERVICE",
      commandId: "command-reservice-0001",
      expectedVersion: snapshot.version,
      reserviceJobId: "JOB-RESERVICE-1",
      reason: "Customer reported continued activity.",
      directCostCents: 1_200,
    });
    snapshot = applyWorkflowCommand(snapshot, {
      type: "RECORD_RESERVICE",
      commandId: "command-reservice-0002",
      expectedVersion: snapshot.version,
      reserviceJobId: "JOB-RESERVICE-2",
      reason: "A second treatment visit was required.",
      directCostCents: 800,
    });

    expect(snapshot.actualReserviceCostCents).toBe(2_000);
    expect(snapshot.finalEconomics?.actualReserviceCostCents).toBe(2_000);
  });

  it("rejects a job linked as its own reservice", () => {
    const snapshot = transition(fieldProofReady(false), {
      type: "COMPLETE_JOB",
    });

    expect(() =>
      applyWorkflowCommand(snapshot, {
        type: "RECORD_RESERVICE",
        commandId: "command-reservice-self",
        expectedVersion: snapshot.version,
        reserviceJobId: snapshot.jobId,
        reason: "Invalid self-reference.",
        directCostCents: 1_200,
      }),
    ).toThrow("cannot be linked as its own reservice");
  });

  it("never lets a customer-confirmation label bypass actor separation", () => {
    const ready = fieldProofReady(false);
    const completed = applyWorkflowCommand(
      ready,
      {
        type: "COMPLETE_JOB",
        commandId: "command-complete-same-actor",
        expectedVersion: ready.version,
        actualDriveMinutes: 11,
        actualMaterialCostCents: 800,
        technicianNote: "Inspection documentation completed.",
      },
      "2026-07-24T12:00:00.000Z",
      { actorId: "USER-SAME-ACTOR" },
    );

    expect(() =>
      applyWorkflowCommand(
        completed,
        {
          type: "VERIFY_OUTCOME",
          commandId: "command-verify-same-actor",
          expectedVersion: completed.version,
          result: "RESOLVED",
          source: "CUSTOMER_CONFIRMATION",
          note: "The actor claims the customer confirmed resolution.",
        },
        "2026-07-31T12:00:00.000Z",
        {
          verifierId: "USER-SAME-ACTOR",
          verifiedAt: "2026-07-31T12:00:00.000Z",
        },
      ),
    ).toThrow("must be independent");
  });

  it("uses optimistic versions and resets state without rewinding version", () => {
    const snapshot = transition(initial(), { type: "RUN_TRIAGE" });
    expect(() =>
      applyWorkflowCommand(snapshot, {
        type: "APPROVE_TRIAGE",
        commandId: "command-stale-0001",
        expectedVersion: 1,
      }),
    ).toThrow("current version is 2");

    const reset = applyWorkflowCommand(snapshot, {
      type: "RESET_DEMO",
      commandId: "command-reset-0001",
      expectedVersion: snapshot.version,
    });
    expect(reset.version).toBe(3);
    expect(reset.triageStatus).toBe("NEW");
    expect(reset.lastCommandId).toBe("command-reset-0001");
  });

  it("rejects client-supplied tenant and actor fields", () => {
    const result = WorkflowCommandSchema.safeParse({
      type: "RUN_TRIAGE",
      commandId: "command-triage-0001",
      expectedVersion: 1,
      organizationId: "ORG-ATTACKER",
      actor: "SYSTEM",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a stored projection whose evidence count is inconsistent", () => {
    const result = WorkflowSnapshotSchema.safeParse({
      ...initial(),
      evidenceCount: 1,
    });
    expect(result.success).toBe(false);
  });

  it("does not invent an exception before an unresolved completion", () => {
    expect(() =>
      applyWorkflowCommand(initial(), {
        type: "RESOLVE_EXCEPTION",
        ownerUserId: "USER-OWNER",
        resolutionNote: "No exception can be resolved before completion.",
        commandId: "command-exception-0001",
        expectedVersion: 1,
      }),
    ).toThrow("No unresolved-risk follow-up exception exists");
  });
});

describe("request identity boundary", () => {
  it("allows the localhost demo identity only on a loopback URL", () => {
    const local = getRequestIdentity(
      new Request("http://localhost:3000/api/v1/workflow"),
    );
    expect(local?.email).toBe("owner@northstar.demo");
    expect(local?.isLocalDemo).toBe(true);

    const remote = getRequestIdentity(
      new Request("https://fieldproof.example/api/v1/workflow", {
        headers: { host: "localhost:3000" },
      }),
    );
    expect(remote).toBeNull();
  });

  it("derives the tenant and actor from platform authentication headers", () => {
    const context = getRequestIdentity(
      new Request("https://fieldproof.example/api/v1/workflow", {
        headers: {
          "oai-authenticated-user-email": "Owner@Northstar.Example",
          "oai-authenticated-user-full-name": "Avery%20Owner",
          "oai-authenticated-user-full-name-encoding":
            "percent-encoded-utf-8",
        },
      }),
    );

    expect(context).toMatchObject({
      email: "owner@northstar.example",
      displayName: "Avery Owner",
      isLocalDemo: false,
    });
  });

  it("rejects cross-site mutation metadata", () => {
    expect(
      isCrossSiteMutation(
        new Request("https://fieldproof.example/api/v1/workflow", {
          headers: { origin: "https://attacker.example" },
        }),
      ),
    ).toBe(true);
    expect(
      isCrossSiteMutation(
        new Request("https://fieldproof.example/api/v1/workflow", {
          headers: { "sec-fetch-site": "cross-site" },
        }),
      ),
    ).toBe(true);
    expect(
      isCrossSiteMutation(
        new Request("https://fieldproof.example/api/v1/workflow", {
          headers: { origin: "https://fieldproof.example" },
        }),
      ),
    ).toBe(false);
  });
});

describe("evidence byte validation", () => {
  it.each([
    [new Uint8Array([0xff, 0xd8, 0xff, 0xdb]), "image/jpeg", "jpg"],
    [
      new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      "image/png",
      "png",
    ],
    [
      new Uint8Array([
        0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50,
      ]),
      "image/webp",
      "webp",
    ],
  ] as const)("detects %s by magic bytes", (bytes, contentType, extension) => {
    expect(detectEvidenceContentType(bytes)).toBe(contentType);
    expect(evidenceExtension(contentType)).toBe(extension);
  });

  it("rejects a file whose bytes are not a supported image", () => {
    expect(
      detectEvidenceContentType(
        new TextEncoder().encode("<script>alert(1)</script>"),
      ),
    ).toBeNull();
  });
});

function initial() {
  return createInitialWorkflowSnapshot("2026-07-24T12:00:00.000Z");
}

function checkedIn() {
  let snapshot = initial();
  snapshot = transition(snapshot, { type: "RUN_TRIAGE" });
  snapshot = transition(snapshot, { type: "APPROVE_TRIAGE" });
  snapshot = transition(snapshot, {
    type: "APPROVE_SCHEDULE",
    candidateId: "SC-2401",
  });
  return transition(snapshot, { type: "CHECK_IN" });
}

function fieldProofReady(unresolved: boolean) {
  let snapshot = checkedIn();
  for (let index = 0; index < 4; index += 1) {
    snapshot = transition(snapshot, {
      type: "SET_CHECKLIST_STEP",
      index,
      complete: true,
    });
  }
  snapshot = transition(snapshot, {
    type: "ADD_OBSERVATION",
    note: unresolved
      ? "North sill-plate entry point requires follow-up."
      : "No unresolved entry point remains.",
  });
  snapshot = transition(snapshot, {
    type: "REVIEW_RISK",
    unresolved,
  });
  snapshot = addEvidence(snapshot, 1);
  snapshot = addEvidence(snapshot, 2);
  return snapshot;
}

function addEvidence(snapshot: WorkflowSnapshot, sequence: number) {
  const record: EvidenceRecord = {
    id: `EV-00000000-0000-4000-8000-00000000000${sequence}`,
    kind: "FIELD_PHOTO",
    phase: sequence === 1 ? "BEFORE" : "DURING",
    subject: sequence === 1 ? "AREA_OVERVIEW" : "ENTRY_POINT",
    caption:
      sequence === 1
        ? "Basement work-area overview before inspection."
        : "Documented and sealed utility entry point.",
    contentType: "image/jpeg",
    sha256: `${sequence}`.repeat(64),
    capturedAt: 1_721_822_400_000 + sequence,
    zoneId: "ZONE-BASEMENT",
  };
  return appendEvidenceRecord(
    snapshot,
    record,
    `evidence-command-000${sequence}`,
    "2026-07-24T12:00:00.000Z",
  );
}

function transition(
  snapshot: WorkflowSnapshot,
  input:
    | { type: "RUN_TRIAGE" }
    | { type: "APPROVE_TRIAGE" }
    | { type: "APPROVE_SCHEDULE"; candidateId: "SC-2401" | "SC-2402" }
    | { type: "CHECK_IN" }
    | { type: "SET_CHECKLIST_STEP"; index: number; complete: boolean }
    | { type: "ADD_OBSERVATION"; note: string }
    | { type: "REVIEW_RISK"; unresolved: boolean }
    | { type: "COMPLETE_JOB" }
    | { type: "SEND_PROOF" },
) {
  const command = {
    ...input,
    commandId: `command-${input.type.toLowerCase()}-${snapshot.version}`,
    expectedVersion: snapshot.version,
  } as WorkflowCommand;
  return applyWorkflowCommand(
    snapshot,
    command,
    "2026-07-24T12:00:00.000Z",
    input.type === "RUN_TRIAGE"
      ? { triageProposal: TRIAGE_PROPOSAL }
      : {},
  );
}

const TRIAGE_PROPOSAL = {
  issueCategory: "RODENT",
  serviceType: "Rodent Entry-Point Inspection",
  affectedZones: ["Basement"],
  urgency: "ROUTINE",
  safetyFlags: [],
  confidence: 0.94,
  serviceable: true,
  ambiguity: [],
  sourceFacts: [
    "Customer reported scratching near the basement utility panel.",
  ],
} satisfies TriageResult;
