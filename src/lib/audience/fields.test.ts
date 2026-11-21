import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import { forTenant } from "@/lib/tenant";
import type { TenantContext } from "@/lib/tenant/types";
import { deterministicContactId } from "@/lib/crm/identifiers";
import type { RecordField } from "@/lib/types/recordField";
import { saveFieldListChange } from "./fieldList";
import { labelledValues, setFieldValues, valueText } from "./fields";

const ctx: TenantContext = { tenantId: "ten_A", region: "eu", source: "idtoken", role: "admin", userId: "u_admin" };
const by = { type: "member", id: "u_admin" } as const;
const T0 = "2026-11-21T09:00:00.000Z";
const PERSON = deterministicContactId("ten_A", "sam@example.com");
const OWNER = "fld_000000000001";

describe("setFieldValues", () => {
  it("lets a team member value name only someone on the team now", async () => {
    const db = new FakeFirestore();
    await saveFieldListChange(ctx, "person", { baseRev: 0, change: { op: "add", label: "Owner", type: "team_member" }, by, nowIso: T0, newFieldId: () => OWNER }, db);
    db.seed("contacts", PERSON, { tenantId: "ten_A", contactKey: "sam@example.com" });
    db.seed("tenant_users", "m1", { tenantId: "ten_A", userId: "u_alex", role: "member" });
    db.seed("tenant_users", "m2", { tenantId: "ten_B", userId: "u_other", role: "admin" });
    const set = (v: string) => setFieldValues(ctx, { object: "person", recordId: PERSON, changes: { [OWNER]: v }, by, source: "editor" }, { db });
    expect(await set("u_other")).toMatchObject({ ok: false, error: "invalid_value", reason: "not_on_team" });
    expect(await set("u_alex")).toMatchObject({ ok: true, outcome: "updated" });
    expect((await forTenant(ctx, db).contacts.getById(PERSON))?.fields).toEqual({ [OWNER]: "u_alex" });
  });
});

describe("values in words", () => {
  const AT = "2026-11-21T10:00:00.000Z";
  const fields: RecordField[] = [
    { key: "fld_000000000001", label: "Plan", type: "select", object: "person", options: [{ id: "opt_00000001", label: "Pro" }], createdAt: AT, createdBy: null },
    { key: "fld_000000000002", label: "Old segment", type: "text", object: "person", archivedAt: AT, createdAt: AT, createdBy: null },
    { key: "fld_000000000003", label: "Price", type: "currency", currency: "GBP", object: "person", createdAt: AT, createdBy: null },
  ];

  it("labels each value, marks archived ones and keeps values the list has lost", () => {
    expect(labelledValues(fields, { fld_000000000001: "opt_00000001", fld_000000000002: "B2B", fld_000000000003: 1250, fld_000000000009: "kept" })).toEqual([
      { fieldId: "fld_000000000001", label: "Plan", type: "select", typeLabel: "select", archived: false, value: "opt_00000001", text: "Pro" },
      { fieldId: "fld_000000000002", label: "Old segment", type: "text", typeLabel: "text", archived: true, value: "B2B", text: "B2B" },
      { fieldId: "fld_000000000003", label: "Price", type: "currency", typeLabel: "currency", archived: false, value: 1250, text: "12.50 GBP" },
      { fieldId: "fld_000000000009", label: "Unknown field", type: "text", typeLabel: "text", archived: true, value: "kept", text: "kept" },
    ]);
    expect(valueText({ type: "checkbox" }, false)).toBe("No");
  });

  it("shows an amount in its currency's own units", () => {
    expect(valueText({ type: "currency", currency: "JPY" }, 1000)).toBe("1000 JPY");
    expect(valueText({ type: "currency", currency: "KWD" }, 1250)).toBe("1.250 KWD");
  });
});

// --- Only the one writer writes field values ---------------------------------------------------

const ROOT = process.cwd();
const WRITER = "src/lib/tenant/recordFieldWrites.ts";

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) sourceFiles(p, out);
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(relative(ROOT, p));
  }
  return out;
}

/** The code without its comments, so prose that names the path never counts. */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/** A dotted update path into a record's fields: `"fields.<id>"` or `` `fields.${id}` ``. */
const DOTTED = /["'`]fields\.(\$\{|[A-Za-z_])/;
/** A write to a contact or company, up to its closing bracket. */
const WRITE_CALL = /\.(contacts|companies)\.(update|create|upsert|set)\(/g;

function writeCalls(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(WRITE_CALL)) {
    let depth = 0;
    const start = (m.index ?? 0) + m[0].length - 1;
    for (let k = start; k < text.length; k++) {
      if (text[k] === "(") depth++;
      else if (text[k] === ")" && --depth === 0) {
        out.push(text.slice(start, k + 1));
        break;
      }
    }
  }
  return out;
}

function fieldWriteProblems(file: string, text: string): string[] {
  if (file === WRITER) return [];
  const c = code(text);
  const problems: string[] = [];
  if (DOTTED.test(c)) problems.push(`${file}: writes a dotted fields path; only ${WRITER} writes field values`);
  if (writeCalls(c).some((call) => /\bfields\s*:/.test(call))) problems.push(`${file}: writes fields on a contact or company; only ${WRITER} writes field values`);
  return problems;
}

describe("the one writer", () => {
  it("is the only code that writes field values", () => {
    const problems = sourceFiles(join(ROOT, "src")).flatMap((file) => fieldWriteProblems(file, readFileSync(join(ROOT, file), "utf8")));
    expect(problems).toEqual([]);
  });

  it("catches a dotted path or a fields key in a write elsewhere", () => {
    expect(fieldWriteProblems("src/lib/x.ts", "await tx.update(ref, { [`fields.${id}`]: 1 });")).toHaveLength(1);
    expect(fieldWriteProblems("src/lib/x.ts", 'await repo.contacts.update(id, { name, fields: { a: 1 } });')).toHaveLength(1);
    expect(fieldWriteProblems("src/lib/x.ts", "// values sit under `fields.${id}`\nawait repo.contacts.update(id, { name });")).toEqual([]);
    expect(fieldWriteProblems(WRITER, "patch[`fields.${fieldId}`] = v;")).toEqual([]);
  });
});
