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
  it("shows recurrence-risk contributions", () => {
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
    expect(result.contributions.map((item) => item.key)).toContain("openRisks");
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

  it("rejects unknown and expired action types", () => {
    expect(evaluateActionPolicy({
      actionType: "ISSUE_REFUND",
      autonomyLevel: "AUTO_LOW_RISK",
      confidence: 0.99,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      tenantMatch: true,
    }).allowed).toBe(false);
    expect(evaluateActionPolicy({
      actionType: "PROPOSE_APPOINTMENT",
      autonomyLevel: "SUGGEST_ONLY",
      confidence: 0.99,
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
      tenantMatch: true,
    }).allowed).toBe(false);
  });
});
