import { NextResponse } from "next/server";
import { z } from "zod";
import { getAdminContext, setActiveTenantCookie } from "@/lib/auth/session";
import { sameOriginGuard } from "@/lib/http/sameOrigin";
import {
  createTenant,
  addTenantMember,
  ensureBrandOrganisation,
  getOrganisation,
  getTenantById,
  organisationIdFor,
  TenantIsolationError,
} from "@/lib/tenant";
import { clearOrganisationIdForReuse } from "@/lib/connectors/organisation";
import { isPlansEnabled, newOrganisationPlan } from "@/lib/plans/flags";
import { Region } from "@/lib/types/tenant";
import { normalizeDomain, slugifyTenantId } from "@/lib/tenant/tenantId";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NewBrandSchema = z.object({
  name: z.string().trim().min(1, "name is required").max(120),
  rootDomain: z.string().trim().min(1, "domain is required").max(253),
  region: Region,
});

/**
 * Create a new brand (tenant). Same auth model as the campaigns route: the
 * admin session cookie authenticates the caller, who becomes the new brand's
 * owner + first `tenant_users` admin (so it shows up in their switcher). The
 * caller is auto-switched into the new brand. `createTenant`'s atomic create
 * rejects a duplicate id as 409. Region is chosen here and immutable thereafter.
 *
 * With PLANS_ENABLED, every new brand starts an organisation of its own, on the
 * plan PLANS_NEW_ORGANISATION_PLAN names (unset or unknown: self_hosted), with
 * its creator as owner. It never joins the brand the caller is in: on a hosted
 * copy every allowlisted person's home brand is the bootstrap brand, so that
 * would put almost every new brand into one organisation. Brands are combined
 * only on purpose, by scripts/move-brand.ts.
 *
 * Body: `{ name: string, rootDomain: string, region: "us"|"eu"|"asia" }`.
 */
export async function POST(req: Request) {
  const blocked = sameOriginGuard(req);
  if (blocked) return blocked;

  const ctx = await getAdminContext();
  if (!ctx?.userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const parsed = NewBrandSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: "invalid_input",
        issues: parsed.error.issues.map((i) => ({
          path: i.path.join("."),
          message: i.message,
        })),
      },
      { status: 400 },
    );
  }

  const name = parsed.data.name;
  const rootDomain = normalizeDomain(parsed.data.rootDomain);
  const id = slugifyTenantId(name);
  if (!id) {
    return NextResponse.json(
      { error: "invalid_name", message: "Brand name must contain letters or numbers." },
      { status: 400 },
    );
  }
  // min(1) ran on the RAW input; the host can still be empty after normalization
  // (e.g. "https://" or "/path"), so re-check before persisting a blank domain.
  if (!rootDomain) {
    return NextResponse.json(
      { error: "invalid_domain", message: "Enter a valid root domain, e.g. acme.com." },
      { status: 400 },
    );
  }

  const now = new Date().toISOString();
  try {
    await createTenant({
      id,
      tenantName: name,
      rootDomain,
      status: "active",
      region: parsed.data.region,
      // Origins are NOT trusted from this form. Claiming an allow-listed origin
      // without ownership proof would let one brand hijack another brand's
      // public host→tenant traffic, so a new brand starts with none; domains are
      // added later through the verified-domain flow.
      allowedOrigins: [],
      // Unread, but builds from before plans require it to list brands: kept until the field goes.
      billingTier: "mvp_free",
      ownerId: ctx.userId,
      createdAt: now,
      updatedAt: now,
    });
  } catch (err) {
    if (err instanceof TenantIsolationError) {
      // The id is taken. If it is the caller's OWN brand (e.g. a retry after a
      // partial failure stranded the tenant with no membership row), fall through
      // and re-ensure membership + cookie below. Otherwise the name is genuinely
      // taken by someone else.
      const existing = await getTenantById(id);
      if (!existing || existing.ownerId !== ctx.userId) {
        return NextResponse.json(
          { error: "id_taken", message: `The brand name "${name}" is already taken. Try another.` },
          { status: 409 },
        );
      }
    } else {
      throw err;
    }
  }

  await addTenantMember(ctx.userId, id, "admin"); // idempotent
  if (isPlansEnabled()) await startOrganisation(id, ctx.userId);
  await setActiveTenantCookie(id); // land the user in the brand they just made
  return NextResponse.json({ ok: true, id }, { status: 201 });
}

/**
 * Give the new brand its own organisation. Safe on a retry: a brand that has an
 * organisation already is left where it is ("exists"), so it is never moved or
 * counted twice. A failure is logged with a code only and the brand is still
 * made: a brand with no organisation reads as open (no plan), and
 * scripts/backfill-organisations.ts gives it one.
 */
async function startOrganisation(tenantId: string, userId: string): Promise<void> {
  try {
    // An empty org_<id> taken up again never carries a sign in (Connectors 3): its connections go first.
    const own = await getOrganisation(organisationIdFor(tenantId));
    if (own && own.brandIds.length === 0) await clearOrganisationIdForReuse(own.id, userId);
    const res = await ensureBrandOrganisation(tenantId, {
      plan: newOrganisationPlan(),
      createdBy: userId,
      ownerIds: [userId],
    });
    if (res.status === "conflict" || res.status === "missing_brand") {
      console.error("[admin/tenants] organisation_link_failed", { code: res.status });
    }
  } catch (err) {
    const code = typeof err === "object" && err !== null && "code" in err ? String((err as { code: unknown }).code) : "unknown";
    console.error("[admin/tenants] organisation_link_failed", { code });
  }
}
