import { z } from "zod";

const MAX_CENTS = 9_000_000_000_000;
const MAX_MINUTES = 10_000_000;
const IdentifierSchema = z.string().trim().min(1).max(128);

export const NonNegativeCentsSchema = z
  .number()
  .int()
  .min(0)
  .max(MAX_CENTS);

export const SignedCentsSchema = z
  .number()
  .int()
  .min(-MAX_CENTS)
  .max(MAX_CENTS);

const MinutesSchema = z.number().int().min(0).max(MAX_MINUTES);
const BasisPointsSchema = z.number().int().min(0).max(10_000);

const EconomicsSnapshotFields = {
  revenueCents: NonNegativeCentsSchema,
  laborMinutes: MinutesSchema,
  laborCostCents: NonNegativeCentsSchema,
  driveMinutes: MinutesSchema,
  driveCostCents: NonNegativeCentsSchema,
  materialCostCents: NonNegativeCentsSchema,
  expectedReserviceCostCents: NonNegativeCentsSchema,
  actualReserviceCostCents: NonNegativeCentsSchema,
  contributionMarginCents: SignedCentsSchema,
} as const;

export const ExpectedEconomicsInputSchema = z
  .object({
    revenueCents: NonNegativeCentsSchema,
    estimatedLaborMinutes: MinutesSchema,
    laborCostPerHourCents: NonNegativeCentsSchema,
    estimatedDriveMinutes: MinutesSchema,
    driveCostPerMinuteCents: NonNegativeCentsSchema,
    materialEstimateCents: NonNegativeCentsSchema,
    reserviceProbabilityBasisPoints: BasisPointsSchema,
    averageReserviceCostCents: NonNegativeCentsSchema,
  })
  .strict();

export type ExpectedEconomicsInput = z.infer<
  typeof ExpectedEconomicsInputSchema
>;

export const ExpectedEconomicsSnapshotSchema = z
  .object({
    phase: z.literal("EXPECTED_AT_BOOKING"),
    ...EconomicsSnapshotFields,
  })
  .strict()
  .superRefine((snapshot, context) => {
    if (snapshot.actualReserviceCostCents !== 0) {
      context.addIssue({
        code: "custom",
        path: ["actualReserviceCostCents"],
        message: "Expected economics cannot contain actual reservice cost.",
      });
    }
    validateContribution(
      snapshot,
      snapshot.expectedReserviceCostCents,
      context,
    );
  });

export type ExpectedEconomicsSnapshot = z.infer<
  typeof ExpectedEconomicsSnapshotSchema
>;

export const ActualEconomicsInputSchema = z
  .object({
    expected: ExpectedEconomicsSnapshotSchema,
    actualRevenueCents: NonNegativeCentsSchema,
    actualLaborMinutes: MinutesSchema,
    laborCostPerHourCents: NonNegativeCentsSchema,
    actualDriveMinutes: MinutesSchema,
    driveCostPerMinuteCents: NonNegativeCentsSchema,
    actualMaterialCostCents: NonNegativeCentsSchema,
  })
  .strict();

export type ActualEconomicsInput = z.infer<typeof ActualEconomicsInputSchema>;

export const ActualEconomicsSnapshotSchema = z
  .object({
    phase: z.literal("ACTUAL_AT_COMPLETION"),
    ...EconomicsSnapshotFields,
  })
  .strict()
  .superRefine((snapshot, context) => {
    if (snapshot.actualReserviceCostCents !== 0) {
      context.addIssue({
        code: "custom",
        path: ["actualReserviceCostCents"],
        message:
          "Completion economics retain expected liability until outcome finalization.",
      });
    }
    validateContribution(
      snapshot,
      snapshot.expectedReserviceCostCents,
      context,
    );
  });

export type ActualEconomicsSnapshot = z.infer<
  typeof ActualEconomicsSnapshotSchema
>;

export const LinkedReserviceActualSchema = z
  .object({
    jobId: IdentifierSchema,
    actual: ActualEconomicsSnapshotSchema,
  })
  .strict();

