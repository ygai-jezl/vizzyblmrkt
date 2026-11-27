import { NextResponse } from "next/server";
import { z } from "zod";
import { fieldsAdmin } from "./admin";
import { setFieldValues } from "./fields";
import { isPersonId } from "./paths";
import { FIELD_LIMITS, type RecordFieldObject } from "@/lib/types/recordField";
import type { SetFieldValuesError } from "@/lib/tenant";
import { isRaiseFollowupsEnabled } from "@/lib/raise/pipeline/flags";

/**
 * The value routes for a person and a company (AUDIENCE_FIELDS_ENABLED): PATCH `{ changes:
 * { <fieldId>: value | null } }`, admins only. Every change goes through the one writer. A change to
 * a person's Stage, Last touch or Next step date clears their open follow-ups from the investor and
 * funding board at once (RAISE_FOLLOWUPS_ENABLED; off, nothing more is read).
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
  const by = { type: "member" as const, id: gate.ctx.userId ?? null };
  const r = await setFieldValues(gate.ctx, {
    object,
    recordId,
    changes: parsed.data.changes,
    by,
    source: "editor",
  });
  if (!r.ok) {
    return NextResponse.json(
      { error: r.error, ...(r.fieldId ? { fieldId: r.fieldId } : {}), ...(r.reason ? { reason: r.reason } : {}) },
      { status: STATUS[r.error], headers: noStore },
    );
  }
  if (object === "person" && r.changed.length && isRaiseFollowupsEnabled()) {
    // Never throws: the value is saved whatever happens to the follow-ups, and the tick catches up.
    await import("@/lib/raise/pipeline/followups")
      .then((m) => m.clearFollowUpsAfterWrite(gate.ctx, recordId, r.changed, by))
      .catch(() => null);
  }
  return NextResponse.json({ values: r.values, changed: r.changed }, { headers: noStore });
}
