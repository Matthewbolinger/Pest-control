import { describe, expect, it } from "vitest";
import {
  calculateMargin,
  calculatePropertyCompleteness,
  calculateRecurrenceRisk,
  evaluateActionPolicy,
  huntleyCandidates,
  rankScheduleCandidates,
} from "../packages/domain";

describe("economics", () => {
  it("calculates transparent expected contribution", () => {
    const result = calculateMargin({
      price: 189,
      laborMinutes: 75,
      laborCostPerHour: 31,
      driveMinutes: 11,
      driveCostPerMinute: 0.72,
      materialEstimate: 8,
      reserviceProbability: 0.12,
      averageReserviceCost: 94,
    });
    expect(result.laborCost).toBe(38.75);
    expect(result.driveCost).toBe(7.92);
    expect(result.expectedReserviceCost).toBe(11.28);
    expect(result.expectedContributionMargin).toBe(123.05);
  });

  it("excludes ineligible slots before ranking", () => {
    const blocked = { ...huntleyCandidates[0], id: "BLOCKED", eligible: false };
    const ranked = rankScheduleCandidates([blocked, ...huntleyCandidates]);
    expect(ranked.some((candidate) => candidate.id === "BLOCKED")).toBe(false);
    expect(ranked.map((candidate) => candidate.rank)).toEqual([1, 2, 3]);
  });
});

describe("explainable scores", () => {
  it("starts at 32 without treating incomplete fieldwork as customer risk", () => {
    const result = calculateRecurrenceRisk({
      relatedIssues: 1,
      reserviceEvents90Days: 0,
      openRisks: 0,
      missingEvidence: true,
      incompleteSteps: true,
      priorUnresolvedOutcome: false,
      followUpOverdue: false,
      uncertaintyFlag: false,
    });
    expect(result.score).toBe(32);
    expect(result.contributions.map((item) => item.key)).toEqual([
      "baseline",
      "relatedIssues",
    ]);
    expect(result.dataCompleteness).toMatchObject({
      score: 40,
      status: "LIMITED",
    });
    expect(result.dataCompleteness.gaps.map((item) => item.key)).toEqual([
      "missingEvidence",
      "incompleteSteps",
    ]);
  });

  it("raises confirmed unresolved recurrence risk from 32 to 47 transparently", () => {
    const result = calculateRecurrenceRisk({
      relatedIssues: 1,
      reserviceEvents90Days: 0,
      openRisks: 1,
      missingEvidence: false,
      incompleteSteps: false,
      priorUnresolvedOutcome: false,
      followUpOverdue: false,
      uncertaintyFlag: true,
    });
    expect(result.score).toBe(47);
    expect(result.rawScore).toBe(47);
    expect(result.contributions).toEqual([
      { key: "baseline", label: "Rodent recurrence baseline", points: 25 },
      { key: "relatedIssues", label: "Prior related issues", points: 7 },
      { key: "openRisks", label: "Confirmed open property risks", points: 15 },
    ]);
    expect(result.dataCompleteness).toMatchObject({
      score: 80,
      status: "PARTIAL",
      gaps: [
        {
          key: "uncertainty",
          label: "Technician marked the assessment uncertain",
          penalty: 20,
        },
      ],
    });
  });

  it("validates recurrence inputs and exposes the raw score when capped", () => {
    const result = calculateRecurrenceRisk({
      relatedIssues: 20,
      reserviceEvents90Days: 20,
      openRisks: 20,
      missingEvidence: false,
      incompleteSteps: false,
      priorUnresolvedOutcome: true,
      followUpOverdue: true,
      uncertaintyFlag: false,
    });
    expect(result.score).toBe(100);
    expect(result.rawScore).toBe(121);
    expect(result.dataCompleteness).toMatchObject({ score: 100, status: "COMPLETE" });

    expect(() => calculateRecurrenceRisk({
      relatedIssues: -1,
      reserviceEvents90Days: 0,
      openRisks: 0,
      missingEvidence: false,
      incompleteSteps: false,
      priorUnresolvedOutcome: false,
      followUpOverdue: false,
      uncertaintyFlag: false,
    })).toThrow();
  });

  it("distinguishes missing data from customer risk", () => {
    const result = calculatePropertyCompleteness({
      propertyType: true,
      serviceZones: true,
      accessInstructions: false,
      historicalObservations: true,
      evidence: false,
      openRiskStatus: true,
      recurringPlan: true,
    });
    expect(result.score).toBe(70);
    expect(result.missing).toEqual(["accessInstructions", "evidence"]);
  });
});

