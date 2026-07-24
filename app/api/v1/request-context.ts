export type RequestContext = {
  organizationId: "ORG-NORTHSTAR";
  actorType: "HUMAN";
  actorId: string;
  actorEmail: string;
  actorDisplayName: string;
  technicianId: "TECH-04";
  isLocalDemo: boolean;
};

const USER_EMAIL_HEADER = "oai-authenticated-user-email";
const USER_FULL_NAME_HEADER = "oai-authenticated-user-full-name";
const USER_FULL_NAME_ENCODING_HEADER =
  "oai-authenticated-user-full-name-encoding";
const PERCENT_ENCODED_UTF8 = "percent-encoded-utf-8";

export function getRequestContext(request: Request): RequestContext | null {
  const email = request.headers.get(USER_EMAIL_HEADER)?.trim().toLowerCase();
  if (email && isPlausibleEmail(email)) {
    const encodedFullName = request.headers.get(USER_FULL_NAME_HEADER);
    const fullName =
      encodedFullName &&
      request.headers.get(USER_FULL_NAME_ENCODING_HEADER) ===
        PERCENT_ENCODED_UTF8
        ? safeDecodeURIComponent(encodedFullName)
        : null;

    return contextFor({
      email,
      displayName: fullName?.trim() || email,
      isLocalDemo: false,
    });
  }

  if (isLocalRequest(request)) {
    return contextFor({
      email: "owner@northstar.demo",
      displayName: "Local Demo Owner",
      isLocalDemo: true,
    });
  }

  return null;
}

export function unauthorized(correlationId: string) {
  return Response.json(
    {
      error: {
        code: "AUTHENTICATION_REQUIRED",
        message: "A platform-authenticated user is required.",
        correlationId,
      },
    },
    { status: 401 },
  );
}

export function isCrossSiteMutation(request: Request) {
  if (request.headers.get("sec-fetch-site") === "cross-site") return true;

  const origin = request.headers.get("origin");
  if (!origin) return false;

  try {
    return new URL(origin).origin !== new URL(request.url).origin;
  } catch {
    return true;
  }
}

function contextFor(input: {
  email: string;
  displayName: string;
  isLocalDemo: boolean;
}): RequestContext {
  return {
    organizationId: "ORG-NORTHSTAR",
    actorType: "HUMAN",
    actorId: input.email,
    actorEmail: input.email,
    actorDisplayName: input.displayName,
    technicianId: "TECH-04",
    isLocalDemo: input.isLocalDemo,
  };
}

function isLocalRequest(request: Request) {
  try {
    const hostname = new URL(request.url).hostname.toLowerCase();
    return (
      hostname === "localhost" ||
      hostname === "127.0.0.1" ||
      hostname === "[::1]" ||
      hostname === "::1"
    );
  } catch {
    return false;
  }
}

function isPlausibleEmail(value: string) {
  return (
    value.length <= 320 &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
  );
}

function safeDecodeURIComponent(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}
