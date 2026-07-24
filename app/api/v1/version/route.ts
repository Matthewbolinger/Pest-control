const BUILD = resolveBuildProvenance();

export async function GET() {
  return Response.json(
    {
      service: "fieldproof",
      version: "0.2.0",
      buildSha: BUILD.sha,
      provenance: BUILD.verified ? "VERIFIED" : "UNVERIFIED",
    },
    {
      status:
        process.env.NODE_ENV === "production" && !BUILD.verified
          ? 503
          : 200,
      headers: {
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        "x-fieldproof-build-sha": BUILD.sha,
        "x-fieldproof-build-provenance": BUILD.verified
          ? "verified"
          : "unverified",
      },
    },
  );
}

function resolveBuildProvenance() {
  const candidates = [
    process.env.FIELDPROOF_BUILD_SHA,
    process.env.SOURCE_COMMIT_SHA,
    process.env.GITHUB_SHA,
    process.env.CF_PAGES_COMMIT_SHA,
  ];
  const sha = candidates.find(
    (value): value is string =>
      typeof value === "string" &&
      /^[a-f0-9]{40,64}$/i.test(value),
  );
  return sha
    ? { sha, verified: true as const }
    : {
        sha:
          process.env.NODE_ENV === "production"
            ? "unverified"
            : "development",
        verified: false as const,
      };
}
