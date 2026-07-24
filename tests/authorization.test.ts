import { describe, expect, it } from "vitest";
import {
  AuthorizationError,
  authorize,
  permissionRequiresAssignedTechnician,
  permissionsForRole,
  requireAuthorization,
} from "../packages/domain/authorization";

const activeOwner = {
  organizationId: "ORG-A",
  userId: "USER-OWNER",
  role: "OWNER",
  status: "ACTIVE",
  technicianId: null,
} as const;

const activeTechnician = {
  organizationId: "ORG-A",
  userId: "USER-TECH-1",
  role: "TECHNICIAN",
  status: "ACTIVE",
  technicianId: "TECH-1",
} as const;

describe("default-deny role authorization", () => {
  it("returns no permissions for an unknown role", () => {
    expect(permissionsForRole("SUPERUSER")).toEqual([]);
    expect(permissionsForRole(null)).toEqual([]);
  });

  it("grants only explicit read permissions to read-only memberships", () => {
    const permissions = permissionsForRole("READ_ONLY");
    expect(permissions).toContain("CUSTOMER_READ");
    expect(permissions).toContain("JOB_READ_ALL");
    expect(permissions).toContain("AUDIT_READ");
    expect(permissions).not.toContain("CUSTOMER_WRITE");
    expect(permissions).not.toContain("OUTCOME_VERIFY");
    expect(permissions).not.toContain("JOB_FIELD_WRITE_ASSIGNED");
  });

  it("does not grant field-write permissions to dispatchers", () => {
    const permissions = permissionsForRole("DISPATCHER");
    expect(permissions).toContain("SCHEDULE_APPROVE");
    expect(permissions).toContain("OUTCOME_VERIFY");
    expect(permissions).not.toContain("EVIDENCE_UPLOAD_ASSIGNED");
    expect(permissions).not.toContain("JOB_COMPLETE_ASSIGNED");
  });

  it("does not grant technicians tenant-wide customer or economics reads", () => {
    const permissions = permissionsForRole("TECHNICIAN");
    expect(permissions).toContain("JOB_READ_ASSIGNED");
    expect(permissions).not.toContain("CUSTOMER_READ");
    expect(permissions).not.toContain("JOB_READ_ALL");
    expect(permissions).not.toContain("ECONOMICS_READ");
  });

  it("rejects unknown permissions instead of treating them as extensions", () => {
    expect(
      authorize(activeOwner, {
        organizationId: "ORG-A",
        permission: "DATABASE_ADMIN",
      }),
    ).toMatchObject({ allowed: false, code: "INVALID_REQUEST" });
  });

  it("rejects extra authority fields through strict schemas", () => {
    expect(
      authorize(
        { ...activeOwner, impersonatedRole: "OWNER" },
        {
          organizationId: "ORG-A",
          permission: "CUSTOMER_READ",
        },
      ),
    ).toMatchObject({ allowed: false, code: "INVALID_CONTEXT" });
    expect(
      authorize(activeOwner, {
        organizationId: "ORG-A",
        permission: "CUSTOMER_READ",
        bypassTenantCheck: true,
      }),
    ).toMatchObject({ allowed: false, code: "INVALID_REQUEST" });
  });
});

describe("membership and tenant boundaries", () => {
  it("allows a permission explicitly granted to the active role", () => {
    expect(
      authorize(activeOwner, {
        organizationId: "ORG-A",
        permission: "MEMBERSHIP_MANAGE",
      }),
    ).toMatchObject({
      allowed: true,
      code: "ALLOWED",
      role: "OWNER",
      permission: "MEMBERSHIP_MANAGE",
    });
  });

  it("rejects disabled memberships before evaluating role permissions", () => {
    expect(
      authorize(
        { ...activeOwner, status: "DISABLED" },
        {
          organizationId: "ORG-A",
          permission: "CUSTOMER_READ",
        },
      ),
    ).toMatchObject({ allowed: false, code: "MEMBERSHIP_DISABLED" });
  });

  it("rejects a resource in another organization", () => {
    expect(
      authorize(activeOwner, {
        organizationId: "ORG-B",
        permission: "CUSTOMER_READ",
      }),
    ).toMatchObject({ allowed: false, code: "TENANT_MISMATCH" });
  });

  it("rejects a valid permission that the role does not grant", () => {
    expect(
      authorize(
        { ...activeTechnician, role: "READ_ONLY" },
        {
          organizationId: "ORG-A",
          permission: "OUTCOME_VERIFY",
        },
      ),
    ).toMatchObject({ allowed: false, code: "PERMISSION_DENIED" });
  });
});

describe("assigned-technician guard", () => {
  it.each([
    "JOB_READ_ASSIGNED",
    "JOB_FIELD_WRITE_ASSIGNED",
    "EVIDENCE_UPLOAD_ASSIGNED",
    "JOB_COMPLETE_ASSIGNED",
  ])("%s requires the exact assigned technician", (permission) => {
    expect(permissionRequiresAssignedTechnician(permission)).toBe(true);
    expect(
      authorize(activeTechnician, {
        organizationId: "ORG-A",
        permission,
        assignedTechnicianId: "TECH-1",
      }),
    ).toMatchObject({ allowed: true });
    expect(
      authorize(activeTechnician, {
        organizationId: "ORG-A",
        permission,
        assignedTechnicianId: "TECH-2",
      }),
    ).toMatchObject({
      allowed: false,
      code: "ASSIGNED_TECHNICIAN_REQUIRED",
    });
  });

  it("rejects assignment-scoped work when either technician is missing", () => {
    expect(
      authorize(activeTechnician, {
        organizationId: "ORG-A",
        permission: "EVIDENCE_UPLOAD_ASSIGNED",
      }),
    ).toMatchObject({
      allowed: false,
      code: "ASSIGNED_TECHNICIAN_REQUIRED",
    });
    expect(
      authorize(activeOwner, {
        organizationId: "ORG-A",
        permission: "JOB_COMPLETE_ASSIGNED",
        assignedTechnicianId: "TECH-1",
      }),
    ).toMatchObject({
      allowed: false,
      code: "ASSIGNED_TECHNICIAN_REQUIRED",
    });
  });

  it("does not let office permission bypass assignment checks", () => {
    expect(
      authorize(
        { ...activeOwner, technicianId: "TECH-9" },
        {
          organizationId: "ORG-A",
          permission: "EVIDENCE_UPLOAD_ASSIGNED",
          assignedTechnicianId: "TECH-1",
        },
      ),
    ).toMatchObject({
      allowed: false,
      code: "ASSIGNED_TECHNICIAN_REQUIRED",
    });
  });

  it("throws a typed error when an assertion guard denies access", () => {
    expect(() =>
      requireAuthorization(activeTechnician, {
        organizationId: "ORG-B",
        permission: "JOB_READ_ASSIGNED",
        assignedTechnicianId: "TECH-1",
      }),
    ).toThrowError(AuthorizationError);
    try {
      requireAuthorization(activeTechnician, {
        organizationId: "ORG-B",
        permission: "JOB_READ_ASSIGNED",
        assignedTechnicianId: "TECH-1",
      });
    } catch (error) {
      expect(error).toMatchObject({ code: "TENANT_MISMATCH" });
    }
  });
});
