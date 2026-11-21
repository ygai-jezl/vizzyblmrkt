import { forTenant, type TenantRepositories, type WhereClause } from "@/lib/tenant";
import type { FirestoreLike, TenantContext } from "@/lib/tenant/types";
import { productUserPersonId } from "@/lib/ontology/erase";
import { isPersonId } from "./paths";
import { personIdOf, personKeyOf, PRODUCT_USER_KEY_PREFIX } from "./personSync";
import { readFieldList } from "./fieldList";
import { labelledValues } from "./fields";

/**
 * Everything YouGrow holds about one product user, as the stored documents — for
 * a data subject access request. It reads exactly what an erasure deletes
 * (src/lib/connect/erase.ts: profile, product events, journey progress, email
 * engagement, AI drafts, their plan, their event history and agent actions) plus
 * their opt-outs, so the two stay in step: a store added to one belongs in the other.
 *
 * It reads up to a limit of each kind. `complete` says whether every section came
 * back short of its limit; when one didn't, `truncated` names it, so a file that
 * isn't everything never passes for everything.
 */

/** Our own working fields: leases and Firestore TTLs say nothing about the person. */
const INTERNAL = new Set(["tenantId", "ttlAt", "leaseId", "leaseUntil", "prepareLeaseUntil", "pendingSend", "previewHtml"]);

function plain<T extends object>(doc: T): Record<string, unknown> {
  return Object.fromEntries(Object.entries(doc).filter(([k]) => !INTERNAL.has(k)));
}

export const PERSON_EXPORT_FORMAT = "yougrow.person";

/** The most rows of each kind one export reads. A section that reaches its limit is named in `truncated`. */
const EXPORT_LIMITS = {
  productEvents: 2000,
  journeys: 200,
  emailEngagement: 5000,
  emailSends: 5000,
  aiLines: 200,
  optOuts: 200,
  plans: 10,
  moves: 50,
  events: 5000,
  agentActions: 500,
} as const;
type Section = keyof typeof EXPORT_LIMITS;
type Limits = Partial<Record<Section, number>>;

/**
 * Event history and agent actions by each of some field values, merged by id, and whether any read
 * came back full. Equality only, so these reads need no composite index.
 */
async function historyBy(
  repo: TenantRepositories,
  keys: ReadonlyArray<[field: "personId" | "productUserId", value: string]>,
  limit: (section: "events" | "agentActions") => number,
): Promise<{ events: Array<{ id: string }>; agentActions: Array<{ id: string }>; full: { events: boolean; agentActions: boolean } }> {
  const [eventPages, actionPages] = await Promise.all([
    Promise.all(keys.map(([field, value]) => repo.ontologyEvents.find({ where: [[field, "==", value]], limit: limit("events") }))),
    Promise.all(keys.map(([field, value]) => repo.agentActions.find({ where: [[field, "==", value]], limit: limit("agentActions") }))),
  ]);
  const byId = <T extends { id: string }>(pages: T[][]) => [...new Map(pages.flat().map((r) => [r.id, r])).values()];
  return {
    events: byId(eventPages),
    agentActions: byId(actionPages),
    full: {
      events: eventPages.some((p) => p.length >= limit("events")),
      agentActions: actionPages.some((p) => p.length >= limit("agentActions")),
    },
  };
}

