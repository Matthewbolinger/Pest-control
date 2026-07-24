import { z } from "zod";

const IdentifierSchema = z.string().trim().min(1).max(128);

export const RoleSchema = z.enum([
  "OWNER",
  "ADMIN",
  "MANAGER",
  "DISPATCHER",
  "TECHNICIAN",
  "READ_ONLY",
]);

export type Role = z.infer<typeof RoleSchema>;

export const PermissionSchema = z.enum([
  "ORGANIZATION_MANAGE",
  "MEMBERSHIP_MANAGE",
  "CUSTOMER_READ",
  "CUSTOMER_WRITE",
  "PROPERTY_READ",
  "PROPERTY_WRITE",
  "SERVICE_REQUEST_READ",
  "SERVICE_REQUEST_WRITE",
  "TRIAGE_APPROVE",
  "SCHEDULE_APPROVE",
  "JOB_READ_ALL",
  "JOB_READ_ASSIGNED",
  "JOB_FIELD_WRITE_ASSIGNED",
  "EVIDENCE_UPLOAD_ASSIGNED",
  "JOB_COMPLETE_ASSIGNED",
  "PROOF_SEND",
  "OUTCOME_VERIFY",
  "RESERVICE_CREATE",
  "EXCEPTION_MANAGE",
  "INTEGRATION_MANAGE",
  "ECONOMICS_READ",
  "AUDIT_READ",
]);

export type Permission = z.infer<typeof PermissionSchema>;

export const MembershipAuthorizationContextSchema = z
  .object({
    organizationId: IdentifierSchema,
    userId: IdentifierSchema,
    role: RoleSchema,
    status: z.enum(["ACTIVE", "DISABLED"]),
    technicianId: IdentifierSchema.nullable(),
  })
  .strict();

export type MembershipAuthorizationContext = z.infer<
  typeof MembershipAuthorizationContextSchema
>;

export const AuthorizationRequestSchema = z
  .object({
    organizationId: IdentifierSchema,
    permission: PermissionSchema,
    assignedTechnicianId: IdentifierSchema.nullable().optional(),
  })
  .strict();

export type AuthorizationRequest = z.infer<typeof AuthorizationRequestSchema>;

export type AuthorizationDenialCode =
  | "INVALID_CONTEXT"
  | "INVALID_REQUEST"
  | "MEMBERSHIP_DISABLED"
  | "TENANT_MISMATCH"
  | "PERMISSION_DENIED"
  | "ASSIGNED_TECHNICIAN_REQUIRED";

export type AuthorizationDecision =
  | {
      allowed: true;
      code: "ALLOWED";
      reason: string;
      role: Role;
      permission: Permission;
    }
  | {
      allowed: false;
      code: AuthorizationDenialCode;
      reason: string;
    };

const officeReadPermissions = [
  "CUSTOMER_READ",
  "PROPERTY_READ",
  "SERVICE_REQUEST_READ",
  "JOB_READ_ALL",
  "ECONOMICS_READ",
  "AUDIT_READ",
] as const satisfies readonly Permission[];

const officeWritePermissions = [
  "CUSTOMER_WRITE",
  "PROPERTY_WRITE",
  "SERVICE_REQUEST_WRITE",
  "TRIAGE_APPROVE",
  "SCHEDULE_APPROVE",
  "PROOF_SEND",
  "OUTCOME_VERIFY",
  "RESERVICE_CREATE",
  "EXCEPTION_MANAGE",
  "INTEGRATION_MANAGE",
] as const satisfies readonly Permission[];

const assignedFieldPermissions = [
  "JOB_READ_ASSIGNED",
  "JOB_FIELD_WRITE_ASSIGNED",
  "EVIDENCE_UPLOAD_ASSIGNED",
  "JOB_COMPLETE_ASSIGNED",
] as const satisfies readonly Permission[];

