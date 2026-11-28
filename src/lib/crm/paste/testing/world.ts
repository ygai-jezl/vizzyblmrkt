import type { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import type { TenantContext } from "@/lib/tenant/types";
import { readFieldList, saveFieldListChange } from "@/lib/audience/fieldList";
import type { FieldType, RecordFieldObject } from "@/lib/types/recordField";

/** Made-up field ids for the paste tests (`fld_` and 12 characters). */
export const F = {
  stage: "fld_00000000stag",
  hq: "fld_000000000fhq",
  leads: "fld_00000000lead",
  title: "fld_0000000ptitl",
  notes: "fld_00000000note",
  notes2: "fld_0000000note2",
  notes3: "fld_0000000note3",
} as const;

/** Add a field to a brand's list, as Settings › Data model would, with options numbered opt_000000NN. */
export async function addField(
  ctx: TenantContext,
  db: FakeFirestore,
  object: RecordFieldObject,
  key: string,
  label: string,
  type: FieldType,
  options?: string[],
): Promise<void> {
  const list = await readFieldList(ctx, object, db);
  let n = 0;
  const saved = await saveFieldListChange(
    ctx,
    object,
    {
      baseRev: list.rev,
      change: { op: "add", label, type, ...(options ? { options } : {}) },
      by: { type: "member", id: "usr_1" },
      newFieldId: () => key,
      newOptionId: () => `opt_${key.slice(-4)}${String(n++).padStart(4, "0")}`,
    },
    db,
  );
  if (!saved.ok) throw new Error(saved.error);
}

/** The option id addField gives a field's nth option. */
export function optionId(key: string, n: number): string {
  return `opt_${key.slice(-4)}${String(n).padStart(4, "0")}`;
}