export const FinalEconomicsInputSchema = z
  .object({
    actual: ActualEconomicsSnapshotSchema,
    linkedReserviceActuals: z
      .array(LinkedReserviceActualSchema)
      .max(100),
  })
  .strict()
  .superRefine((input, context) => {
    const jobIds = new Set<string>();
    for (const [index, reservice] of input.linkedReserviceActuals.entries()) {
      if (jobIds.has(reservice.jobId)) {
        context.addIssue({
          code: "custom",
          path: ["linkedReserviceActuals", index, "jobId"],
          message: "A linked reservice job may contribute cost only once.",
        });
      }
      jobIds.add(reservice.jobId);
    }
  });

export type FinalEconomicsInput = z.infer<typeof FinalEconomicsInputSchema>;

export const FinalEconomicsSnapshotSchema = z
  .object({
    phase: z.literal("FINAL_AFTER_OUTCOME"),
    ...EconomicsSnapshotFields,
  })
  .strict()
  .superRefine((snapshot, context) => {
    validateContribution(
      snapshot,
      snapshot.actualReserviceCostCents,
      context,
    );
  });

export type FinalEconomicsSnapshot = z.infer<
  typeof FinalEconomicsSnapshotSchema
>;

export const EconomicsVarianceSchema = z
  .object({
    revenueCents: SignedCentsSchema,
    laborMinutes: z.number().int().min(-MAX_MINUTES).max(MAX_MINUTES),
    laborCostCents: SignedCentsSchema,
    driveMinutes: z.number().int().min(-MAX_MINUTES).max(MAX_MINUTES),
    driveCostCents: SignedCentsSchema,
    materialCostCents: SignedCentsSchema,
    contributionMarginCents: SignedCentsSchema,
  })
  .strict();

export type EconomicsVariance = z.infer<typeof EconomicsVarianceSchema>;

export function calculateExpectedEconomics(
  inputValue: unknown,
): ExpectedEconomicsSnapshot {
  const input = ExpectedEconomicsInputSchema.parse(inputValue);
  const laborCostCents = roundedProductDivide(
    input.estimatedLaborMinutes,
    input.laborCostPerHourCents,
    60,
  );
  const driveCostCents = checkedProduct(
    input.estimatedDriveMinutes,
    input.driveCostPerMinuteCents,
  );
  const expectedReserviceCostCents = roundedProductDivide(
    input.averageReserviceCostCents,
    input.reserviceProbabilityBasisPoints,
    10_000,
  );
  const contributionMarginCents = checkedDifference(
    input.revenueCents,
    laborCostCents,
    driveCostCents,
    input.materialEstimateCents,
    expectedReserviceCostCents,
  );

  return ExpectedEconomicsSnapshotSchema.parse({
    phase: "EXPECTED_AT_BOOKING",
    revenueCents: input.revenueCents,
    laborMinutes: input.estimatedLaborMinutes,
    laborCostCents,
    driveMinutes: input.estimatedDriveMinutes,
    driveCostCents,
    materialCostCents: input.materialEstimateCents,
    expectedReserviceCostCents,
    actualReserviceCostCents: 0,
    contributionMarginCents,
  });
}

export function calculateActualEconomics(
  inputValue: unknown,
): ActualEconomicsSnapshot {
  const input = ActualEconomicsInputSchema.parse(inputValue);
  const laborCostCents = roundedProductDivide(
    input.actualLaborMinutes,
    input.laborCostPerHourCents,
    60,
  );
  const driveCostCents = checkedProduct(
    input.actualDriveMinutes,
    input.driveCostPerMinuteCents,
  );
  const contributionMarginCents = checkedDifference(
    input.actualRevenueCents,
    laborCostCents,
    driveCostCents,
    input.actualMaterialCostCents,
    input.expected.expectedReserviceCostCents,
  );

  return ActualEconomicsSnapshotSchema.parse({
    phase: "ACTUAL_AT_COMPLETION",
    revenueCents: input.actualRevenueCents,
    laborMinutes: input.actualLaborMinutes,
    laborCostCents,
    driveMinutes: input.actualDriveMinutes,
    driveCostCents,
    materialCostCents: input.actualMaterialCostCents,
    expectedReserviceCostCents: input.expected.expectedReserviceCostCents,
    actualReserviceCostCents: 0,
    contributionMarginCents,
  });
}

