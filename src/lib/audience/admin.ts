import { lifecycleAdmin, type AdminGate } from "@/lib/connect/admin";
import { isPersonViewEnabled } from "./flags";

/**
 * Gate for the person view's admin APIs: its flag (off = these routes don't exist),
 * then the Products gate — same origin, an admin session, and the admin role for
 * anything that changes or exports a person's data.
 */
export async function personViewAdmin(req: Request, opts: { mutate: boolean }): Promise<AdminGate> {
  if (!isPersonViewEnabled()) {
    return { ok: false, response: Response.json({ error: "not_found" }, { status: 404, headers: { "cache-control": "no-store" } }) };
  }
  return lifecycleAdmin(req, opts);
}
