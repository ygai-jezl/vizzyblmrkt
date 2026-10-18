import { readBrandMap } from "@/lib/brandMap/store";
import { isBrandMapEnabled, isBrandMapScaleEnabled } from "@/lib/brandMap/flags";
import { brandMapRecords } from "@/lib/tenant/brandMapRecords";
import type { FirestoreLike, TenantContext } from "@/lib/tenant/types";
import { isMapSaved } from "@/lib/types/brandMap";

/** A brand map subject a note can be about. */
export interface NoteSubject {
  id: string;
  name: string;
}

/** At most this many subjects are offered on the page (the map holds no fixed number). */
const MAX = 5000;

/**
 * The decided subjects on the brand's saved map, for linking notes to them and showing what the
 * notes cover. Null when there is no saved map (or its switch is off): the page then shows no
 * coverage. At any size the subjects are read from their records, names only.
 */
export async function subjectsForNotes(ctx: TenantContext, db?: FirestoreLike): Promise<NoteSubject[] | null> {
  if (!isBrandMapEnabled()) return null;
  const read = await readBrandMap(ctx, db).catch(() => null);
  if (!read || read.state !== "ok" || !isMapSaved(read.map)) return null;
  if (isBrandMapScaleEnabled() && read.map.moved) {
    const rows = await brandMapRecords(ctx, db)
      .pageAll("sub", { where: [["status", "==", "decided"]], fields: ["name"], maxPages: 20 })
      .catch(() => []);
    return rows
      .map((r) => {
        const name = (r as unknown as { name?: unknown }).name;
        return { id: r.id, name: typeof name === "string" ? name : "" };
      })
      .filter((s) => s.name)
      .slice(0, MAX);
  }
  return read.map.subjects.map((s) => ({ id: s.id, name: s.name })).slice(0, MAX);
}
