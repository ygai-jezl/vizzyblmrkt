import { describe, expect, it } from "vitest";
import type { RecordField } from "@/lib/types/recordField";
import { archivedFieldNote, eraseState, historyEraseTargets, offersErase } from "./eraseNotes";
import { dayText, ERASE_COPY } from "./historyWords";

const DAY = 86_400_000;
const NOW = Date.parse("2026-11-26T10:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();
const field = (over: Partial<RecordField>): RecordField => ({ key: "fld_000000000001", label: "Old loyalty tier", type: "text", ...over }) as RecordField;

describe("an archived field's erase in words", () => {
  it("tells everyone when its values are being erased or were erased, and an owner also when they can be", () => {
    const erasing = field({ archivedAt: iso(NOW - 41 * DAY), erasingSince: iso(NOW - DAY) });
    const erased = field({ archivedAt: iso(NOW - 41 * DAY), erasedAt: iso(NOW - 2 * DAY) });
    const young = field({ archivedAt: iso(NOW - 12 * DAY) });
    expect(archivedFieldNote(erasing, false, NOW)).toBe(ERASE_COPY.erasing);
    expect(archivedFieldNote(erased, false, NOW)).toBe(ERASE_COPY.erased(dayText(iso(NOW - 2 * DAY))));
    expect(archivedFieldNote(young, false, NOW)).toBeNull();
    expect(archivedFieldNote(erasing, true, NOW)).toBe(`archived 41 days ago, ${ERASE_COPY.erasing}`);
    expect(archivedFieldNote(young, true, NOW)).toBe(`archived 12 days ago, ${ERASE_COPY.erasableFrom(dayText(iso(NOW + 18 * DAY)))}`);
    // Erased before its latest archive: its values were filled in again, so nothing to say.
    expect(eraseState(field({ archivedAt: iso(NOW - 5 * DAY), erasedAt: iso(NOW - 40 * DAY) }))).toBeNull();
    expect(offersErase(young, NOW)).toBe(false);
    expect(offersErase(erasing, NOW)).toBe(true);
    expect(offersErase(field({ archivedAt: iso(NOW - 41 * DAY) }), NOW)).toBe(true);
    expect(offersErase(erased, NOW)).toBe(false);
  });

  it("offers Erase values on the newest History entry that archived a field whose values can be erased now", () => {
    const tier = field({ archivedAt: iso(NOW - 41 * DAY) });
    const pot = field({ key: "fld_000000000002", label: "Pot colour", archivedAt: iso(NOW - 12 * DAY) });
    const entries = [
      { kind: "fields" as const, subject: "fields:person", rev: 9, archivedKeys: ["fld_000000000002"] },
      { kind: "journeys" as const, subject: "journey:lcj_1", rev: 2, archivedKeys: [] },
      { kind: "fields" as const, subject: "fields:person", rev: 7, archivedKeys: ["fld_000000000001"] },
      { kind: "fields" as const, subject: "fields:person", rev: 4, archivedKeys: ["fld_000000000001"] },
      { kind: "fields" as const, subject: "fields:company", rev: 3, archivedKeys: ["fld_000000000001"] },
    ];
    const targets = historyEraseTargets(entries, { person: { items: [tier, pot] }, company: { items: [] } }, NOW);
    expect([...targets.entries()]).toEqual([["fields:person:7", [{ object: "person", fieldId: "fld_000000000001", label: "Old loyalty tier" }]]]);
  });
});
