import { NextResponse } from "next/server";
import { z } from "zod";
import { getAdminContext, setActiveTenantCookie } from "@/lib/auth/session";
import { sameOriginGuard } from "@/lib/http/sameOrigin";
import {
  createTenant,
  addTenantMember,
  getTenantById,
  TenantIsolationError,
} from "@/lib/tenant";
import { Region } from "@/lib/types/tenant";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NewBrandSchema = z.object({
  name: z.string().trim().min(1, "name is required").max(120),
  rootDomain: z.string().trim().min(1, "domain is required").max(253),
  region: Region,
});

/** Strip scheme/path so the stored domain is a bare host (for favicon + origin). */
function normalizeDomain(input: string): string {
  return input
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/.*$/, "")
    .toLowerCase();
}

/** Derive a global tenant id from the brand name; "" when nothing usable. */
function slugifyTenantId(name: string): string {
  const base = name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return base ? `ten_${base}` : "";
}

/**
 * Create a new brand (tenant). Same auth model as the campaigns route: the
 * admin session cookie authenticates the caller, who becomes the new brand's
 * owner + first `tenant_users` admin (so it shows up in their switcher). The
 * caller is auto-switched into the new brand. `createTenant`'s atomic create
 * rejects a duplicate id as 409. Region is chosen here and immutable thereafter.
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
  await setActiveTenantCookie(id); // land the user in the brand they just made
  return NextResponse.json({ ok: true, id }, { status: 201 });
}
