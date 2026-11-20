import { forTenant } from "@/lib/tenant";
import type { FirestoreLike, TenantContext } from "@/lib/tenant/types";
import type { ProductConnection } from "@/lib/types/productConnection";
import type { ProductUser } from "@/lib/types/productUser";
import type { Signup } from "@/lib/types/signup";
import { isContactPersonId, type ContactPersonId } from "./person";
import { personIdForProductUser, personIdForSignup } from "./personRef";

/**
 * The backfill for person ids (scripts/backfill-person-ids.ts): writes the person (the `ct_` id)
 * on rows written before ONTOLOGY_PERSON_IDS_ENABLED was on, and corrects rows whose person has
 * moved since (a move made while the switch was off, or a lost repoint). Dry run unless `apply`.
 *
 * Each store is read a page at a time by document id with no other filter, so no composite index
 * is needed and rows without the field are read too. A row is written only when its person is
 * missing (stamped) or different (corrected). A row whose person now resolves to nobody (the
 * product revoked, the user erased, the sign-up gone) keeps what it has and counts as unresolved.
 * Erase rows, rehearsals and a sandbox's rows are skipped. Counts only: never an address or an id.
 */

/** The stores a person id is written on, by their forTenant name, with their collection. */
export const BACKFILL_STORES = {
  productEvents: "product_events",
  lifecycleEnrolments: "lifecycle_enrolments",
  waitlistEnrolments: "waitlist_enrolments",
  personPlans: "person_plans",
  emailSends: "email_sends",
  emailEvents: "email_events",
} as const;
export type BackfillStore = keyof typeof BACKFILL_STORES;

/** A store by its forTenant name or its collection name, or null. */
export function backfillStoreOf(name: string): BackfillStore | null {
  if (name in BACKFILL_STORES) return name as BackfillStore;
  const found = (Object.entries(BACKFILL_STORES) as Array<[BackfillStore, string]>).find(([, collection]) => collection === name);
  return found ? found[0] : null;
}

export interface BackfillCounts {
  scanned: number;
  /** Rows that had no person and get one (in a dry run: would). */
  stamped: number;
  /** Rows whose person was different (in a dry run: would be corrected). */
  corrected: number;
  /** Rows already right. */
  already: number;
  /** Rows whose person resolves to nobody now: left as they are. */
  unresolved: number;
  /** Erase rows, rehearsals and a sandbox's rows. */
  skipped: number;
  /** Rows deleted between the read and the write (also counted in stamped or corrected). */
  gone: number;
  /** Pages that failed: that store stops for this brand, and a run again picks it up. */
  failed: number;
}

export const emptyCounts = (): BackfillCounts => ({ scanned: 0, stamped: 0, corrected: 0, already: 0, unresolved: 0, skipped: 0, gone: 0, failed: 0 });

type Row = {
  id: string;
  personId?: unknown;
  productUserId?: string;
  signupId?: string;
  recipientKind?: string;
  rehearsal?: boolean;
};

/** Which of a row's ids names its person: a product user, a sign-up, or nobody (skip). */
function subjectOf(store: BackfillStore, row: Row): { productUserId: string } | { signupId: string } | null {
  switch (store) {
    case "productEvents":
    case "lifecycleEnrolments":
    case "personPlans":
      // An erase row keeps no user id.
      return row.productUserId ? { productUserId: row.productUserId } : null;
    case "waitlistEnrolments":
      // A rehearsal is nobody's.
      return row.rehearsal || !row.signupId ? null : { signupId: row.signupId };
    case "emailSends":
    case "emailEvents": {
      if (!row.signupId) return null;
      const productUser = row.recipientKind === "product_user" || row.signupId.startsWith("pu_");
      return productUser ? { productUserId: row.signupId } : { signupId: row.signupId };
    }
    default: {
      const unknown: never = store;
      throw new Error(`unknown_store:${String(unknown)}`);
    }
  }
}

/** One brand's backfill. Counts per store. */
export async function backfillPersonIds(
  ctx: TenantContext,
  opts: { apply: boolean; stores?: readonly BackfillStore[]; pageSize?: number },
  deps: { db?: FirestoreLike } = {},
): Promise<Record<BackfillStore, BackfillCounts>> {
  const repo = forTenant(ctx, deps.db);
  const pageSize = opts.pageSize ?? 300;
  const stores = opts.stores ?? (Object.keys(BACKFILL_STORES) as BackfillStore[]);
  const out = Object.fromEntries((Object.keys(BACKFILL_STORES) as BackfillStore[]).map((s) => [s, emptyCounts()])) as Record<BackfillStore, BackfillCounts>;

  // Read once per brand, and cached across stores: the brand's products, users and sign-ups.
  const connections = new Map((await repo.productConnections.find({ limit: 100 })).map((c) => [c.id, c] as [string, ProductConnection]));
  const users = new Map<string, Promise<ProductUser | null>>();
  const signups = new Map<string, Promise<Signup | null>>();
  const userOf = (id: string) => users.get(id) ?? users.set(id, repo.productUsers.getById(id)).get(id)!;
  const signupOf = (id: string) => signups.get(id) ?? signups.set(id, repo.signups.getById(id)).get(id)!;

  /** The person a row should name, "skip" for a row that is nobody's, or null when it resolves to nobody now. */
  const personFor = async (store: BackfillStore, row: Row): Promise<ContactPersonId | null | "skip"> => {
    const subject = subjectOf(store, row);
    if (!subject) return "skip";
    if ("signupId" in subject) {
      const signup = await signupOf(subject.signupId);
      return signup ? personIdForSignup(ctx.tenantId, signup) : null;
    }
    const user = await userOf(subject.productUserId);
    if (!user) return null;
    const connection = connections.get(user.connectionId) ?? null;
    // A sandbox's test users are not people.
    if (connection?.kind === "sandbox") return "skip";
    return personIdForProductUser(ctx.tenantId, user, connection);
  };

  for (const store of stores) {
    const counts = out[store];
    const collection = repo[store] as unknown as BackfillCollection;
    let after: string | null = null;
    for (;;) {
      try {
        const page = await collection.updateWhere(
          [],
          async (row) => {
            counts.scanned += 1;
            const want = await personFor(store, row);
            if (want === "skip") {
              counts.skipped += 1;
              return null;
            }
            if (want === null) {
              counts.unresolved += 1;
              return null;
            }
            if (row.personId === want) {
              counts.already += 1;
              return null;
            }
            if (isContactPersonId(row.personId)) counts.corrected += 1;
            else counts.stamped += 1;
            return { personId: want };
          },
          { startAfter: after, limit: pageSize, dryRun: !opts.apply },
        );
        counts.gone += page.gone;
        if (!page.more) break;
        after = page.last;
      } catch (err) {
        counts.failed += 1;
        // The error's code only: a message can carry a document path.
        console.warn(`[backfill-person-ids] ${ctx.tenantId} ${BACKFILL_STORES[store]}: a page failed (${codeOf(err)})`);
        break;
      }
    }
  }
  return out;
}

function codeOf(err: unknown): string {
  const code = typeof err === "object" && err !== null ? (err as { code?: unknown }).code : undefined;
  return typeof code === "string" || typeof code === "number" ? String(code) : err instanceof Error ? err.name : "error";
}

/** The part of each store's TenantCollection the backfill uses: they differ only in their row type. */
interface BackfillCollection {
  updateWhere(
    where: [],
    plan: (row: Row) => Promise<{ personId: ContactPersonId } | null>,
    opts: { startAfter?: string | null; limit: number; dryRun?: boolean },
  ): Promise<{ last: string | null; more: boolean; gone: number }>;
}
