import { describe, expect, it } from "vitest";
import {
  OutcomeCommandSchema,
  OutcomeSnapshotSchema,
  OutcomeTransitionError,
  applyOutcomeCommand,
  createPendingOutcome,
} from "../packages/domain/outcomes";

const completion = {
  organizationId: "ORG-A",
  jobId: "JOB-100",
  completedAt: "2026-07-24T15:00:00.000Z",
  completedByUserId: "USER-TECH-1",
  initialRiskReview: "CLEAR",
} as const;

function pending() {
  return createPendingOutcome(completion);
}

describe("completion outcome boundary", () => {
  it("always yields pending verification, even after a clear field review", () => {
    expect(pending()).toEqual({
      organizationId: "ORG-A",
      jobId: "JOB-100",
      version: 1,
      lastCommandId: null,
      status: "PENDING_VERIFICATION",
      completedAt: "2026-07-24T15:00:00.000Z",
      completedByUserId: "USER-TECH-1",
      initialRiskReview: "CLEAR",
      verifiedAt: null,
      verifiedByUserId: null,
      verificationSource: null,
      verificationNote: null,
      reserviceLinks: [],
      actualReserviceCostCents: 0,
      updatedAt: "2026-07-24T15:00:00.000Z",
    });
  });

  it("does not turn an unresolved same-visit review into a verified outcome", () => {
    expect(
      createPendingOutcome({
        ...completion,
        initialRiskReview: "UNRESOLVED",
      }),
    ).toMatchObject({
      status: "PENDING_VERIFICATION",
      initialRiskReview: "UNRESOLVED",
      verifiedAt: null,
    });
  });

  it("rejects extra fields that could manufacture completion authority", () => {
    expect(() =>
      createPendingOutcome({
        ...completion,
        status: "RESOLVED",
      }),
    ).toThrow();
  });
});

describe("independent outcome verification", () => {
  const verification = {
    type: "VERIFY_OUTCOME",
    commandId: "verify-command-0001",
    expectedVersion: 1,
    result: "RESOLVED",
    source: "CUSTOMER_CONFIRMATION",
    verifiedAt: "2026-07-31T15:00:00.000Z",
    verifiedByUserId: "USER-MANAGER-1",
    note: "Customer reports no further activity after seven days.",
  } as const;

  it("allows an independent actor to verify resolution after completion", () => {
    expect(applyOutcomeCommand(pending(), verification)).toMatchObject({
      version: 2,
      lastCommandId: "verify-command-0001",
      status: "RESOLVED",
      verifiedAt: "2026-07-31T15:00:00.000Z",
      verifiedByUserId: "USER-MANAGER-1",
      verificationSource: "CUSTOMER_CONFIRMATION",
      verificationNote:
        "Customer reports no further activity after seven days.",
    });
  });

  it("rejects self-verification by the user who completed the job", () => {
    expect(() =>
      applyOutcomeCommand(pending(), {
        ...verification,
        verifiedByUserId: "USER-TECH-1",
      }),
    ).toThrowError(
      expect.objectContaining({
        code: "INDEPENDENT_VERIFICATION_REQUIRED",
      }),
    );
  });

  it("rejects verification at or before completion", () => {
    for (const verifiedAt of [
      "2026-07-24T15:00:00.000Z",
      "2026-07-24T14:59:59.999Z",
    ]) {
      expect(() =>
        applyOutcomeCommand(pending(), { ...verification, verifiedAt }),
      ).toThrowError(
        expect.objectContaining({ code: "INVALID_VERIFICATION_TIME" }),
      );
    }
  });

  it.each([
    "PARTIALLY_RESOLVED",
    "UNRESOLVED",
    "CUSTOMER_UNREACHABLE",
  ] as const)("records explicit independent result %s", (result) => {
    expect(
      applyOutcomeCommand(pending(), { ...verification, result }),
    ).toMatchObject({ status: result });
  });

  it("does not allow a verified terminal result to be overwritten", () => {
    const resolved = applyOutcomeCommand(pending(), verification);
    expect(() =>
      applyOutcomeCommand(resolved, {
        ...verification,
        commandId: "verify-command-0002",
        expectedVersion: 2,
        result: "UNRESOLVED",
      }),
    ).toThrowError(
      expect.objectContaining({ code: "INVALID_TRANSITION" }),
    );
  });

  it("enforces optimistic outcome versions", () => {
    expect(() =>
      applyOutcomeCommand(pending(), {
        ...verification,
        expectedVersion: 99,
      }),
    ).toThrowError(expect.objectContaining({ code: "VERSION_CONFLICT" }));
  });

  it("rejects unknown results, commands, and extra payload fields", () => {
    expect(
      OutcomeCommandSchema.safeParse({
        ...verification,
        result: "ASSUMED_RESOLVED",
      }).success,
    ).toBe(false);
    expect(
      OutcomeCommandSchema.safeParse({
        ...verification,
        automatic: true,
      }).success,
    ).toBe(false);
    expect(
      OutcomeCommandSchema.safeParse({
        type: "AUTO_RESOLVE",
        commandId: "automatic-command",
        expectedVersion: 1,
      }).success,
    ).toBe(false);
  });
});