export async function exportPerson(
  ctx: TenantContext,
  personId: string,
  deps: { db?: FirestoreLike; nowMs?: number; limits?: Limits } = {},
): Promise<{ found: false } | { found: true; document: Record<string, unknown> }> {
  if (!isPersonId(personId)) return { found: false };
  const repo = forTenant(ctx, deps.db);
  const user = await repo.productUsers.getById(personId);
  if (!user || user.status !== "active") return { found: false };
  const limit = (section: Section) => deps.limits?.[section] ?? EXPORT_LIMITS[section];
  const mine = { where: [["productUserId", "==", user.id]] as WhereClause[] };
  const [productEvents, journeys, emailEngagement, emailSends, aiLines, optOuts, plans, moves] = await Promise.all([
    repo.productEvents.find({ ...mine, limit: limit("productEvents") }),
    repo.lifecycleEnrolments.find({ ...mine, limit: limit("journeys") }),
    repo.emailEvents.find({ where: [["signupId", "==", user.id]], limit: limit("emailEngagement") }),
    repo.emailSends.find({ where: [["signupId", "==", user.id]], limit: limit("emailSends") }),
    repo.lifecycleDrafts.find({ ...mine, limit: limit("aiLines") }),
    user.emailNormalized ? repo.emailSuppressions.find({ where: [["normalizedEmail", "==", user.emailNormalized]], limit: limit("optOuts") }) : Promise.resolve([]),
    repo.personPlans.find({ ...mine, limit: limit("plans") }),
    // Which people they moved between (ONTOLOGY_PERSON_IDS_ENABLED).
    repo.personMoves.find({ ...mine, limit: limit("moves") }),
  ]);
  // Their event history and agent actions: rows about their own data, their pu: person's (history
  // from before they gave an address, whatever ONTOLOGY_PERSON_IDS_ENABLED says), and, when the
  // person record for their key is gone (a product-only person a sync removed), that person's.
  const historyKeys: Array<["personId" | "productUserId", string]> = [
    ["productUserId", user.id],
    ["personId", productUserPersonId(ctx.tenantId, user.id)],
  ];
  const key = personKeyOf(user);
  if (!key.startsWith(PRODUCT_USER_KEY_PREFIX)) {
    const keyPerson = personIdOf(ctx.tenantId, key);
    if (!(await repo.contacts.getById(keyPerson))) historyKeys.push(["personId", keyPerson]);
  }
  const history = await historyBy(repo, historyKeys, limit);
  const { events, agentActions } = history;
  const sections = { productEvents, journeys, emailEngagement, emailSends, aiLines, optOuts, plans, moves };
  // A section that came back full may have more behind it: the file says so, never passes for the whole.
  const truncated: Section[] = [
    ...(Object.keys(sections) as Array<keyof typeof sections>).filter((name) => sections[name].length >= limit(name)),
    ...(["events", "agentActions"] as const).filter((name) => history.full[name]),
  ];
  return {
    found: true,
    document: {
      format: PERSON_EXPORT_FORMAT,
      exportedAt: new Date(deps.nowMs ?? Date.now()).toISOString(),
      complete: truncated.length === 0,
      ...(truncated.length
        ? { truncated: Object.fromEntries(truncated.map((name) => [name, `only the first ${limit(name)} are here: there may be more`])) }
        : {}),
      profile: plain(user),
      productEvents: productEvents.map(plain),
      journeys: journeys.map(plain),
      emailEngagement: emailEngagement.map(plain),
      emailSends: emailSends.map(plain),
      aiLines: aiLines.map(plain),
      optOuts: optOuts.map(plain),
      plans: plans.map(plain),
      moves: moves.map(plain),
      events: events.map(plain),
      agentActions: agentActions.map(plain),
    },
  };
}

export const WHOLE_PERSON_EXPORT_FORMAT = "yougrow.whole-person";

/** A sign-up's confirmation token works like a password for its link: never in a file. */
const SIGNUP_SECRET = new Set(["verificationToken"]);

/**
 * Everything YouGrow holds about one whole person (AUDIENCE_ONE_VIEW_ENABLED): their
 * person record, their sign-ups on every launch with each one's emails, invite and
 * waitlist journey progress, their opt-outs, and each product user's own export (the
 * ones the record links and any with their address), and their event history and agent actions
 * (each row once: one already in a product's section is not repeated), and their field values
 * with each field's label, archived ones marked. What "Erase everywhere"
 * deletes (src/lib/crm/eraseWorker.ts): a store added to one belongs in the other.
 */
