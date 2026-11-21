import { NextResponse } from "next/server";
import { z } from "zod";
import { fieldsAdmin } from "@/lib/audience/admin";
import { FIELD_LIST_STATUS, restoreFieldListVersion } from "@/lib/audience/fieldList";
import { byLabel, listSettingsVersions } from "@/lib/settings/history";
import { teamMemberNames } from "@/lib/team/names";
import { FIELD_LIST_SUBJECT, RECORD_FIELD_OBJECTS, type RecordFieldObject } from "@/lib/types/recordField";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const noStore = { "cache-control": "no-store" };

/**
 * Every change to a field list, newest first, a page at a time (`?object=person|company`,
 * `&cursor=` the next page). Who made each one is looked up when shown: someone no longer on the
 * team is "Former team member". Members can read.
 */
export async function GET(req: Request) {
  const gate = await fieldsAdmin(req, { mutate: false });
  if (!gate.ok) return gate.response;
  const url = new URL(req.url);
  const object = (url.searchParams.get("object") ?? "person") as RecordFieldObject;
  const rawCursor = url.searchParams.get("cursor");
  const cursor = rawCursor === null ? null : Number(rawCursor);
  if (!(RECORD_FIELD_OBJECTS as readonly string[]).includes(object) || (cursor !== null && (!Number.isInteger(cursor) || cursor < 1))) {
    return NextResponse.json({ error: "invalid_input" }, { status: 400, headers: noStore });
  }
  const page = await listSettingsVersions(gate.ctx, FIELD_LIST_SUBJECT[object], { cursor });
  const names = await teamMemberNames(
    gate.ctx,
    page.versions.map((v) => (v.by.type === "member" ? v.by.id : null)),
  );
  return NextResponse.json(
    {
      versions: page.versions.map((v) => ({
        rev: v.rev,
        savedAt: v.savedAt,
        by: byLabel(v.by, names),
        message: v.message,
        source: v.source,
        restoredFrom: v.restoredFrom,
        items: v.items.map((i) => ({ key: i.key, label: i.label, change: i.change })),
        moreItems: v.moreItems,
      })),
      nextCursor: page.nextCursor,
    },
    { headers: noStore },
  );
}

const Restore = z.object({ object: z.enum(RECORD_FIELD_OBJECTS), rev: z.number().int().min(1), baseRev: z.number().int().min(0) }).strict();

/** Bring back an earlier version as a new one; fields it didn't have are archived. Admins only. */
export async function POST(req: Request) {
  const gate = await fieldsAdmin(req, { mutate: true });
  if (!gate.ok) return gate.response;
  const parsed = Restore.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid_input" }, { status: 400, headers: noStore });
  const { object, rev, baseRev } = parsed.data;
  const r = await restoreFieldListVersion(gate.ctx, object, { rev, baseRev, by: { type: "member", id: gate.ctx.userId ?? null } });
  if (!r.ok) return NextResponse.json({ error: r.error, ...(r.list ? { list: r.list } : {}) }, { status: FIELD_LIST_STATUS[r.error], headers: noStore });
  return NextResponse.json({ list: r.list, message: r.message }, { headers: noStore });
}
