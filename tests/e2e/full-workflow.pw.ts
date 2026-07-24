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

  await page
    .getByRole("button", { name: /Andre Silva · 24 min drive/ })
    .click();
  await clickAndConfirmWorkflow(
    page,
    page.getByRole("button", { name: "Approve Today · 3:45 PM" }),
  );

  await expect(
    page.getByRole("heading", { name: "Rodent entry-point inspection" }),
  ).toBeVisible();
  await expect(page.getByText(/Assignment SC-2402 · TECH-07/)).toBeVisible();

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
    await clickAndConfirmWorkflow(page, checklist.nth(index), true);
    await expect(checklist.nth(index)).toBeChecked();
  }

  await clickAndConfirmEvidence(
    page,
    page.getByRole("button", {
      name: /Create & upload sample overview PNG/,
    }),
  );
  await expect(page.getByText("1 / 2 min.")).toBeVisible();

  await clickAndConfirmEvidence(
    page,
    page.getByRole("button", {
      name: /Create & upload sample detail PNG/,
    }),
  );
  await expect(page.getByText("2 / 2 min.")).toBeVisible();

  await clickAndConfirmWorkflow(
    page,
    page.getByRole("button", { name: "Record sample observation" }),
  );
  await expect(
    page.getByText(
      "Small dark droppings observed along north basement sill plate.",
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
    page.getByRole("button", { name: "Complete job & generate proof" }),
  );
  await expect(
    page.getByRole("heading", { name: "Server-confirmed report" }),
  ).toBeVisible();
  await expect(page.getByText("Andre Silva", { exact: true })).toBeVisible();
  await expect(page.getByText("47/100 · Moderate")).toBeVisible();
  await expect(page.getByText("Follow-up created", { exact: true })).toHaveCount(2);

  await clickAndConfirmWorkflow(
    page,
    page.getByRole("button", { name: "Queue Service Proof delivery" }),
  );
  await expect(
    page.getByRole("button", { name: "Delivery queued" }),
  ).toBeDisabled();

  await page.reload();
  await expect(
    page.getByRole("heading", { name: "One request. One durable outcome loop." }),
  ).toBeVisible();
  await expect(page.getByText("Completed", { exact: true }).first()).toBeVisible();
  await page.getByRole("button", { name: /Job JOB-2048 · Huntley/ }).click();
  await expect(
    page.getByRole("heading", { name: "Server-confirmed report" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Delivery queued" }),
  ).toBeDisabled();

  await page.getByRole("button", { name: /Exceptions/ }).click();
  await clickAndConfirmWorkflow(
    page,
    page.getByRole("button", { name: "Assign & resolve" }),
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

async function clickAndConfirmEvidence(page: Page, locator: Locator) {
  return clickAndConfirm(page, locator, "/api/v1/evidence");
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
