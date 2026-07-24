#!/usr/bin/env node

import { execFileSync } from "node:child_process";

const allowDirty = process.argv.includes("--allow-dirty");

try {
  const headSha = git(["rev-parse", "HEAD"]);
  const declaredSha = process.env.FIELDPROOF_BUILD_SHA?.trim() ?? "";
  if (!/^[a-f0-9]{40}$/i.test(declaredSha)) {
    throw new Error(
      "FIELDPROOF_BUILD_SHA must be the full 40-character Git commit SHA.",
    );
  }
  if (declaredSha.toLowerCase() !== headSha.toLowerCase()) {
    throw new Error(
      `FIELDPROOF_BUILD_SHA ${declaredSha} does not match HEAD ${headSha}.`,
    );
  }
  if (!allowDirty) {
    const status = git([
      "status",
      "--porcelain=v1",
      "--untracked-files=all",
      "--ignore-submodules=all",
    ]);
    if (status) {
      throw new Error(
        "The release tree contains tracked or untracked source changes.",
      );
    }
  }
  process.stdout.write(`Verified release provenance ${headSha}\n`);
} catch (error) {
  const message =
    error instanceof Error
      ? error.message
      : "Release provenance verification failed.";
  process.stderr.write(`Release provenance rejected: ${message}\n`);
  process.exitCode = 1;
}

function git(args) {
  return execFileSync("git", args, {
    cwd: process.cwd(),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}
