import { expect, test, type Locator, type Page } from "@playwright/test";

test("persists the approved Huntley workflow from request through Service Proof", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "One request. One durable outcome loop." }),
  ).toBeVisible();

  await clickAndConfirmWorkflow(
    page,
    page.getByRole("button", { name: "Restart demo workflow" }),
  );
  await expect(page.getByText("32/100")).toBeVisible();

  await page.getByRole("button", { name: "Open priority request" }).click();
  await expect(
    page.getByRole("heading", { name: "Basement mouse activity" }),
  ).toBeVisible();

  await clickAndConfirmWorkflow(
    page,
    page.getByRole("button", { name: "Generate AI proposal" }),
  );
  await expect(page.getByText("Human judgment required")).toBeVisible();

  await clickAndConfirmWorkflow(
    page,
    page.getByRole("button", { name: "Approve triage" }),
  );
  await expect(page.getByText("Human approval recorded")).toBeVisible();

  await page.getByRole("button", { name: "Open ranked slots" }).click();
  await expect(
    page.getByRole("heading", { name: "Choose the strongest route fit" }),
  ).toBeVisible();

  await clickAndConfirmWorkflow(
    page,
    page.getByRole("button", { name: "Approve Today · 1:30 PM" }),
  );

  await expect(
    page.getByRole("heading", { name: "Rodent entry-point inspection" }),
  ).toBeVisible();
  await expect(page.getByText(/Assignment SC-2401 · TECH-04/)).toBeVisible();

  await clickAndConfirmWorkflow(
    page,
    page.getByRole("button", { name: "Check in" }),
  );
  await expect(
    page.getByText("Checked in", { exact: true }).first(),
  ).toBeVisible();

  const checklist = page.getByRole("checkbox");
  await expect(checklist).toHaveCount(4);
  for (let index = 0; index < 4; index += 1) {
    await checkAndConfirmWorkflowStep(page, checklist.nth(index), index);
    await expect(checklist.nth(index)).toBeChecked();
  }

  const evidenceInput = page.locator('input[type="file"]');
  await uploadAndConfirmEvidence(
    page,
    evidenceInput,
    "fieldproof-before.png",
    BEFORE_PNG,
  );
  await expect(page.getByText("1 / 2 min.")).toBeVisible();

  await page.getByLabel("Capture phase").selectOption("DURING");
  await page.getByLabel("Evidence subject").selectOption("ENTRY_POINT");
  await page
    .getByLabel("Caption")
    .fill("North sill-plate entry point inspected and documented.");
  await uploadAndConfirmEvidence(
    page,
    evidenceInput,
    "fieldproof-entry-point.png",
    ENTRY_POINT_PNG,
  );
  await expect(page.getByText("2 / 2 min.")).toBeVisible();
  await expect(
    page.getByText("Passed Typed evidence policy", { exact: false }),
  ).toBeVisible();

  await clickAndConfirmWorkflow(
    page,
    page.getByRole("button", { name: "Save field observation" }),
  );
  await expect(
    page.getByText(
      "Small dark droppings observed along the north basement sill plate.",
    ),
  ).toBeVisible();

  await clickAndConfirmWorkflow(
    page,
    page.getByRole("button", { name: "Unresolved risk", exact: true }),
  );
  await expect(
    page.getByRole("button", { name: "✓ Unresolved risk" }),
  ).toBeVisible();

  await clickAndConfirmWorkflow(
    page,
    page.getByRole("button", {
      name: "Mark field work complete & generate proof",
    }),
  );
  await expect(
    page.getByRole("heading", { name: "Immutable field record" }),
  ).toBeVisible();
  await expect(page.getByText("Maya Chen", { exact: true })).toBeVisible();
  await expect(page.getByText("47/100 · Moderate")).toBeVisible();
  await expect(page.getByText("Pending verification", { exact: true })).toBeVisible();
  await expect(page.getByText("No resolution claim yet")).toBeVisible();

  await clickAndConfirmWorkflow(
    page,
    page.getByRole("button", { name: "Queue Service Proof delivery" }),
  );
  await clickAndConfirm(
    page,
    page.getByRole("button", { name: "Process mock delivery" }),
    "/api/v1/outbox",
  );
  await expect(
    page.getByRole("button", { name: "Delivered" }),
  ).toBeDisabled();

  const pendingVerificationResponse = await page.request.get(
    "/api/v1/workflow",
  );
  const pendingVerification = (await pendingVerificationResponse.json()) as {
    data: { version: number };
  };
  const forgedDirectConfirmation = {
    type: "VERIFY_OUTCOME",
    commandId: `e2e-forged-customer-${crypto.randomUUID()}`,
    expectedVersion: pendingVerification.data.version,
    result: "RESOLVED",
    source: "CUSTOMER_CONFIRMATION",
    note: "This direct signal has no trusted provider receipt.",
  };
  const forgedDirectResponse = await page.request.post("/api/v1/workflow", {
    data: forgedDirectConfirmation,
    headers: {
      "Idempotency-Key": forgedDirectConfirmation.commandId,
    },
  });
  expect(forgedDirectResponse.status()).toBe(422);
  await expect(forgedDirectResponse.json()).resolves.toMatchObject({
    error: { code: "TRUSTED_SOURCE_REQUIRED" },
  });

  const selfAttestation = {
    ...forgedDirectConfirmation,
    commandId: `e2e-self-attestation-${crypto.randomUUID()}`,
    source: "STAFF_RECORDED_CUSTOMER_CONFIRMATION",
  };
  const selfAttestationResponse = await page.request.post(
    "/api/v1/workflow",
    {
      data: selfAttestation,
      headers: { "Idempotency-Key": selfAttestation.commandId },
    },
  );
  expect(selfAttestationResponse.status()).toBe(409);

  await clickAndConfirmWorkflow(
    page,
    page.getByRole("button", {
      name: "Attest to customer-confirmed outcome",
    }),
  );
  await expect(
    page.getByRole("heading", { name: "Verified: Resolved" }),
  ).toBeVisible();

  const verifiedResponse = await page.request.get("/api/v1/workflow");
  const verifiedSnapshot = (await verifiedResponse.json()) as {
    data: { version: number; jobId: string };
  };
  const selfReservice = {
    type: "RECORD_RESERVICE",
    commandId: `e2e-self-reservice-${crypto.randomUUID()}`,
    expectedVersion: verifiedSnapshot.data.version,
    reserviceJobId: verifiedSnapshot.data.jobId,
    reason: "A job may not be its own reservice.",
    directCostCents: 4_500,
  };
  const selfReserviceResponse = await page.request.post(
    "/api/v1/workflow",
    {
      data: selfReservice,
      headers: { "Idempotency-Key": selfReservice.commandId },
    },
  );
  expect(selfReserviceResponse.status()).toBe(409);

  await clickAndConfirmWorkflow(
    page,
    page.getByRole("button", { name: "Link reservice" }),
  );
  await expect(
    page.getByText("$45.00 linked reservice cost"),
  ).toBeVisible();
  await expect(
    page.getByText("Reservice required", { exact: true }).first(),
  ).toBeVisible();

  await page.reload();
  await expect(
    page.getByRole("heading", { name: "One request. One durable outcome loop." }),
  ).toBeVisible();
  await expect(page.getByText("Completed", { exact: true }).first()).toBeVisible();
  await page.getByRole("button", { name: /Job JOB-2048 · Huntley/ }).click();
  await expect(
    page.getByRole("heading", { name: "Immutable field record" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Delivered" }),
  ).toBeDisabled();

  await page.getByRole("button", { name: /Exceptions/ }).click();
  const unresolvedExceptionResponse = await page.request.get(
    "/api/v1/workflow",
  );
  const unresolvedException = (await unresolvedExceptionResponse.json()) as {
    data: { version: number };
  };
  const invalidOwnerCommand = {
    type: "RESOLVE_EXCEPTION",
    commandId: `e2e-invalid-owner-${crypto.randomUUID()}`,
    expectedVersion: unresolvedException.data.version,
    ownerUserId: "USER-NOT-A-MEMBER",
    resolutionNote: "This user is not an active tenant member.",
  };
  const invalidOwnerResponse = await page.request.post("/api/v1/workflow", {
    data: invalidOwnerCommand,
    headers: { "Idempotency-Key": invalidOwnerCommand.commandId },
  });
  expect(invalidOwnerResponse.status()).toBe(409);

  await clickAndConfirmWorkflow(
    page,
    page.getByRole("button", { name: "Assign owner & resolve" }),
  );
  await expect(page.getByText("Resolved", { exact: true })).toBeVisible();

  const currentResponse = await page.request.get("/api/v1/workflow");
  expect(currentResponse.ok()).toBe(true);
  const current = (await currentResponse.json()) as {
    data: { version: number };
  };
  const replayRunId = crypto.randomUUID().replaceAll("-", "");
  const resetCommand = {
    type: "RESET_DEMO",
    commandId: `e2e-reset-${replayRunId}`,
    expectedVersion: current.data.version,
  };
  const crossSiteResponse = await page.request.post("/api/v1/workflow", {
    data: resetCommand,
    headers: {
      "Idempotency-Key": resetCommand.commandId,
      Origin: "https://attacker.example",
    },
  });
  expect(crossSiteResponse.status()).toBe(403);

  const mismatchResponse = await page.request.post("/api/v1/workflow", {
    data: resetCommand,
    headers: { "Idempotency-Key": `e2e-mismatch-${replayRunId}` },
  });
  expect(mismatchResponse.status()).toBe(400);

  const resetResponse = await page.request.post("/api/v1/workflow", {
    data: resetCommand,
    headers: { "Idempotency-Key": resetCommand.commandId },
  });
  expect(resetResponse.ok()).toBe(true);
  const reset = (await resetResponse.json()) as {
    data: { version: number; triageStatus: string };
  };

  const triageCommand = {
    type: "RUN_TRIAGE",
    commandId: `e2e-triage-${replayRunId}`,
    expectedVersion: reset.data.version,
  };
  const triageResponse = await page.request.post("/api/v1/workflow", {
    data: triageCommand,
    headers: { "Idempotency-Key": triageCommand.commandId },
  });
  expect(triageResponse.ok()).toBe(true);
  const triage = (await triageResponse.json()) as {
    data: { version: number; triageStatus: string };
  };

  const replayResponse = await page.request.post("/api/v1/workflow", {
    data: resetCommand,
    headers: { "Idempotency-Key": resetCommand.commandId },
  });
  expect(replayResponse.ok()).toBe(true);
  const replay = (await replayResponse.json()) as {
    data: { version: number; triageStatus: string };
    idempotent: boolean;
  };
  expect(replay.idempotent).toBe(true);
  expect(replay.data.version).toBe(triage.data.version);
  expect(replay.data.triageStatus).toBe("PROPOSED");
});

