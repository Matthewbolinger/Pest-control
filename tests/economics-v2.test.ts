import { describe, expect, it } from "vitest";
import {
  ActualEconomicsSnapshotSchema,
  ExpectedEconomicsInputSchema,
  calculateActualEconomics,
  calculateEconomicsVariance,
  calculateExpectedEconomics,
  directServiceCostCents,
  finalizeEconomics,
} from "../packages/domain/economics";

const expectedInput = {
  revenueCents: 18_900,
  estimatedLaborMinutes: 75,
  laborCostPerHourCents: 3_100,
  estimatedDriveMinutes: 11,
  driveCostPerMinuteCents: 72,
  materialEstimateCents: 800,
  reserviceProbabilityBasisPoints: 1_200,
  averageReserviceCostCents: 9_400,
} as const;

describe("integer-cent expected economics", () => {
  it("calculates the booking snapshot without floating-point currency", () => {
    expect(calculateExpectedEconomics(expectedInput)).toEqual({
      phase: "EXPECTED_AT_BOOKING",
      revenueCents: 18_900,
      laborMinutes: 75,
      laborCostCents: 3_875,
      driveMinutes: 11,
      driveCostCents: 792,
      materialCostCents: 800,
      expectedReserviceCostCents: 1_128,
      actualReserviceCostCents: 0,
      contributionMarginCents: 12_305,
    });
  });

  it("rounds positive cost ratios deterministically to the nearest cent", () => {
    expect(
      calculateExpectedEconomics({
        revenueCents: 100,
        estimatedLaborMinutes: 1,
        laborCostPerHourCents: 100,
        estimatedDriveMinutes: 0,
        driveCostPerMinuteCents: 0,
        materialEstimateCents: 0,
        reserviceProbabilityBasisPoints: 5_000,
        averageReserviceCostCents: 1,
      }),
    ).toMatchObject({
      laborCostCents: 2,
      expectedReserviceCostCents: 1,
      contributionMarginCents: 97,
    });
  });

  it("allows a negative contribution while retaining integer invariants", () => {
    expect(
      calculateExpectedEconomics({
        ...expectedInput,
        revenueCents: 1_000,
      }).contributionMarginCents,
    ).toBe(-5_595);
  });

  it("rejects fractional, negative, unknown, and extra input", () => {
    expect(
      ExpectedEconomicsInputSchema.safeParse({
        ...expectedInput,
        revenueCents: 18_900.5,
      }).success,
    ).toBe(false);
    expect(
      ExpectedEconomicsInputSchema.safeParse({
        ...expectedInput,
        actualDriveMinutes: 11,
      }).success,
    ).toBe(false);
    expect(
      ExpectedEconomicsInputSchema.safeParse({
        ...expectedInput,
        materialEstimateCents: -1,
      }).success,
    ).toBe(false);
  });
});

describe("actual-at-completion economics", () => {
  const expected = calculateExpectedEconomics(expectedInput);
  const actual = calculateActualEconomics({
    expected,
    actualRevenueCents: 18_900,
    actualLaborMinutes: 90,
    laborCostPerHourCents: 3_100,
    actualDriveMinutes: 14,
    driveCostPerMinuteCents: 72,
    actualMaterialCostCents: 925,
  });

  it("uses actual operational inputs but retains expected reservice liability", () => {
    expect(actual).toEqual({
      phase: "ACTUAL_AT_COMPLETION",
      revenueCents: 18_900,
      laborMinutes: 90,
      laborCostCents: 4_650,
      driveMinutes: 14,
      driveCostCents: 1_008,
      materialCostCents: 925,
      expectedReserviceCostCents: 1_128,
      actualReserviceCostCents: 0,
      contributionMarginCents: 11_189,
    });
  });

  it("reports signed actual-versus-expected variance", () => {
    expect(calculateEconomicsVariance(expected, actual)).toEqual({
      revenueCents: 0,
      laborMinutes: 15,
      laborCostCents: 775,
      driveMinutes: 3,
      driveCostCents: 216,
      materialCostCents: 125,
      contributionMarginCents: -1_116,
    });
  });

  it("rejects a snapshot whose contribution was tampered with", () => {
    expect(
      ActualEconomicsSnapshotSchema.safeParse({
        ...actual,
        contributionMarginCents: actual.contributionMarginCents + 1,
      }).success,
    ).toBe(false);
  });
});

describe("final economics and reservice cost", () => {
  const originalExpected = calculateExpectedEconomics(expectedInput);
  const originalActual = calculateActualEconomics({
    expected: originalExpected,
    actualRevenueCents: 18_900,
    actualLaborMinutes: 90,
    laborCostPerHourCents: 3_100,
    actualDriveMinutes: 14,
    driveCostPerMinuteCents: 72,
    actualMaterialCostCents: 925,
  });
  const reserviceExpected = calculateExpectedEconomics({
    ...expectedInput,
    revenueCents: 0,
    estimatedLaborMinutes: 45,
    estimatedDriveMinutes: 8,
    materialEstimateCents: 400,
  });
  const reserviceActual = calculateActualEconomics({
    expected: reserviceExpected,
    actualRevenueCents: 0,
    actualLaborMinutes: 45,
    laborCostPerHourCents: 3_100,
    actualDriveMinutes: 8,
    driveCostPerMinuteCents: 72,
    actualMaterialCostCents: 400,
  });

  it("releases expected liability when independent verification finds no reservice", () => {
    expect(
      finalizeEconomics({
        actual: originalActual,
        linkedReserviceActuals: [],
      }),
    ).toEqual({
      phase: "FINAL_AFTER_OUTCOME",
      revenueCents: 18_900,
      laborMinutes: 90,
      laborCostCents: 4_650,
      driveMinutes: 14,
      driveCostCents: 1_008,
      materialCostCents: 925,
      expectedReserviceCostCents: 1_128,
      actualReserviceCostCents: 0,
      contributionMarginCents: 12_317,
    });
  });

  it("uses linked reservice direct costs rather than their revenue or reserve", () => {
    expect(directServiceCostCents(reserviceActual)).toBe(3_301);
    expect(
      finalizeEconomics({
        actual: originalActual,
        linkedReserviceActuals: [
          { jobId: "JOB-RESERVICE-1", actual: reserviceActual },
        ],
      }),
    ).toMatchObject({
      expectedReserviceCostCents: 1_128,
      actualReserviceCostCents: 3_301,
      contributionMarginCents: 9_016,
    });
  });

  it("sums multiple linked reservice costs deterministically", () => {
    expect(
      finalizeEconomics({
        actual: originalActual,
        linkedReserviceActuals: [
          { jobId: "JOB-RESERVICE-1", actual: reserviceActual },
          { jobId: "JOB-RESERVICE-2", actual: reserviceActual },
        ],
      }),
    ).toMatchObject({
      actualReserviceCostCents: 6_602,
      contributionMarginCents: 5_715,
    });
  });

  it("rejects unvalidated extra finalization inputs", () => {
    expect(() =>
      finalizeEconomics({
        actual: originalActual,
        linkedReserviceActuals: [],
        operatorOverrideCents: 100_000,
      }),
    ).toThrow();
  });

  it("rejects duplicate reservice job costs", () => {
    expect(() =>
      finalizeEconomics({
        actual: originalActual,
        linkedReserviceActuals: [
          { jobId: "JOB-RESERVICE-1", actual: reserviceActual },
          { jobId: "JOB-RESERVICE-1", actual: reserviceActual },
        ],
      }),
    ).toThrow(/only once/i);
  });
});
