import { z } from "zod";

export const AutonomyLevelSchema = z.enum([
  "SUGGEST_ONLY",
  "AUTO_READ_ONLY",
  "AUTO_LOW_RISK",
  "AUTO_APPROVED_BOOKING",
  "HUMAN_REQUIRED",
]);

export const TriageResultSchema = z.object({
  issueCategory: z.enum(["RODENT", "GENERAL_PEST", "STINGING_INSECT", "UNSUPPORTED"]),
  serviceType: z.string(),
  affectedZones: z.array(z.string()),
  urgency: z.enum(["ROUTINE", "PRIORITY", "URGENT"]),
  safetyFlags: z.array(z.string()),
  confidence: z.number().min(0).max(1),
  serviceable: z.boolean(),
  ambiguity: z.array(z.string()),
  sourceFacts: z.array(z.string()),
});

export type TriageResult = z.infer<typeof TriageResultSchema>;

export type MarginInputs = {
  price: number;
  laborMinutes: number;
  laborCostPerHour: number;
  driveMinutes: number;
  driveCostPerMinute: number;
  materialEstimate: number;
  reserviceProbability: number;
  averageReserviceCost: number;
};

export type MarginBreakdown = MarginInputs & {
  laborCost: number;
  driveCost: number;
  expectedReserviceCost: number;
  expectedContributionMargin: number;
};

export function calculateMargin(input: MarginInputs): MarginBreakdown {
  const laborCost = round((input.laborMinutes / 60) * input.laborCostPerHour);
  const driveCost = round(input.driveMinutes * input.driveCostPerMinute);
  const expectedReserviceCost = round(input.reserviceProbability * input.averageReserviceCost);
  return {
    ...input,
    laborCost,
    driveCost,
    expectedReserviceCost,
    expectedContributionMargin: round(
      input.price - laborCost - driveCost - input.materialEstimate - expectedReserviceCost,
    ),
  };
}

export type CandidateInput = {
  id: string;
  technician: string;
  technicianId: string;
  startsAt: string;
  eligible: boolean;
  eligibilityReasons: string[];
  margin: MarginInputs;
  routeDensityBonus: number;
  urgencyBonus: number;
  retentionValue: number;
  overtimePenalty: number;
  latenessPenalty: number;
  fragmentationPenalty: number;
  driveMinutes: number;
};

export type RankedCandidate = CandidateInput & {
  rank: number;
  score: number;
  economics: MarginBreakdown;
  explanation: { label: string; value: number; kind: "positive" | "negative" | "neutral" }[];
};

export function rankScheduleCandidates(candidates: CandidateInput[]): RankedCandidate[] {
  return candidates
    .filter((candidate) => candidate.eligible)
    .map((candidate) => {
      const economics = calculateMargin(candidate.margin);
      const explanation: RankedCandidate["explanation"] = [
        { label: "Expected contribution", value: economics.expectedContributionMargin, kind: "neutral" },
        { label: "Route density", value: candidate.routeDensityBonus, kind: "positive" },
        { label: "Urgency", value: candidate.urgencyBonus, kind: "positive" },
        { label: "Retention value", value: candidate.retentionValue, kind: "positive" },
        { label: "Overtime", value: -candidate.overtimePenalty, kind: "negative" },
        { label: "Lateness", value: -candidate.latenessPenalty, kind: "negative" },
        { label: "Fragmentation", value: -candidate.fragmentationPenalty, kind: "negative" },
      ];
      return {
        ...candidate,
        rank: 0,
        economics,
        explanation,
        score: round(explanation.reduce((total, part) => total + part.value, 0)),
      };
    })
    .sort((a, b) => b.score - a.score)
    .map((candidate, index) => ({ ...candidate, rank: index + 1 }));
}

export type RiskInputs = {
  relatedIssues: number;
  reserviceEvents90Days: number;
  openRisks: number;
  missingEvidence: boolean;
  incompleteSteps: boolean;
  priorUnresolvedOutcome: boolean;
  followUpOverdue: boolean;
  uncertaintyFlag: boolean;
};

export function calculateRecurrenceRisk(input: RiskInputs) {
  const contributions = [
    { key: "baseline", label: "Rodent inspection baseline", points: 18 },
    { key: "relatedIssues", label: "Prior related issues", points: Math.min(input.relatedIssues * 7, 21) },
    { key: "reservice", label: "Recent reservice events", points: Math.min(input.reserviceEvents90Days * 12, 24) },
    { key: "openRisks", label: "Open property risks", points: Math.min(input.openRisks * 14, 28) },
    { key: "missingEvidence", label: "Missing evidence", points: input.missingEvidence ? 12 : 0 },
    { key: "incompleteSteps", label: "Incomplete playbook", points: input.incompleteSteps ? 15 : 0 },
    { key: "priorUnresolved", label: "Prior unresolved outcome", points: input.priorUnresolvedOutcome ? 12 : 0 },
    { key: "followUp", label: "Follow-up overdue", points: input.followUpOverdue ? 9 : 0 },
    { key: "uncertainty", label: "Technician uncertainty", points: input.uncertaintyFlag ? 8 : 0 },
  ];
  return {
    score: Math.min(100, contributions.reduce((total, item) => total + item.points, 0)),
    version: "rodent-risk-v1.2",
    contributions: contributions.filter((item) => item.points > 0),
  };
}

