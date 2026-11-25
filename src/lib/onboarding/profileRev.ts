import type { TenantContext } from "@/lib/tenant/types";

/**
 * What the chat proxy sends Vizzy as `profileRev` (digits only, for the `[ctx:]` envelope): the
 * profile's rev, then 1 for an admin's view or 0 for anyone else's (answers only). Vizzy caches
 * the profile block by it (agents/root_agent/context/business_profile.py), so a person whose role
 * changes reads the view again at once. "" with no profile.
 */
export function profileRevFor(profile: { rev?: number } | null | undefined, role: TenantContext["role"]): string {
  if (!profile) return "";
  const rev = Number.isInteger(profile.rev) && (profile.rev ?? 0) >= 0 ? (profile.rev as number) : 0;
  return `${rev}${role === "admin" ? 1 : 0}`;
}