async function clickAndConfirmWorkflow(
  page: Page,
  locator: Locator,
  force = false,
) {
  return clickAndConfirm(page, locator, "/api/v1/workflow", force);
}

async function checkAndConfirmWorkflowStep(
  page: Page,
  locator: Locator,
  index: number,
) {
  const responsePromise = page.waitForResponse((response) => {
    if (
      new URL(response.url()).pathname !== "/api/v1/workflow" ||
      response.request().method() !== "POST"
    ) {
      return false;
    }
    const command = response.request().postDataJSON() as
      | { type?: string; index?: number }
      | null;
    return command?.type === "SET_CHECKLIST_STEP" && command.index === index;
  });
  await locator.click({ force: true });
  const response = await responsePromise;
  expect(
    response.ok(),
    `/api/v1/workflow returned ${response.status()}: ${await response.text()}`,
  ).toBe(true);
  await expect
    .poll(async () => {
      const workflow = await page.request.get("/api/v1/workflow");
      const body = (await workflow.json()) as {
        data?: { checklist?: boolean[] };
      };
      return body.data?.checklist?.[index];
    })
    .toBe(true);
}

async function clickAndConfirm(
  page: Page,
  locator: Locator,
  endpoint: string,
  force = false,
) {
  const responsePromise = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === endpoint &&
      response.request().method() === "POST",
  );
  await locator.click({ force });
  const response = await responsePromise;
  expect(
    response.ok(),
    `${endpoint} returned ${response.status()}: ${await response.text()}`,
  ).toBe(true);
  const body = (await response.json()) as { data?: unknown };
  expect(body.data).toBeTruthy();
  return body.data;
}

async function uploadAndConfirmEvidence(
  page: Page,
  input: Locator,
  name: string,
  buffer: Buffer,
) {
  const responsePromise = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/v1/evidence" &&
      response.request().method() === "POST",
  );
  await input.setInputFiles({
    name,
    mimeType: "image/png",
    buffer,
  });
  const response = await responsePromise;
  expect(
    response.ok(),
    `/api/v1/evidence returned ${response.status()}: ${await response.text()}`,
  ).toBe(true);
}

const BEFORE_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

const ENTRY_POINT_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z8Z8AAAAASUVORK5CYII=",
  "base64",
);
