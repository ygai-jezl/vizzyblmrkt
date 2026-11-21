import { lifecycleAdmin, type AdminGate } from "@/lib/connect/admin";
import { getAdminContext } from "@/lib/auth/session";
import { sameOriginGuard } from "@/lib/http/sameOrigin";
import { isOneViewEnabled, isPersonViewEnabled } from "./flags";
import { isAddPersonEnabled, isFieldsEnabled, isTimelineEnabled } from "./peopleFlags";

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

/**
 * Gate for the one view's admin APIs (AUDIENCE_ONE_VIEW_ENABLED): off = they don't exist.
 * Same origin, an admin session, and the admin role for anything that changes or exports a
 * person. Unlike the person view it doesn't need connected products: a brand with only
 * launches has people too.
 */
export async function oneViewAdmin(req: Request, opts: { mutate: boolean }): Promise<AdminGate> {
  const json = (status: number, body: unknown) => Response.json(body, { status, headers: { "cache-control": "no-store" } });
  if (!isOneViewEnabled()) return { ok: false, response: json(404, { error: "not_found" }) };
  const blocked = sameOriginGuard(req);
  if (blocked) return { ok: false, response: blocked };
  const ctx = await getAdminContext();
  if (!ctx) return { ok: false, response: json(401, { error: "unauthorized" }) };
  if (opts.mutate && ctx.role !== "admin") return { ok: false, response: json(403, { error: "forbidden" }) };
  return { ok: true, ctx };
}

/** oneViewAdmin's order for a piece B switch: the switch (off = the route doesn't exist), same origin, a session, then the admin role for a change. */
async function switchedAdmin(on: boolean, req: Request, opts: { mutate: boolean }): Promise<AdminGate> {
  const json = (status: number, body: unknown) => Response.json(body, { status, headers: { "cache-control": "no-store" } });
  if (!on) return { ok: false, response: json(404, { error: "not_found" }) };
  const blocked = sameOriginGuard(req);
  if (blocked) return { ok: false, response: blocked };
  const ctx = await getAdminContext();
  if (!ctx) return { ok: false, response: json(401, { error: "unauthorized" }) };
  if (opts.mutate && ctx.role !== "admin") return { ok: false, response: json(403, { error: "forbidden" }) };
  return { ok: true, ctx };
}

/**
 * Gate for the fields APIs (AUDIENCE_FIELDS_ENABLED), in oneViewAdmin's order: the switch (off =
 * they don't exist), same origin, a session, and the admin role for any change. Members can read
 * the field lists and values.
 */
export async function fieldsAdmin(req: Request, opts: { mutate: boolean }): Promise<AdminGate> {
  return switchedAdmin(isFieldsEnabled(), req, opts);
}

/**
 * Gate for New person and recording consent (AUDIENCE_ADD_PERSON_ENABLED): admins only, in
 * oneViewAdmin's order (decision 28).
 */
export async function addPersonAdmin(req: Request): Promise<AdminGate> {
  return switchedAdmin(isAddPersonEnabled(), req, { mutate: true });
}

/** Gate for a person's timeline (AUDIENCE_TIMELINE_ENABLED): anyone on the team can read it. */
export async function timelineAdmin(req: Request): Promise<AdminGate> {
  return switchedAdmin(isTimelineEnabled(), req, { mutate: false });
}
