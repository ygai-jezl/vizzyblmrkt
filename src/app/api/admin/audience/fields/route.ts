import { NextResponse } from "next/server";
import { z } from "zod";
import { fieldsAdmin } from "@/lib/audience/admin";
import { FIELD_LIST_STATUS, FieldListChangeSchema, readFieldList, saveFieldListChange } from "@/lib/audience/fieldList";
import { forTenant, type TenantContext } from "@/lib/tenant";
import { teamMemberNames } from "@/lib/team/names";
import { isRecordFieldObject, RECORD_FIELD_OBJECTS } from "@/lib/types/recordField";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const noStore = { "cache-control": "no-store" };

/** The brand's team now, by name, for team member fields: only the brand's own team sees it. */
async function team(ctx: TenantContext): Promise<Array<{ id: string; name: string }>> {
  const members = await forTenant(ctx).members.find({ limit: 200 }).catch(() => []);
  const names = await teamMemberNames(ctx, members.map((m) => m.userId));
  return Object.entries(names)
    .map(([id, name]) => ({ id, name }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Settings › Data model (AUDIENCE_FIELDS_ENABLED): the People and Company field lists, each with
 * the rev a change names, and the team for team member fields. Members can read.
 */
export async function GET(req: Request) {
  const gate = await fieldsAdmin(req, { mutate: false });
  if (!gate.ok) return gate.response;
  const [person, company, people] = await Promise.all([readFieldList(gate.ctx, "person"), readFieldList(gate.ctx, "company"), team(gate.ctx)]);
  return NextResponse.json({ lists: { person, company }, team: people }, { headers: noStore });
}

const Body = z.object({
  object: z.enum(RECORD_FIELD_OBJECTS),
  baseRev: z.number().int().min(0),
  change: FieldListChangeSchema,
  message: z.string().max(200).nullable().optional(),
});

async function change(req: Request, adding: boolean) {
  const gate = await fieldsAdmin(req, { mutate: true });
  if (!gate.ok) return gate.response;
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success || !isRecordFieldObject(parsed.data.object) || (parsed.data.change.op === "add") !== adding) {
    return NextResponse.json({ error: "invalid_input" }, { status: 400, headers: noStore });
  }
  const { object, baseRev, change: c, message } = parsed.data;
  const r = await saveFieldListChange(gate.ctx, object, { baseRev, change: c, message, by: { type: "member", id: gate.ctx.userId ?? null } });
  if (!r.ok) return NextResponse.json({ error: r.error, ...(r.list ? { list: r.list } : {}) }, { status: FIELD_LIST_STATUS[r.error], headers: noStore });
  return NextResponse.json({ list: r.list, message: r.message }, { headers: noStore });
}

/** Add a field. Admins only. */
export async function POST(req: Request) {
  return change(req, true);
}

/** Rename, reorder, add or change an option, archive, restore or change a field's type. Admins only. */
export async function PATCH(req: Request) {
  return change(req, false);
}
