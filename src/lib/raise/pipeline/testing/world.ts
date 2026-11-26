import { readFieldList } from "@/lib/audience/fieldList";
import { setFieldValues } from "@/lib/audience/fields";
import { deterministicContactId } from "@/lib/crm/identifiers";
import type { TenantContext } from "@/lib/tenant/types";
import type { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import { raiseFieldsOf, type RaiseFields } from "../fields";
import type { RaiseKit } from "../presets";
import { applyRaiseSetup } from "../setup";

/**
 * For tests only: a brand set up for raising (or funding) on a FakeFirestore, and people put on its
 * board through the one field writer, so their tags and events are real. Made-up people at
 * example.com only.
 */

export interface BoardPerson {
  email: string;
  first?: string;
  last?: string;
  /** A Stage option's preset, such as "contacted". */
  stage?: string;
  firm?: string;
  /** A Tier option's preset: "a", "b" or "c". */
  tier?: string;
  lastTouch?: string;
  nextStepDate?: string;
  /** A Pass reason option's preset (a reason key). */
  reason?: string;
  /** When they were last active, for the list's order. */
  activeAt?: string;
  /** Left out of Everyone: no field tags. */
  outside?: boolean;
}

export interface BoardWorld {
  ctx: TenantContext;
  rf: RaiseFields;
  ids: { stage: string; passReason: string; firm: string; tier: string; lastTouch: string; nextStepDate: string };
  /** A Stage option's id by its preset. */
  stage: (preset: string) => string;
  /** A Pass reason option's id by its key. */
  reason: (key: string) => string;
  add: (p: BoardPerson) => Promise<string>;
  refresh: () => Promise<RaiseFields>;
}

let counter = 0;

export async function boardWorld(db: FakeFirestore, opts: { ctx?: TenantContext; kit?: RaiseKit; currency?: string } = {}): Promise<BoardWorld> {
  const ctx: TenantContext = opts.ctx ?? { tenantId: "ten_a", region: "us", source: "idtoken", userId: "u_admin", role: "admin" };
  const by = { type: "member" as const, id: ctx.userId ?? "u_admin" };
  const set = await applyRaiseSetup(ctx, { kit: opts.kit ?? "raising", currency: opts.currency ?? "GBP", by }, db);
  if (!set.ok) throw new Error(set.error);
  let rf = raiseFieldsOf((await readFieldList(ctx, "person", db)).items);
  const key = (p: keyof RaiseFields["byPreset"]) => rf.byPreset[p]!.key;
  const ids = {
    stage: key("raise.stage"),
    passReason: key("raise.pass_reason"),
    firm: key("raise.firm"),
    tier: key("raise.tier"),
    lastTouch: key("raise.last_touch"),
    nextStepDate: key("raise.next_step_date"),
  };
  const stage = (preset: string) => rf.stage!.options.find((o) => o.preset === preset)!.optionId;
  const reason = (k: string) => rf.passReason!.options.find((o) => o.key === k)!.optionId;
  const tier = (preset: string) => rf.byPreset["raise.tier"]!.options!.find((o) => o.preset === preset)!.id;
  return {
    ctx,
    get rf() {
      return rf;
    },
    ids,
    stage,
    reason,
    refresh: async () => (rf = raiseFieldsOf((await readFieldList(ctx, "person", db)).items)),
    add: async (p) => {
      const id = deterministicContactId(ctx.tenantId, p.email);
      counter += 1;
      const activeAt = p.activeAt ?? new Date(Date.UTC(2026, 10, 1) + counter * 1000).toISOString();
      db.seed("contacts", id, {
        tenantId: ctx.tenantId,
        contactKey: p.email,
        email: p.email,
        ...(p.first ? { firstName: p.first } : {}),
        ...(p.last ? { lastName: p.last } : {}),
        memberOf: p.outside ? [] : ["all"],
        activeAt,
        sortKey: `${activeAt}|${id}`,
      });
      const changes: Record<string, unknown> = {};
      if (p.stage) changes[ids.stage] = stage(p.stage);
      if (p.firm) changes[ids.firm] = p.firm;
      if (p.tier) changes[ids.tier] = tier(p.tier);
      if (p.lastTouch) changes[ids.lastTouch] = p.lastTouch;
      if (p.nextStepDate) changes[ids.nextStepDate] = p.nextStepDate;
      if (p.reason) changes[ids.passReason] = reason(p.reason);
      if (Object.keys(changes).length) {
        const r = await setFieldValues(ctx, { object: "person", recordId: id, changes, by, source: "editor" }, { db });
        if (!r.ok) throw new Error(`${r.error}:${r.fieldId ?? ""}:${r.reason ?? ""}`);
      }
      return id;
    },
  };
}