describe("reservice linkage and cost finalization", () => {
  function linkReservice(
    current = pending(),
    jobId = "JOB-RESERVICE-1",
    commandId = "link-command-0001",
  ) {
    return applyOutcomeCommand(current, {
      type: "LINK_RESERVICE",
      commandId,
      expectedVersion: current.version,
      reserviceJobId: jobId,
      linkedAt: "2026-07-26T15:00:00.000Z",
    });
  }

  it("links a distinct later job and marks the original as reservice required", () => {
    expect(linkReservice()).toMatchObject({
      version: 2,
      status: "RESERVICE_REQUIRED",
      actualReserviceCostCents: 0,
      reserviceLinks: [
        {
          jobId: "JOB-RESERVICE-1",
          linkedAt: "2026-07-26T15:00:00.000Z",
          costStatus: "PENDING",
          directCostCents: null,
          finalizedAt: null,
        },
      ],
    });
  });

  it("rejects self-links, duplicate links, and pre-completion links", () => {
    expect(() =>
      applyOutcomeCommand(pending(), {
        type: "LINK_RESERVICE",
        commandId: "link-command-self",
        expectedVersion: 1,
        reserviceJobId: "JOB-100",
        linkedAt: "2026-07-26T15:00:00.000Z",
      }),
    ).toThrowError(expect.objectContaining({ code: "INVALID_TRANSITION" }));

    const linked = linkReservice();
    expect(() =>
      applyOutcomeCommand(linked, {
        type: "LINK_RESERVICE",
        commandId: "link-command-0002",
        expectedVersion: 2,
        reserviceJobId: "JOB-RESERVICE-1",
        linkedAt: "2026-07-27T15:00:00.000Z",
      }),
    ).toThrowError(
      expect.objectContaining({ code: "RESERVICE_ALREADY_LINKED" }),
    );

    expect(() =>
      applyOutcomeCommand(pending(), {
        type: "LINK_RESERVICE",
        commandId: "link-command-early",
        expectedVersion: 1,
        reserviceJobId: "JOB-RESERVICE-2",
        linkedAt: "2026-07-24T14:00:00.000Z",
      }),
    ).toThrowError(expect.objectContaining({ code: "INVALID_TRANSITION" }));
  });

  it("requires a link before finalizing direct reservice cost", () => {
    expect(() =>
      applyOutcomeCommand(pending(), {
        type: "FINALIZE_RESERVICE_COST",
        commandId: "cost-command-0001",
        expectedVersion: 1,
        reserviceJobId: "JOB-RESERVICE-1",
        directCostCents: 3_301,
        finalizedAt: "2026-07-27T15:00:00.000Z",
      }),
    ).toThrowError(expect.objectContaining({ code: "RESERVICE_NOT_LINKED" }));
  });

  it("finalizes a linked reservice cost exactly once", () => {
    const linked = linkReservice();
    const finalized = applyOutcomeCommand(linked, {
      type: "FINALIZE_RESERVICE_COST",
      commandId: "cost-command-0001",
      expectedVersion: 2,
      reserviceJobId: "JOB-RESERVICE-1",
      directCostCents: 3_301,
      finalizedAt: "2026-07-27T15:00:00.000Z",
    });
    expect(finalized).toMatchObject({
      version: 3,
      status: "RESERVICE_REQUIRED",
      actualReserviceCostCents: 3_301,
      reserviceLinks: [
        {
          jobId: "JOB-RESERVICE-1",
          costStatus: "FINALIZED",
          directCostCents: 3_301,
          finalizedAt: "2026-07-27T15:00:00.000Z",
        },
      ],
    });
    expect(() =>
      applyOutcomeCommand(finalized, {
        type: "FINALIZE_RESERVICE_COST",
        commandId: "cost-command-0002",
        expectedVersion: 3,
        reserviceJobId: "JOB-RESERVICE-1",
        directCostCents: 3_301,
        finalizedAt: "2026-07-28T15:00:00.000Z",
      }),
    ).toThrowError(
      expect.objectContaining({ code: "RESERVICE_COST_ALREADY_FINALIZED" }),
    );
  });

  it("keeps total actual reservice cost equal to finalized links", () => {
    const first = applyOutcomeCommand(linkReservice(), {
      type: "FINALIZE_RESERVICE_COST",
      commandId: "cost-command-0001",
      expectedVersion: 2,
      reserviceJobId: "JOB-RESERVICE-1",
      directCostCents: 3_301,
      finalizedAt: "2026-07-27T15:00:00.000Z",
    });
    const secondLink = applyOutcomeCommand(first, {
      type: "LINK_RESERVICE",
      commandId: "link-command-0002",
      expectedVersion: 3,
      reserviceJobId: "JOB-RESERVICE-2",
      linkedAt: "2026-07-28T15:00:00.000Z",
    });
    const secondFinal = applyOutcomeCommand(secondLink, {
      type: "FINALIZE_RESERVICE_COST",
      commandId: "cost-command-0002",
      expectedVersion: 4,
      reserviceJobId: "JOB-RESERVICE-2",
      directCostCents: 2_250,
      finalizedAt: "2026-07-29T15:00:00.000Z",
    });
    expect(secondFinal.actualReserviceCostCents).toBe(5_551);
    expect(
      OutcomeSnapshotSchema.safeParse({
        ...secondFinal,
        actualReserviceCostCents: 1,
      }).success,
    ).toBe(false);
  });

  it("allows a later reservice signal to supersede an earlier verified resolution", () => {
    const resolved = applyOutcomeCommand(pending(), {
      type: "VERIFY_OUTCOME",
      commandId: "verify-command-0001",
      expectedVersion: 1,
      result: "RESOLVED",
      source: "CUSTOMER_CONFIRMATION",
      verifiedAt: "2026-07-31T15:00:00.000Z",
      verifiedByUserId: "USER-MANAGER-1",
      note: "Customer initially reported no additional activity.",
    });
    const linked = applyOutcomeCommand(resolved, {
      type: "LINK_RESERVICE",
      commandId: "link-command-later",
      expectedVersion: 2,
      reserviceJobId: "JOB-RESERVICE-LATE",
      linkedAt: "2026-08-07T15:00:00.000Z",
    });
    expect(linked).toMatchObject({
      status: "RESERVICE_REQUIRED",
      verifiedByUserId: "USER-MANAGER-1",
      reserviceLinks: [{ jobId: "JOB-RESERVICE-LATE" }],
    });
  });
});