describe("policy", () => {
  const evaluatedAt = "2026-07-24T12:00:00.000Z";
  const baseInput = {
    autonomyLevel: "AUTO_LOW_RISK" as const,
    confidence: 0.95,
    expiresAt: "2026-07-24T13:00:00.000Z",
    tenantMatch: true,
    evaluatedAt,
  };
  const validApproval = {
    id: "APR-2048",
    actionType: "CREATE_FOLLOW_UP",
    actorId: "USER-7",
    tenantMatch: true,
    grantedAt: "2026-07-24T11:59:00.000Z",
    expiresAt: "2026-07-24T12:30:00.000Z",
  };

  it("rejects cross-tenant proposals", () => {
    const result = evaluateActionPolicy({
      actionType: "PROPOSE_APPOINTMENT",
      autonomyLevel: "SUGGEST_ONLY",
      confidence: 0.95,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      tenantMatch: false,
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/Tenant/);
  });

  it("defaults to deny for unknown actions, autonomy levels, and timestamps", () => {
    expect(evaluateActionPolicy({
      ...baseInput,
      actionType: "ISSUE_REFUND",
    })).toMatchObject({
      allowed: false,
      code: "UNKNOWN_ACTION",
      requiresApproval: false,
    });
    expect(evaluateActionPolicy({
      ...baseInput,
      actionType: "PROPOSE_APPOINTMENT",
      autonomyLevel: "ROOT_OVERRIDE" as never,
    })).toMatchObject({ allowed: false, code: "INVALID_AUTONOMY" });
    expect(evaluateActionPolicy({
      ...baseInput,
      actionType: "PROPOSE_APPOINTMENT",
      expiresAt: "not-a-date",
    })).toMatchObject({ allowed: false, code: "INVALID_TIME" });
    expect(evaluateActionPolicy({
      ...baseInput,
      actionType: "PROPOSE_APPOINTMENT",
      expiresAt: evaluatedAt,
    })).toMatchObject({ allowed: false, code: "EXPIRED" });
  });

  it("rejects invalid confidence instead of relying on TypeScript callers", () => {
    for (const confidence of [Number.NaN, Number.POSITIVE_INFINITY, -0.01, 1.01]) {
      expect(evaluateActionPolicy({
        ...baseInput,
        actionType: "TRIAGE_REQUEST",
        confidence,
      })).toMatchObject({
        allowed: false,
        code: "INVALID_CONFIDENCE",
        requiresApproval: false,
      });
    }
    expect(evaluateActionPolicy({
      ...baseInput,
      actionType: "TRIAGE_REQUEST",
      confidence: 0.64,
    })).toMatchObject({ allowed: false, code: "LOW_CONFIDENCE" });
  });

  it("allows qualifying read-only work without manufacturing an approval", () => {
    expect(evaluateActionPolicy({
      ...baseInput,
      actionType: "TRIAGE_REQUEST",
      confidence: 0.65,
    })).toMatchObject({
      allowed: true,
      approvalRequired: false,
      effect: "READ_ONLY",
      policyVersion: "fieldproof-ops-v2.0",
    });
  });

  it("never lets write actions bypass a scoped human approval", () => {
    for (const actionType of [
      "APPROVE_APPOINTMENT",
      "CREATE_FOLLOW_UP",
      "GENERATE_REPORT",
    ]) {
      expect(evaluateActionPolicy({
        ...baseInput,
        actionType,
        autonomyLevel: "AUTO_APPROVED_BOOKING",
      })).toMatchObject({
        allowed: false,
        code: "APPROVAL_REQUIRED",
        effect: "WRITE",
      });
    }
  });

  it("accepts a current, tenant-matched approval scoped to the exact write", () => {
    expect(evaluateActionPolicy({
      ...baseInput,
      actionType: "CREATE_FOLLOW_UP",
      approval: validApproval,
    })).toMatchObject({
      allowed: true,
      requiresApproval: false,
      approvalRequired: true,
      effect: "WRITE",
    });
  });

  it("rejects approvals that are stale, future-dated, cross-tenant, or for another action", () => {
    const invalidApprovals = [
      { ...validApproval, expiresAt: evaluatedAt },
      { ...validApproval, grantedAt: "2026-07-24T12:01:00.000Z" },
      { ...validApproval, tenantMatch: false },
      { ...validApproval, actionType: "GENERATE_REPORT" },
    ];
    for (const approval of invalidApprovals) {
      expect(evaluateActionPolicy({
        ...baseInput,
        actionType: "CREATE_FOLLOW_UP",
        approval,
      })).toMatchObject({ allowed: false, code: "INVALID_APPROVAL" });
    }
  });

  it("requires a human approval for every HUMAN_REQUIRED action", () => {
    expect(evaluateActionPolicy({
      ...baseInput,
      actionType: "TRIAGE_REQUEST",
      autonomyLevel: "HUMAN_REQUIRED",
    })).toMatchObject({ allowed: false, code: "APPROVAL_REQUIRED" });
    expect(evaluateActionPolicy({
      ...baseInput,
      actionType: "TRIAGE_REQUEST",
      autonomyLevel: "HUMAN_REQUIRED",
      approval: { ...validApproval, actionType: "TRIAGE_REQUEST" },
    })).toMatchObject({ allowed: true, approvalRequired: true });
  });
});
