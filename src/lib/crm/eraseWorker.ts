import { forTenant, type WhereClause } from "@/lib/tenant";
import type { TenantContext, FirestoreLike } from "@/lib/tenant/types";
import type { Contact } from "@/lib/types/contact";
import type { EmailJob } from "@/lib/types/emailJob";
import { removeSignupFromAudience } from "@/lib/mailchimp";
import { eraseProductUser, scrubSuppressionEmails } from "@/lib/connect/erase";
import { normalizeEmail } from "@/lib/waitlist/identifiers";
import { isOneViewEnabled } from "@/lib/audience/flags";

/**
 * Process a `contact_erase` job — the GDPR Art.17 cascade (§H2). Idempotent and
 * best-effort across steps so a partial failure can be retried. Logs a PII-free
 * audit line (counts only).
 *
 * The person's sign-ups go too, on every launch: each one holds their address and
 * name. Their opt-out rows stay with the address blanked, as for a product user.
 * With the one view on (AUDIENCE_ONE_VIEW_ENABLED) this is "Erase everywhere": their
 * user record in every connected product goes as well, as each product's own erase does it.
 *
 * NOTE: a self-service DSR entry-point must wrap this job to fully satisfy Art.17,
 * and the audit should be promoted to the WORM store used by launch deletion.
 */
export async function processContactEraseJob(
  ctx: TenantContext,
  job: EmailJob,
  db?: FirestoreLike,
): Promise<"done"> {
  const contactId = String(job.payload.contactId ?? "");
  if (!contactId) return "done";

  const repo = forTenant(ctx, db);
  const contact = await repo.contacts.getById(contactId);
  if (!contact) return "done"; // already erased — idempotent

  const email = contact.email ?? null;
  const companyId = contact.companyId ?? null;

  // 1. Everything keyed by each of their sign-ups, then the sign-up itself. Email
  //    engagement events (opens/clicks/etc.) are keyed by signupId in the
  //    Mandrill-webhook `email_events` stream. A queued send for a deleted sign-up
  //    drops when it runs.
  const signupIds = await signupIdsOf(ctx, contact, db);
  let messagesDeleted = 0;
  let signupsDeleted = 0;
  for (const sid of signupIds) {
    messagesDeleted += await repo.emailEvents.deleteWhere([["signupId", "==", sid]]);
    // Their invites into a connected product (nav v2 phase 4) go too, and their
    // progress through waitlist journeys on the lifecycle engine (engine move).
    await repo.invites.deleteWhere([["signupId", "==", sid]]);
    await repo.waitlistEnrolments.deleteWhere([["signupId", "==", sid]]);
    // Last, so a retry after a partial failure still finds the ids above.
    if (await repo.signups.getById(sid)) {
      await repo.signups.delete(sid);
      signupsDeleted += 1;
    }
  }

  // 2. With the one view: their user in every product, linked or found by address.
  let productUsersErased = 0;
  if (isOneViewEnabled()) {
    for (const u of await productUsersOf(ctx, contact, db)) {
      if (await eraseProductUser(ctx, u.connectionId, u.id, db)) productUsersErased += 1;
    }
  }

  // 3. Opt-outs keep holding, without the address (the row id is a hash of it).
  if (email) await scrubSuppressionEmails(ctx, normalizeEmail(email), db);

  // 4. Unsubscribe/archive at the external provider (best-effort; gated for EU).
  try {
    await removeSignupFromAudience(ctx, email);
  } catch (err) {
    console.warn(
      "[crm] erase external unsubscribe failed:",
      err instanceof Error ? err.message : "error",
    );
  }

  // 5. Hard-delete the contact record (true erasure — a later signup re-creates
  //    a fresh contact with new consent). A person who only used products may
  //    already be gone: erasing their last product user removed the record.
  if (await repo.contacts.getById(contactId)) await repo.contacts.delete(contactId);

  // 6. Maintain the company rollup; drop the company when it has no contacts left.
  if (companyId) {
    const remaining = await repo.contacts.count([["companyId", "==", companyId]]);
    if (remaining <= 0) {
      await repo.companies.delete(companyId).catch(() => {});
    } else {
      await repo.companies
        .update(companyId, { contactCount: remaining })
        .catch(() => {});
    }
  }

  // 7. PII-free audit (counts only).
  console.info(
    `[crm] contact_erase done tenant=${ctx.tenantId} region=${ctx.region} contact=${contactId} signupsDeleted=${signupsDeleted} productUsersErased=${productUsersErased} messagesDeleted=${messagesDeleted} companyId=${companyId ?? "-"}`,
  );
  return "done";
}

/**
 * Every sign-up of this person, on any launch: the ones the contact links, and any
 * it doesn't yet (a site sign-up joins the contact only once it's confirmed).
 * Sign-ups store the address normalised, or the phone when there's no address,
 * which is how the contact was keyed too.
 */
async function signupIdsOf(ctx: TenantContext, contact: Contact, db?: FirestoreLike): Promise<string[]> {
  const ids = new Set(contact.campaigns.map((c) => c.signupId).filter(Boolean));
  const where: WhereClause | null = contact.email
    ? ["email", "==", normalizeEmail(contact.email)]
    : contact.phone?.trim()
      ? ["phone", "==", contact.phone.trim()]
      : null;
  if (where) {
    const rows = await forTenant(ctx, db).signups.find({ where: [where], limit: 500 });
    for (const row of rows) ids.add(row.id);
  }
  return Array.from(ids);
}

/** Their user in every product: the ones the person record links, and any with their address. */
async function productUsersOf(ctx: TenantContext, contact: Contact, db?: FirestoreLike): Promise<Array<{ id: string; connectionId: string }>> {
  const users = new Map((contact.products ?? []).map((p) => [p.productUserId, { id: p.productUserId, connectionId: p.connectionId }]));
  if (contact.email) {
    const rows = await forTenant(ctx, db).productUsers.find({ where: [["emailNormalized", "==", normalizeEmail(contact.email)]], limit: 100 });
    for (const u of rows) if (u.status === "active") users.set(u.id, { id: u.id, connectionId: u.connectionId });
  }
  return [...users.values()];
}
