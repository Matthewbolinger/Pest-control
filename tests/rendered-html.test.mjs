import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";

async function builtArtifacts() {
  const server = await readFile(new URL("../dist/server/index.js", import.meta.url), "utf8");
  const assetFiles = await readdir(new URL("../dist/client/assets/", import.meta.url));
  const applicationFile = assetFiles.find((file) => file.startsWith("fieldproof-app-") && file.endsWith(".js"));
  assert.ok(applicationFile, "FieldProof client artifact is missing");
  const application = await readFile(new URL(`../dist/client/assets/${applicationFile}`, import.meta.url), "utf8");
  const cssFile = assetFiles.find((file) => file.endsWith(".css"));
  assert.ok(cssFile, "FieldProof stylesheet artifact is missing");
  const css = await readFile(new URL(`../dist/client/assets/${cssFile}`, import.meta.url), "utf8");
  return { server, application, css };
}

test("builds the FieldProof operations product", async () => {
  const { server, application } = await builtArtifacts();
  assert.match(server, /FieldProof · Outcome operations for pest control/i);
  assert.match(application, /FieldProof/);
  assert.match(application, /Control Tower/);
  assert.match(application, /Northstar Pest/);
  assert.doesNotMatch(application, /codex-preview|Your site is taking shape|react-loading-skeleton/i);
});

test("keeps responsive and accessible product structure in the build", async () => {
  const { application, css } = await builtArtifacts();
  assert.match(application, /Primary navigation/i);
  assert.match(application, /Operational metrics/i);
  assert.match(application, /aria-label/);
  assert.match(css, /prefers-reduced-motion/);
  assert.match(css, /@media print/);
});
