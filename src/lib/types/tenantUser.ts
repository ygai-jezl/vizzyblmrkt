import { z } from "zod";

/**
 * Tenant ↔ user association ("collaborator"). Lives in the flat root-level
 * `tenant_users` collection so the portal can list all brands a user can access
 * in a single query (where userId == uid). Carries `tenantId` so the same
 * collection is also tenant-scopeable (list members of a brand).
 */
export const TenantRole = z.enum(["admin", "member"]);
export type TenantRole = z.infer<typeof TenantRole>;

export const TenantUserSchema = z.object({
  id: z.string(),
  userId: z.string(),
  tenantId: z.string(),
  role: TenantRole,
  joinedAt: z.string(),
});

export type TenantUser = z.infer<typeof TenantUserSchema>;