const rolePermissions: Readonly<Record<Role, ReadonlySet<Permission>>> = {
  OWNER: new Set<Permission>([
    "ORGANIZATION_MANAGE",
    "MEMBERSHIP_MANAGE",
    ...officeReadPermissions,
    ...officeWritePermissions,
    ...assignedFieldPermissions,
  ]),
  ADMIN: new Set<Permission>([
    "ORGANIZATION_MANAGE",
    "MEMBERSHIP_MANAGE",
    ...officeReadPermissions,
    ...officeWritePermissions,
    ...assignedFieldPermissions,
  ]),
  MANAGER: new Set<Permission>([
    ...officeReadPermissions,
    ...officeWritePermissions,
    ...assignedFieldPermissions,
  ]),
  DISPATCHER: new Set<Permission>([
    ...officeReadPermissions,
    "CUSTOMER_WRITE",
    "PROPERTY_WRITE",
    "SERVICE_REQUEST_WRITE",
    "TRIAGE_APPROVE",
    "SCHEDULE_APPROVE",
    "PROOF_SEND",
    "OUTCOME_VERIFY",
    "RESERVICE_CREATE",
    "EXCEPTION_MANAGE",
  ]),
  TECHNICIAN: new Set<Permission>(assignedFieldPermissions),
  READ_ONLY: new Set<Permission>(officeReadPermissions),
};

const permissionsRequiringAssignment = new Set<Permission>(
  assignedFieldPermissions,
);

export function permissionsForRole(role: unknown): readonly Permission[] {
  const parsed = RoleSchema.safeParse(role);
  if (!parsed.success) return [];
  return [...rolePermissions[parsed.data]].sort();
}

export function permissionRequiresAssignedTechnician(
  permission: unknown,
): boolean {
  const parsed = PermissionSchema.safeParse(permission);
  return (
    parsed.success && permissionsRequiringAssignment.has(parsed.data)
  );
}

export function authorize(
  contextInput: unknown,
  requestInput: unknown,
): AuthorizationDecision {
  const context = MembershipAuthorizationContextSchema.safeParse(contextInput);
  if (!context.success) {
    return deny("INVALID_CONTEXT", "Authorization context is invalid.");
  }

  const request = AuthorizationRequestSchema.safeParse(requestInput);
  if (!request.success) {
    return deny("INVALID_REQUEST", "Authorization request is invalid.");
  }

  if (context.data.status !== "ACTIVE") {
    return deny("MEMBERSHIP_DISABLED", "The organization membership is disabled.");
  }

  if (context.data.organizationId !== request.data.organizationId) {
    return deny("TENANT_MISMATCH", "The resource is outside the active organization.");
  }

  if (!rolePermissions[context.data.role].has(request.data.permission)) {
    return deny(
      "PERMISSION_DENIED",
      "The active role does not grant this permission.",
    );
  }

  if (permissionsRequiringAssignment.has(request.data.permission)) {
    if (
      !context.data.technicianId ||
      !request.data.assignedTechnicianId ||
      context.data.technicianId !== request.data.assignedTechnicianId
    ) {
      return deny(
        "ASSIGNED_TECHNICIAN_REQUIRED",
        "This field action requires the active user to be the assigned technician.",
      );
    }
  }

  return {
    allowed: true,
    code: "ALLOWED",
    reason: "The active membership grants this permission.",
    role: context.data.role,
    permission: request.data.permission,
  };
}

export function requireAuthorization(
  contextInput: unknown,
  requestInput: unknown,
): asserts contextInput is MembershipAuthorizationContext {
  const decision = authorize(contextInput, requestInput);
  if (!decision.allowed) {
    throw new AuthorizationError(decision.code, decision.reason);
  }
}

export class AuthorizationError extends Error {
  constructor(
    readonly code: AuthorizationDenialCode,
    message: string,
  ) {
    super(message);
    this.name = "AuthorizationError";
  }
}

function deny(
  code: AuthorizationDenialCode,
  reason: string,
): AuthorizationDecision {
  return { allowed: false, code, reason };
}