export function directServiceCostCents(
  actualValue: unknown,
): number {
  const actual = ActualEconomicsSnapshotSchema.parse(actualValue);
  return checkedSum(
    actual.laborCostCents,
    actual.driveCostCents,
    actual.materialCostCents,
  );
}

export function finalizeEconomics(
  inputValue: unknown,
): FinalEconomicsSnapshot {
  const input = FinalEconomicsInputSchema.parse(inputValue);
  const actualReserviceCostCents = checkedSum(
    ...input.linkedReserviceActuals.map((reservice) =>
      directServiceCostCents(reservice.actual),
    ),
  );
  const contributionMarginCents = checkedDifference(
    input.actual.revenueCents,
    input.actual.laborCostCents,
    input.actual.driveCostCents,
    input.actual.materialCostCents,
    actualReserviceCostCents,
  );

  return FinalEconomicsSnapshotSchema.parse({
    phase: "FINAL_AFTER_OUTCOME",
    revenueCents: input.actual.revenueCents,
    laborMinutes: input.actual.laborMinutes,
    laborCostCents: input.actual.laborCostCents,
    driveMinutes: input.actual.driveMinutes,
    driveCostCents: input.actual.driveCostCents,
    materialCostCents: input.actual.materialCostCents,
    expectedReserviceCostCents: input.actual.expectedReserviceCostCents,
    actualReserviceCostCents,
    contributionMarginCents,
  });
}

export function calculateEconomicsVariance(
  expectedValue: unknown,
  actualValue: unknown,
): EconomicsVariance {
  const expected = ExpectedEconomicsSnapshotSchema.parse(expectedValue);
  const actual = ActualEconomicsSnapshotSchema.parse(actualValue);
  return EconomicsVarianceSchema.parse({
    revenueCents: actual.revenueCents - expected.revenueCents,
    laborMinutes: actual.laborMinutes - expected.laborMinutes,
    laborCostCents: actual.laborCostCents - expected.laborCostCents,
    driveMinutes: actual.driveMinutes - expected.driveMinutes,
    driveCostCents: actual.driveCostCents - expected.driveCostCents,
    materialCostCents:
      actual.materialCostCents - expected.materialCostCents,
    contributionMarginCents:
      actual.contributionMarginCents - expected.contributionMarginCents,
  });
}

function roundedProductDivide(
  left: number,
  right: number,
  divisor: number,
): number {
  const numerator = BigInt(left) * BigInt(right);
  const denominator = BigInt(divisor);
  return checkedBigIntToNumber(
    (numerator + denominator / BigInt(2)) / denominator,
  );
}

function checkedProduct(left: number, right: number): number {
  return checkedBigIntToNumber(BigInt(left) * BigInt(right));
}

function checkedSum(...values: number[]): number {
  return checkedBigIntToNumber(
    values.reduce((total, value) => total + BigInt(value), BigInt(0)),
  );
}

function checkedDifference(revenue: number, ...costs: number[]): number {
  const result = costs.reduce(
    (total, cost) => total - BigInt(cost),
    BigInt(revenue),
  );
  return checkedBigIntToNumber(result, true);
}

function checkedBigIntToNumber(value: bigint, signed = false): number {
  const minimum = signed ? BigInt(-MAX_CENTS) : BigInt(0);
  const maximum = BigInt(MAX_CENTS);
  if (value < minimum || value > maximum) {
    throw new RangeError("Calculated economics exceed the supported range.");
  }
  return Number(value);
}

function validateContribution(
  snapshot: EconomicsComponents,
  reserviceCostCents: number,
  context: z.RefinementCtx,
) {
  const expected = checkedDifference(
    snapshot.revenueCents,
    snapshot.laborCostCents,
    snapshot.driveCostCents,
    snapshot.materialCostCents,
    reserviceCostCents,
  );
  if (snapshot.contributionMarginCents !== expected) {
    context.addIssue({
      code: "custom",
      path: ["contributionMarginCents"],
      message: "Contribution margin is inconsistent with its cost components.",
    });
  }
}

type EconomicsComponents = {
  revenueCents: number;
  laborMinutes: number;
  laborCostCents: number;
  driveMinutes: number;
  driveCostCents: number;
  materialCostCents: number;
  expectedReserviceCostCents: number;
  actualReserviceCostCents: number;
  contributionMarginCents: number;
};
