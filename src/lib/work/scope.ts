import { getOrganisation, getTenantById, organisationIdFor, organisationMembership, REGION_CONFIGS, type TenantContext, type WorkStores } from "@/lib/tenant";
import type { FirestoreLike } from "@/lib/tenant/types";
import { isLoopsOperator } from "@/lib/loops/operators";
import type { UserLookup } from "@/lib/team/names";
import type { Region, Tenant } from "@/lib/types/tenant";
import type { WorkTask } from "./types";
import { zoneOf } from "./schedule";

/**
 * Who sees what in Work (ADR-0020, plan decision 7), read live on every request from the control
 * database, never from the request or the session's claims:
 *
 * - The organisation is the one the session brand's registry record names, and it must list the
 *   brand back. A brand with no organisation yet (plans off, before the backfill) is its own one
 *   brand organisation under the id the backfill gives it (org_<tenantId>), so its tasks line up
 *   with no move later. If a record already holds that id, Work refuses instead of guessing, even
 *   one that doesn't read as an organisation: taking that id up erases what is kept under it.
 * - The view is Plan and usage's rule: owners, and everyone in a one brand organisation, see the
 *   whole organisation; in a multi brand organisation everyone else sees the session brand's
 *   tasks only, and no whole business tasks.
 * - Members add, edit, log, decide and accept; admins and owners also delete and import.
 * - A brand's region and time zone come from its registry record, never from a request.
 */

/** What Work reads besides the regional databases: the control plane, a clock, and a way to look people up (tests). */
export interface WorkDeps extends WorkStores {
  now?: () => Date;
  lookup?: UserLookup;
  /** One page load's task reads, shared by the list and the open row (sharedReads()). */
  shared?: SharedReads;
}

/**
 * The team's tasks as one page load read them, by what was read, so the list and the open row on
 * it read each set once (WORK_QUICK_EDIT_ENABLED). Made for one request and dropped with it: never
 * kept between requests, so one team's tasks can't reach another. `reads` counts the reads made.
 */
export interface SharedReads {
  loads: Map<string, Promise<unknown>>;
  reads: number;
}

export function sharedReads(): SharedReads {
  return { loads: new Map(), reads: 0 };
}

export const nowOf = (deps: WorkDeps): Date => (deps.now ?? (() => new Date()))();

/** A brand as Work sees it. */
export interface WorkBrand {
  id: string;
  name: string;
  region: Region;
  /** The brand's own time zone, or UTC. */
  timeZone: string;
  /** The repos its git connections selected, as each connection keeps them. A legacy connection with none chosen has none. */
  repos: Array<{ provider: "github" | "gitlab"; fullPath: string }>;
}

export interface WorkScope {
  ctx: TenantContext;
  userId: string;
  organisationId: string;
  /** The organisation's name, or null for a brand on its own. */
  organisationName: string | null;
  /** No organisation record yet: the brand on its own (org_<tenantId>), as the backfill would make it. */
  standalone: boolean;
  owner: boolean;
  view: "organisation" | "brand";
  /** The organisation has one brand, so every task counts as the brand's. */
  oneBrand: boolean;
  /** The brand the person is in. */
  session: WorkBrand;
  /** The brands this person sees, the session brand first: every brand of the organisation in its view, else the session brand. */
  brands: WorkBrand[];
  canDelete: boolean;
  canImport: boolean;
  /** Named by LOOPS_OPERATOR_EMAILS (src/lib/loops/operators.ts). */
  operator: boolean;
}

export type ScopeRefusal = "signed_out" | "no_brand" | "no_organisation";

export function brandOf(t: Tenant): WorkBrand {
  const repos: WorkBrand["repos"] = [];
  for (const [provider, conn] of Object.entries(t.gitConnections ?? {})) {
    if (provider !== "github" && provider !== "gitlab") continue;
    for (const r of conn.repos ?? []) repos.push({ provider, fullPath: r.fullPath });
  }
  return { id: t.id, name: t.tenantName, region: t.region, timeZone: zoneOf(t.timeZone), repos };
}

/** Run `fn` over `items`, `limit` at a time, keeping order. */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]!);
      }
    }),
  );
  return out;
}

const control = (deps: WorkDeps): FirestoreLike | undefined => deps.controlDb;

