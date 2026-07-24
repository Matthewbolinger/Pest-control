import { env } from "cloudflare:workers";
import {
  contextDenied,
  getRequestContext,
} from "@/app/api/v1/request-context";

export async function GET(request: Request) {
  const correlationId = crypto.randomUUID();
  try {
    const resolution = await getRequestContext(request, env.DB);
    if (!resolution.context) return contextDenied(resolution, correlationId);
    const context = resolution.context;
    return Response.json({
      data: {
        user: {
          id: context.actorId,
          email: context.actorEmail,
          displayName: context.actorDisplayName,
        },
        membership: {
          organizationId: context.organizationId,
          organizationName: context.organizationName,
          role: context.role,
          technicianId: context.technicianId,
          permissions: context.permissions,
        },
        autonomyLevel: context.autonomyLevel,
        isLocalDemo: context.isLocalDemo,
      },
      correlationId,
    });
  } catch {
    return Response.json(
      {
        error: {
          code: "IDENTITY_UNAVAILABLE",
          message: "The authenticated membership could not be resolved.",
          correlationId,
        },
      },
      { status: 503 },
    );
  }
}