export function calculatePropertyCompleteness(fields: Record<string, boolean>) {
  const weights: Record<string, number> = {
    propertyType: 15,
    serviceZones: 15,
    accessInstructions: 10,
    historicalObservations: 20,
    evidence: 20,
    openRiskStatus: 10,
    recurringPlan: 10,
  };
  const missing = Object.keys(weights).filter((key) => !fields[key]);
  return {
    score: Object.entries(weights).reduce((total, [key, weight]) => total + (fields[key] ? weight : 0), 0),
    missing,
  };
}

const allowedActionTypes = new Set([
  "TRIAGE_REQUEST",
  "PROPOSE_APPOINTMENT",
  "APPROVE_APPOINTMENT",
  "CREATE_FOLLOW_UP",
  "GENERATE_REPORT",
]);

export function evaluateActionPolicy(input: {
  actionType: string;
  autonomyLevel: z.infer<typeof AutonomyLevelSchema>;
  confidence: number;
  expiresAt: string;
  tenantMatch: boolean;
}) {
  if (!allowedActionTypes.has(input.actionType)) {
    return { allowed: false, requiresApproval: true, reason: "Unknown action type rejected." };
  }
  if (!input.tenantMatch) {
    return { allowed: false, requiresApproval: true, reason: "Tenant scope mismatch." };
  }
  if (new Date(input.expiresAt).getTime() <= Date.now()) {
    return { allowed: false, requiresApproval: true, reason: "Proposal expired." };
  }
  if (input.confidence < 0.65) {
    return { allowed: false, requiresApproval: true, reason: "Confidence below policy threshold." };
  }
  return {
    allowed: true,
    requiresApproval:
      input.autonomyLevel === "SUGGEST_ONLY" ||
      input.actionType === "APPROVE_APPOINTMENT",
    reason: "Policy fieldproof-ops-v1.3 satisfied.",
  };
}

export const huntleyCandidates = rankScheduleCandidates([
  {
    id: "SC-2401",
    technician: "Maya Chen",
    technicianId: "TECH-04",
    startsAt: "Today · 1:30 PM",
    eligible: true,
    eligibilityReasons: ["Rodent inspection skill", "Huntley territory", "90-minute capacity"],
    margin: { price: 189, laborMinutes: 75, laborCostPerHour: 31, driveMinutes: 11, driveCostPerMinute: 0.72, materialEstimate: 8, reserviceProbability: 0.12, averageReserviceCost: 94 },
    routeDensityBonus: 18,
    urgencyBonus: 10,
    retentionValue: 7,
    overtimePenalty: 0,
    latenessPenalty: 0,
    fragmentationPenalty: 3,
    driveMinutes: 11,
  },
  {
    id: "SC-2402",
    technician: "Andre Silva",
    technicianId: "TECH-07",
    startsAt: "Today · 3:45 PM",
    eligible: true,
    eligibilityReasons: ["Rodent inspection skill", "Huntley territory", "90-minute capacity"],
    margin: { price: 189, laborMinutes: 75, laborCostPerHour: 29, driveMinutes: 24, driveCostPerMinute: 0.72, materialEstimate: 8, reserviceProbability: 0.16, averageReserviceCost: 94 },
    routeDensityBonus: 6,
    urgencyBonus: 10,
    retentionValue: 7,
    overtimePenalty: 0,
    latenessPenalty: 4,
    fragmentationPenalty: 8,
    driveMinutes: 24,
  },
  {
    id: "SC-2403",
    technician: "Eli Brooks",
    technicianId: "TECH-02",
    startsAt: "Tomorrow · 8:00 AM",
    eligible: true,
    eligibilityReasons: ["Rodent inspection skill", "Huntley territory", "90-minute capacity"],
    margin: { price: 189, laborMinutes: 75, laborCostPerHour: 34, driveMinutes: 8, driveCostPerMinute: 0.72, materialEstimate: 8, reserviceProbability: 0.1, averageReserviceCost: 94 },
    routeDensityBonus: 14,
    urgencyBonus: 4,
    retentionValue: 7,
    overtimePenalty: 0,
    latenessPenalty: 0,
    fragmentationPenalty: 1,
    driveMinutes: 8,
  },
]);

function round(value: number) {
  return Math.round(value * 100) / 100;
}