describe("outcome snapshot integrity", () => {
  it("rejects terminal status without complete independent-verification fields", () => {
    expect(
      OutcomeSnapshotSchema.safeParse({
        ...pending(),
        status: "RESOLVED",
      }).success,
    ).toBe(false);
  });

  it("rejects partial verification metadata", () => {
    expect(
      OutcomeSnapshotSchema.safeParse({
        ...pending(),
        verifiedAt: "2026-07-31T15:00:00.000Z",
      }).success,
    ).toBe(false);
  });

  it("rejects persisted self-verification even when every field is present", () => {
    expect(
      OutcomeSnapshotSchema.safeParse({
        ...pending(),
        status: "RESOLVED",
        verifiedAt: "2026-07-31T15:00:00.000Z",
        verifiedByUserId: "USER-TECH-1",
        verificationSource: "INTERNAL_REVIEW",
        verificationNote: "The completion actor tried to verify the same work.",
        updatedAt: "2026-07-31T15:00:00.000Z",
      }).success,
    ).toBe(false);
  });

  it("rejects reservice-required status without an actual linked job", () => {
    expect(
      OutcomeSnapshotSchema.safeParse({
        ...pending(),
        status: "RESERVICE_REQUIRED",
      }).success,
    ).toBe(false);
  });

  it("uses a typed transition error", () => {
    expect(
      new OutcomeTransitionError("INVALID_TRANSITION", "Invalid"),
    ).toMatchObject({
      name: "OutcomeTransitionError",
      code: "INVALID_TRANSITION",
      message: "Invalid",
    });
  });
});