export async function exportWholePerson(
  ctx: TenantContext,
  personId: string,
  deps: { db?: FirestoreLike; nowMs?: number; limits?: Limits } = {},
): Promise<{ found: false } | { found: true; document: Record<string, unknown> }> {
  if (!isPersonId(personId)) return { found: false };
  const repo = forTenant(ctx, deps.db);
  const contact = await repo.contacts.getById(personId);
  if (!contact) return { found: false };
  const address = contact.email ? contact.email.trim().toLowerCase() : null;
  const [linked, byKey, optOuts] = await Promise.all([
    Promise.all((contact.campaigns ?? []).map((c) => repo.signups.getById(c.signupId))),
    address
      ? repo.signups.find({ where: [["email", "==", address]], limit: 500 })
      : contact.phone
        ? repo.signups.find({ where: [["phone", "==", contact.phone.trim()]], limit: 500 })
        : Promise.resolve([]),
    address ? repo.emailSuppressions.find({ where: [["normalizedEmail", "==", address]], limit: EXPORT_LIMITS.optOuts }) : Promise.resolve([]),
  ]);
  const signups = new Map([...linked, ...byKey].filter((s): s is NonNullable<typeof s> => !!s).map((s) => [s.id, s]));
  const ids = [...signups.keys()];
  const ofSignup = (id: string): WhereClause[] => [["signupId", "==", id]];
  const [launchEmails, launchEmailSends, invites, waitlistJourneys, sameAddress, movesTo, movesFrom] = await Promise.all([
    Promise.all(ids.map((id) => repo.emailEvents.find({ where: ofSignup(id), limit: EXPORT_LIMITS.emailEngagement }))).then((r) => r.flat()),
    Promise.all(ids.map((id) => repo.emailSends.find({ where: ofSignup(id), limit: EXPORT_LIMITS.emailSends }))).then((r) => r.flat()),
    Promise.all(ids.map((id) => repo.invites.find({ where: ofSignup(id), limit: EXPORT_LIMITS.journeys }))).then((r) => r.flat()),
    Promise.all(ids.map((id) => repo.waitlistEnrolments.find({ where: ofSignup(id), limit: EXPORT_LIMITS.journeys }))).then((r) => r.flat()),
    address ? repo.productUsers.find({ where: [["emailNormalized", "==", address]], limit: 100 }) : Promise.resolve([]),
    // Product users who moved to or from this person (ONTOLOGY_PERSON_IDS_ENABLED).
    repo.personMoves.find({ where: [["personId", "==", contact.id]], limit: EXPORT_LIMITS.moves }),
    repo.personMoves.find({ where: [["fromPersonId", "==", contact.id]], limit: EXPORT_LIMITS.moves }),
  ]);
  const moves = new Map([...movesTo, ...movesFrom].map((m) => [m.id, m]));
  const productUserIds = new Set([...(contact.products ?? []).map((p) => p.productUserId), ...sameAddress.filter((u) => u.status === "active").map((u) => u.id)]);
  const limit = (section: Section) => deps.limits?.[section] ?? EXPORT_LIMITS[section];
  const [products, history, fieldList] = await Promise.all([
    Promise.all([...productUserIds].map((id) => exportPerson(ctx, id, deps))),
    historyBy(repo, [["personId", contact.id]], limit),
    // Their field values with each field's label, archived ones marked, whatever AUDIENCE_FIELDS_ENABLED says.
    contact.fields && Object.keys(contact.fields).length ? readFieldList(ctx, "person", deps.db) : Promise.resolve(null),
  ]);
  const productDocs = products.flatMap((r) => (r.found ? [r.document] : []));
  // Each row once: one already in a product's section stays there.
  const inProducts = new Set(
    productDocs.flatMap((d) => [...((d.events as Array<{ id?: unknown }>) ?? []), ...((d.agentActions as Array<{ id?: unknown }>) ?? [])].map((r) => String(r.id))),
  );
  const events = history.events.filter((r) => !inProducts.has(r.id));
  const agentActions = history.agentActions.filter((r) => !inProducts.has(r.id));
  const full: string[] = [
    ...(launchEmails.length >= EXPORT_LIMITS.emailEngagement ? ["launchEmails"] : []),
    ...(launchEmailSends.length >= EXPORT_LIMITS.emailSends ? ["launchEmailSends"] : []),
    ...(movesTo.length >= EXPORT_LIMITS.moves || movesFrom.length >= EXPORT_LIMITS.moves ? ["moves"] : []),
    ...(history.full.events ? ["events"] : []),
    ...(history.full.agentActions ? ["agentActions"] : []),
  ];
  const complete = productDocs.every((d) => d.complete === true) && full.length === 0;
  const { searchTokens: _tokens, ...person } = plain(contact);
  return {
    found: true,
    document: {
      format: WHOLE_PERSON_EXPORT_FORMAT,
      exportedAt: new Date(deps.nowMs ?? Date.now()).toISOString(),
      complete,
      ...(full.length ? { truncated: Object.fromEntries(full.map((name) => [name, "this section reached its limit: there may be more"])) } : {}),
      person,
      fields: fieldList ? labelledValues(fieldList.items, contact.fields) : [],
      signups: [...signups.values()].map((s) => Object.fromEntries(Object.entries(plain(s)).filter(([k]) => !SIGNUP_SECRET.has(k)))),
      launchEmails: launchEmails.map(plain),
      launchEmailSends: launchEmailSends.map(plain),
      invites: invites.map(plain),
      waitlistJourneys: waitlistJourneys.map(plain),
      optOuts: optOuts.map(plain),
      moves: [...moves.values()].map(plain),
      events: events.map(plain),
      agentActions: agentActions.map(plain),
      products: productDocs,
    },
  };
}