/** Who the person is in Work, or why Work can't say. */
export async function workScopeFor(ctx: TenantContext, deps: WorkDeps = {}): Promise<{ ok: true; scope: WorkScope } | { ok: false; why: ScopeRefusal }> {
  if (!ctx.userId) return { ok: false, why: "signed_out" };
  const db = control(deps);
  const tenant = db ? await getTenantById(ctx.tenantId, db) : await getTenantById(ctx.tenantId);
  if (!tenant || tenant.status === "suspended") return { ok: false, why: "no_brand" };
  const session = brandOf(tenant);
  const role = { canDelete: ctx.role === "admin", operator: isLoopsOperator(ctx) };

  if (!tenant.organisationId) {
    const id = organisationIdFor(tenant.id);
    // Read as stored, parsed or not, as taking the id up does (reusableOrganisationId): any record
    // there means Work isn't kept under it, since taking it up erases the Work kept under it.
    const taken = db ? await organisationMembership(id, db) : await organisationMembership(id);
    if (taken.exists) return { ok: false, why: "no_organisation" };
    return {
      ok: true,
      scope: {
        ctx,
        userId: ctx.userId,
        organisationId: id,
        organisationName: null,
        standalone: true,
        owner: false,
        view: "organisation",
        oneBrand: true,
        session,
        brands: [session],
        canDelete: role.canDelete,
        canImport: role.canDelete,
        operator: role.operator,
      },
    };
  }

  const org = db ? await getOrganisation(tenant.organisationId, db) : await getOrganisation(tenant.organisationId);
  if (!org || !org.brandIds.includes(tenant.id)) return { ok: false, why: "no_organisation" };
  const owner = org.ownerIds.includes(ctx.userId);
  const oneBrand = org.brandIds.length === 1;
  const view = owner || oneBrand ? "organisation" : "brand";
  let brands = [session];
  if (view === "organisation") {
    const others = await mapLimit(
      org.brandIds.filter((id) => id !== tenant.id),
      5,
      async (id): Promise<WorkBrand | null> => {
        try {
          const t = db ? await getTenantById(id, db) : await getTenantById(id);
          // A listed brand whose own record names another organisation is drift: it is not shown.
          return t && t.organisationId === org.id ? brandOf(t) : null;
        } catch {
          return null;
        }
      },
    );
    brands = [session, ...others.filter((b): b is WorkBrand => b !== null)];
  }
  const canDelete = role.canDelete || owner;
  return {
    ok: true,
    scope: { ctx, userId: ctx.userId, organisationId: org.id, organisationName: org.name, standalone: false, owner, view, oneBrand, session, brands, canDelete, canImport: canDelete, operator: role.operator },
  };
}

/** The brand with this id among those the person sees. */
export function brandIn(scope: WorkScope, id: string | null | undefined): WorkBrand | undefined {
  return id ? scope.brands.find((b) => b.id === id) : undefined;
}

/** Whether the person sees this task: every task in the organisation view, the session brand's in the brand view. */
export function seesTask(scope: WorkScope, task: Pick<WorkTask, "organisationId" | "brandId">): boolean {
  if (task.organisationId !== scope.organisationId) return false;
  return scope.view === "organisation" || task.brandId === scope.session.id;
}

/** The brand a task counts as: its own, or in a one brand organisation the one brand. */
export function brandForTask(scope: WorkScope, task: Pick<WorkTask, "brandId">): WorkBrand | undefined {
  if (task.brandId) return brandIn(scope, task.brandId);
  return scope.oneBrand ? scope.brands[0] : undefined;
}

/** The time zone a task's checks use: its brand's, else the brand it was added from, else the session brand's. */
export function zoneForTask(scope: WorkScope, task: Pick<WorkTask, "brandId" | "addedFrom">): string {
  return (brandIn(scope, task.brandId) ?? brandIn(scope, task.addedFrom) ?? scope.session).timeZone;
}

/** A region as people read it: "Europe". */
export function regionName(region: Region): string {
  return REGION_CONFIGS[region].displayName;
}

/**
 * The name Work's screens and get_work give the person: the organisation's in the organisation
 * view, the session brand's in the brand view (Plan and usage's rule: a member who sees one brand
 * of several never gets the organisation's name), and the brand's for a brand on its own.
 */
export function workNameOf(scope: Pick<WorkScope, "view" | "organisationName" | "session">): string {
  return scope.view === "brand" ? scope.session.name : (scope.organisationName ?? scope.session.name);
}
