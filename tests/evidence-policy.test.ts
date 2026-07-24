import { describe, expect, it } from "vitest";
import {
  EvidencePolicyError,
  EvidencePolicySchema,
  TypedEvidenceSchema,
  evaluateEvidencePolicy,
  evidenceMatchesRequirement,
  requireEvidencePolicy,
} from "../packages/domain/evidence-policy";

const policy = {
  policyVersion: "rodent-inspection-v1",
  requirements: [
    {
      id: "REQ-OVERVIEW",
      label: "Basement overview before inspection",
      phase: "BEFORE",
      subject: "AREA_OVERVIEW",
      zoneId: "ZONE-BASEMENT",
      minimumCount: 1,
    },
    {
      id: "REQ-ENTRY",
      label: "Potential entry-point detail",
      phase: "DURING",
      subject: "ENTRY_POINT",
      zoneId: "ZONE-BASEMENT",
      minimumCount: 2,
    },
  ],
} as const;

const evidence = [
  {
    id: "EV-OVERVIEW",
    phase: "BEFORE",
    subject: "AREA_OVERVIEW",
    zoneId: "ZONE-BASEMENT",
    capturedAt: "2026-07-24T15:00:00.000Z",
  },
  {
    id: "EV-ENTRY-1",
    phase: "DURING",
    subject: "ENTRY_POINT",
    zoneId: "ZONE-BASEMENT",
    capturedAt: "2026-07-24T15:05:00.000Z",
  },
  {
    id: "EV-ENTRY-2",
    phase: "DURING",
    subject: "ENTRY_POINT",
    zoneId: "ZONE-BASEMENT",
    capturedAt: "2026-07-24T15:06:00.000Z",
  },
] as const;

describe("typed evidence schemas", () => {
  it("accepts explicit phase, subject, zone, and capture time", () => {
    expect(TypedEvidenceSchema.parse(evidence[0])).toEqual(evidence[0]);
  });

  it("rejects unknown semantic values and extra fields", () => {
    expect(
      TypedEvidenceSchema.safeParse({
        ...evidence[0],
        phase: "PRE_VISIT",
      }).success,
    ).toBe(false);
    expect(
      TypedEvidenceSchema.safeParse({
        ...evidence[0],
        displayOrder: 1,
      }).success,
    ).toBe(false);
  });

  it("rejects duplicate requirement identifiers", () => {
    const result = EvidencePolicySchema.safeParse({
      policyVersion: "v1",
      requirements: [
        policy.requirements[0],
        { ...policy.requirements[1], id: "REQ-OVERVIEW" },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("rejects duplicate semantic requirements that could double-count one item", () => {
    expect(
      EvidencePolicySchema.safeParse({
        policyVersion: "v1",
        requirements: [
          policy.requirements[0],
          { ...policy.requirements[0], id: "REQ-OVERVIEW-COPY" },
        ],
      }).success,
    ).toBe(false);
  });
});

describe("evidence requirement matching", () => {
  it("matches phase, subject, and an exact configured zone", () => {
    expect(
      evidenceMatchesRequirement(evidence[0], policy.requirements[0]),
    ).toBe(true);
    expect(
      evidenceMatchesRequirement(
        { ...evidence[0], phase: "AFTER" },
        policy.requirements[0],
      ),
    ).toBe(false);
    expect(
      evidenceMatchesRequirement(
        { ...evidence[0], subject: "PEST_EVIDENCE" },
        policy.requirements[0],
      ),
    ).toBe(false);
    expect(
      evidenceMatchesRequirement(
        { ...evidence[0], zoneId: "ZONE-GARAGE" },
        policy.requirements[0],
      ),
    ).toBe(false);
  });

  it("allows a requirement to apply across every zone explicitly", () => {
    expect(
      evidenceMatchesRequirement(evidence[0], {
        ...policy.requirements[0],
        zoneId: null,
      }),
    ).toBe(true);
  });

  it("satisfies each requirement only when its minimum count is met", () => {
    const result = evaluateEvidencePolicy(policy, evidence);
    expect(result).toEqual({
      policyVersion: "rodent-inspection-v1",
      satisfied: true,
      requirements: [
        {
          requirementId: "REQ-OVERVIEW",
          label: "Basement overview before inspection",
          requiredCount: 1,
          matchedCount: 1,
          matchedEvidenceIds: ["EV-OVERVIEW"],
          satisfied: true,
        },
        {
          requirementId: "REQ-ENTRY",
          label: "Potential entry-point detail",
          requiredCount: 2,
          matchedCount: 2,
          matchedEvidenceIds: ["EV-ENTRY-1", "EV-ENTRY-2"],
          satisfied: true,
        },
      ],
      missingRequirementIds: [],
    });
  });

  it("reports every missing semantic requirement deterministically", () => {
    const result = evaluateEvidencePolicy(policy, [
      evidence[1],
      { ...evidence[2], subject: "PEST_EVIDENCE" },
    ]);
    expect(result.satisfied).toBe(false);
    expect(result.missingRequirementIds).toEqual([
      "REQ-OVERVIEW",
      "REQ-ENTRY",
    ]);
    expect(result.requirements.map((item) => item.matchedCount)).toEqual([0, 1]);
  });

  it("does not infer before/detail semantics from array order", () => {
    const semanticallyWrong = [
      {
        ...evidence[0],
        phase: "AFTER",
        subject: "WORK_PERFORMED",
      },
      {
        ...evidence[1],
        phase: "BEFORE",
        subject: "PEST_EVIDENCE",
      },
      {
        ...evidence[2],
        phase: "BEFORE",
        subject: "PEST_EVIDENCE",
      },
    ];
    expect(evaluateEvidencePolicy(policy, semanticallyWrong)).toMatchObject({
      satisfied: false,
      missingRequirementIds: ["REQ-OVERVIEW", "REQ-ENTRY"],
    });
  });

  it("rejects duplicate evidence identifiers before matching", () => {
    expect(() =>
      evaluateEvidencePolicy(policy, [evidence[0], evidence[0]]),
    ).toThrow(/unique/i);
  });

  it("throws a typed completion error containing the missing requirements", () => {
    expect(() =>
      requireEvidencePolicy(policy, [evidence[0], evidence[1]]),
    ).toThrowError(EvidencePolicyError);
    try {
      requireEvidencePolicy(policy, [evidence[0], evidence[1]]);
    } catch (error) {
      expect(error).toMatchObject({
        code: "EVIDENCE_REQUIREMENTS_NOT_MET",
        result: {
          satisfied: false,
          missingRequirementIds: ["REQ-ENTRY"],
        },
      });
    }
  });
});
