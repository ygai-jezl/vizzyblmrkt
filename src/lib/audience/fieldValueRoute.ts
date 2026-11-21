import { NextResponse } from "next/server";
import { z } from "zod";
import { fieldsAdmin } from "./admin";
import { setFieldValues } from "./fields";
import { isPersonId } from "./paths";
import { FIELD_LIMITS, type RecordFieldObject } from "@/lib/types/recordField";
import type { SetFieldValuesError } from "@/lib/tenant";

/**
 * The value routes for a person and a company (AUDIENCE_FIELDS_ENABLED): PATCH `{ changes:
 * { <fieldId>: value | null } }`, admins only. Every change goes through the one writer.
 */

const noStore = { "cache-control": "no-store" };
const Body = z.object({ changes: z.record(z.string().max(64), z.unknown()) }).strict();

const STATUS: Record<SetFieldValuesError, number> = {
  not_found: 404,
  unknown_field: 400,
  archived_field: 400,
  invalid_value: 400,
  record_too_large: 400,
  stale: 409,
  agent_action_not_found: 404,
  agent_action_wrong_state: 409,
  agent_action_changed: 409,
};

export async function patchFieldValues(req: Request, object: RecordFieldObject, recordId: string): Promise<Response> {
  const gate = await fieldsAdmin(req, { mutate: true });
  if (!gate.ok) return gate.response;
  if (!isPersonId(recordId)) return NextResponse.json({ error: "not_found" }, { status: 404, headers: noStore });
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success || Object.keys(parsed.data.changes).length > FIELD_LIMITS.liveFields) {
    return NextResponse.json({ error: "invalid_input" }, { status: 400, headers: noStore });
  }
  const r = await setFieldValues(gate.ctx, {
    object,
    recordId,
    changes: parsed.data.changes,
    by: { type: "member", id: gate.ctx.userId ?? null },
    source: "editor",
  });
  if (!r.ok) {
    return NextResponse.json(
      { error: r.error, ...(r.fieldId ? { fieldId: r.fieldId } : {}), ...(r.reason ? { reason: r.reason } : {}) },
      { status: STATUS[r.error], headers: noStore },
    );
  }
  return NextResponse.json({ values: r.values, changed: r.changed }, { headers: noStore });
}
