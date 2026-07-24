import {
  authorize,
  permissionsForRole,
  type Permission,
  type Role,
} from "../../../packages/domain/authorization";
import {
  ensurePilotMembership,
  ensurePilotOperationalData,
  PILOT_RECORDS,
  type PilotIdentity,
} from "./pilot-data";

export type RequestContext = {
  organizationId: string;
  organizationName: string;
  autonomyLevel: string;
  actorType: "HUMAN";
  actorId: string;
  actorEmail: string;
  actorDisplayName: string;
  role: Role;
  permissions: readonly Permission[];
  technicianId: string | null;
  isLocalDemo: boolean;
};

export type ContextDenial = {
  context: null;
  status: 401 | 403;
  code: "AUTHENTICATION_REQUIRED" | "MEMBERSHIP_REQUIRED";
  message: string;
};

export type ContextResolution =
  | { context: RequestContext; status?: never; code?: never; message?: never }
  | ContextDenial;

const USER_EMAIL_HEADER = "oai-authenticated-user-email";
const USER_FULL_NAME_HEADER = "oai-authenticated-user-full-name";
const USER_FULL_NAME_ENCODING_HEADER =
  "oai-authenticated-user-full-name-encoding";
const ORGANIZATION_HEADER = "x-fieldproof-organization-id";
const LOCAL_PERSONA_HEADER = "x-fieldproof-demo-persona";
const PERCENT_ENCODED_UTF8 = "percent-encoded-utf-8";

export async function getRequestContext(
  request: Request,
  db: D1Database,
): Promise<ContextResolution> {
  const identity = getRequestIdentity(request);
  if (!identity) {
    return {
      context: null,
      status: 401,
      code: "AUTHENTICATION_REQUIRED",
      message: "A platform-authenticated user is required.",
    };
  }

  const requestedOrganizationId =
    request.headers.get(ORGANIZATION_HEADER)?.trim() ||
    PILOT_RECORDS.organizationId;
  const membership = await ensurePilotMembership(
    db,
    identity,
    requestedOrganizationId,
  );
  if (!membership) {
    return {
      context: null,
      status: 403,
      code: "MEMBERSHIP_REQUIRED",
      message:
        "The signed-in user does not have an active membership in that organization.",
    };
  }

  await ensurePilotOperationalData(db, membership.userId);
  return {
    context: {
      organizationId: membership.organizationId,
      organizationName: membership.organizationName,
      autonomyLevel: membership.autonomyLevel,
      actorType: "HUMAN",
      actorId: membership.userId,
      actorEmail: membership.email,
      actorDisplayName: membership.displayName,
      role: membership.role,
      permissions: permissionsForRole(membership.role),
      technicianId: membership.technicianId,
      isLocalDemo: identity.isLocalDemo,
    },
  };
}

export function getRequestIdentity(request: Request): PilotIdentity | null {
  const email = request.headers.get(USER_EMAIL_HEADER)?.trim().toLowerCase();
  if (email && isPlausibleEmail(email)) {
    const encodedFullName = request.headers.get(USER_FULL_NAME_HEADER);
    const fullName =
      encodedFullName &&
      request.headers.get(USER_FULL_NAME_ENCODING_HEADER) ===
        PERCENT_ENCODED_UTF8
        ? safeDecodeURIComponent(encodedFullName)
        : null;

    return {
      email,
      displayName: fullName?.trim() || email,
      isLocalDemo: false,
    };
  }

  if (isLocalRequest(request)) {
    return {
      email: "owner@northstar.demo",
      displayName: "Local Demo Owner",
      isLocalDemo: true,
      requestedPersona: request.headers.get(LOCAL_PERSONA_HEADER)?.trim(),
    };
  }

  return null;
}

export function contextDenied(
  resolution: ContextDenial,
  correlationId: string,
) {
  return Response.json(
    {
      error: {
        code: resolution.code,
        message: resolution.message,
        correlationId,
      },
    },
    { status: resolution.status },
  );
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

export function authorizePermission(
  context: RequestContext,
  permission: Permission,
  correlationId: string,
  assignedTechnicianId?: string | null,
) {
  const decision = authorize(
    {
      organizationId: context.organizationId,
      userId: context.actorId,
      role: context.role,
      status: "ACTIVE",
      technicianId: context.technicianId,
    },
    {
      organizationId: context.organizationId,
      permission,
      assignedTechnicianId,
    },
  );
  if (decision.allowed) return null;
  return Response.json(
    {
      error: {
        code: decision.code,
        message: decision.reason,
        correlationId,
      },
    },
    { status: 403 },
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
