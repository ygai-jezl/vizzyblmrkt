# Architecture Decision Record (ADR)

Running log of decisions for **vizzybl-marketing**. Newest first.

---

## ADR-0009 · Organisations and plans (2026-11-20)

Context: piece A of the CRM and tiers plan puts an organisation above brands and gives it
a plan, so the hosted service can offer Free, Pro, Ultra and Enterprise later. Nothing
charges anyone yet: billing is piece H. Everything sits behind `PLANS_ENABLED` (server)
and `NEXT_PUBLIC_PLANS_ENABLED` (build time), both `"false"` in `apphosting.yaml`. Off,
every result is exactly as before, which is the self-hosted open core. There is no new
dependency, no Firestore index or rules change, and no Vizzy change.

Owner decisions (2026-11-20, decisions 17 to 21 of the build plan):

- **The organisation record.** `organisations/{orgId}` in the control database
  ((default)), beside `tenants`. It holds a name, the plan id, `planSince`, `brandIds`,
  `ownerIds`, `createdBy` and times, and never any end user's data. The id is
  `org_<first tenantId>`, or `org_<tenantId>_<6 characters>` when a brand split back out
  finds that id taken.
  - **Two-way links.** The organisation lists its brands (`brandIds`) and each brand
    points back (`tenants.organisationId`), so either side can be read alone and
    `--check` can compare them.
  - **The plan copy.** Each brand keeps a read-only copy of the plan, `tenants.orgPlan`.
    About 20 callers of `tenantMayUse` and `monthlyLimit` are synchronous, in crons and
    admin APIs, and already hold the brand record. A join on read in
    `src/lib/tenant/registry.ts` was rejected, because it would add a read to every
    `getTenantById`, including the admin layout's.
  - **One writer.** Only `src/lib/tenant/organisations.ts` writes the three, together, in
    the organisation's transaction. `updateTenantConfig` strips `organisationId` and
    `orgPlan` from any patch. A missing, damaged or unknown copy reads as no plan, which is
    open, never locked. `scripts/backfill-organisations.ts --check` reports drift.
  - **Limits.** A plan change rewrites every brand's copy in one transaction, so `brandIds`
    is capped at 400 (under Firestore's 500 writes a transaction). `ownerIds` is capped at
    20.
- **The catalog.** Five plans in code, `src/lib/plans/catalog.ts`: Self-hosted, Free,
  Pro, Ultra and Enterprise. An organisation record only names one. It is pure and client
  safe.
  - Its source is the tiers table in the CRM and tiers plan, version 15, signed off as
    decision 17. AI credits a month are 50 per organisation on Free, 250 per user on Pro
    and 1,200 per user on Ultra. Allowances are stored so that "per user" can be said
    (`perUser`), and the limit is the number times the organisation's users.
  - Each plan has its features, its allowances (null is no limit) and optional per brand
    monthly caps for the limited features. No plan sets a cap today. Enterprise lists the
    eight Enterprise ids from `src/lib/enterprise/features.ts` (ADR-0007), with limits and
    price by agreement; a brand's own cap carries the agreed number.
  - 2026-11-20, owner: the article autopilot is on Ultra only, not Pro. It drafts the top
    of the Next up list, so it can't run without Next up, and Pro has no Next up. Giving
    Pro Next up would cost margin, and 4 drafts at 45 credits each plus the lookups would
    use most of Pro's 250 AI credits a month. Pro has Vizzy in Edit mode and brand search,
    with no monthly caps. `FEATURE_NEEDS` in `brandAccess.ts` still records the need,
    because a brand's own grant can give the autopilot without Next up: Plan and usage then
    shows "Needs Next up", and the dry runs list it as lost or gained with Next up, never
    as a cap change. A catalog test keeps every plan with the autopilot on Next up too.
  - No price appears on a public page: the help page reads each plan's summary, which
    names none.
- **Resolution order (decision 18).** For a metered feature, `mayUseWith` in
  `src/lib/plans/brandAccess.ts` decides:
  1. `GRANTED_ONLY_FEATURES` still holds a feature back from every plan, unless the brand
     has its own grant.
  2. A brand's own grant adds a feature its plan lacks.
  3. With `PLANS_ENABLED`, the brand's plan copy decides.
  4. Otherwise the brand may use it. No plan, or an unknown plan, is open.

  Monthly caps resolve brand, then plan, then this copy's `FEATURE_MONTHLY_LIMITS`, then
  the default (`src/lib/plans/limits.ts`). The signatures of `brandCanUse`,
  `tenantMayUse`, `monthlyLimit` and `monthlyLimitOf` did not change, and no feature code
  changed. With plans on, `brandCanUse` reads the brand once per call for a feature not in
  every plan, and never for one in `INCLUDED_IN_EVERY_PLAN`.
- **New brands (decision 19).** Every brand made in the app starts an organisation of its
  own, on the plan `PLANS_NEW_ORGANISATION_PLAN` names (a setting, not a switch), with its
  creator as owner. Unset or unknown means Self-hosted, so a copy that turns plans on stays
  open. The route never reads or joins the brand the caller is in, and checks no allowance
  at creation. The reason: the bootstrap claims make every allowlisted user an admin of
  the same home brand (`src/lib/auth/session.ts`), so "the brand you are in" says nothing
  about which organisation a new brand belongs to. Brands are combined or split only with
  `scripts/move-brand.ts`. An in-app join waits for H or M, as an explicit choice offered
  to the target organisation's owners. The demo seed and the self-host `workspace` step
  give their brand a Self-hosted organisation; in the self-host step a failure is a
  warning naming the repair, not a failed step.
- **The backfill (decision 20).** `scripts/backfill-organisations.ts` gives every brand
  with no organisation one of its own. Existing brands go on Ultra with caps unset, so the
  dry run must show nothing narrower and nothing wider. `--replan <plan> [--from-plan
  <plan>]` fixes a backfill that used the wrong plan.
- **Dry runs both ways.** All three scripts (`backfill-organisations`, `set-plan`,
  `move-brand`) are dry runs until `--apply --by <label>`. Their preview
  (`src/lib/plans/preview.ts`) lists, per brand, the features lost with the data each
  hides, the features gained, and the caps lowered or raised. Applying a change that
  narrows access needs `--allow-narrower`; one that raises a cap or adds a feature, so
  spend can rise, needs `--allow-wider`. They print the project and the settings they read
  from the operator's shell, so the deployment's own `GRANTED_ONLY_FEATURES` and
  `FEATURE_MONTHLY_LIMITS` must be exported first.
- **Gates guide and never lock, with one exception until H or M.** The owner ruled that
  gates guide and never lock. In A a plan exclusion reuses today's denials: the feature's
  screens show their not-included message, its scheduled work stops, and the data it saved
  is kept but out of view (Brand › Competitors shows none, for one). Nothing is deleted.
  This is accepted only because narrowing happens solely through operator scripts, after a
  dry run that lists the hidden data and needs `--allow-narrower`. Before H ships in-app
  downgrades, or M ships in-app plan or role changes, whichever comes first, excluded data
  must become readable again and the not-included notices must link to Plan and usage.
  That is feature code, so A changes neither.
- **Who sees organisation figures (decision 21).** Settings › Plan and usage (the path
  stays `/admin/account/billing`) shows the plan, what it includes and this brand's
  figures to anyone in the brand. The organisation's other brands, their data regions and
  the totals show only to people in the organisation's `ownerIds`, read live from the
  organisation record on every view, or to anyone when the organisation holds only this
  brand. The session's role claim decides nothing about organisations. Another brand is
  read through a system context built from its registry record, counts only, and nothing
  is copied into the control database. With only the UI switch on, the page says plans are
  off, never "coming soon".
- **ADR-0003 P2.** Confirmed by the owner for A: Plan and usage is read only and re-reads
  `ownerIds` live on every view, which meets P2's "re-read live claims" condition, so a
  stale 5-day session cannot widen what A shows. P2 stays open, and a precondition, for any
  in-app plan or role change in H or M: `revokeRefreshTokens` on downgrade, or live claims
  for privileged actions.
- **Allowances.** Counted and shown in A: brands, users, people and live launches. Emails
  and AI credits show "Not counted yet" with the allowance, until their meters exist.
  - Enforced in A: only the brands allowance, inside `move-brand`'s transaction. Users
    waits for M, people for B and J, and live ideas for D. `checkAllowance` and
    `mayAddUser` in `src/lib/plans/usage.ts` are ready for them.
  - Suspended brands count, marked Suspended.
  - Users are counted from `tenant_users` only, once across the organisation's brands.
    Operators who reach the bootstrap brand by claim alone have no row, so they are not
    counted until M.
  - Live ideas show as Live launches until D renames Launches.
- **Enterprise features.** A licence and a plan answer different questions. The licence
  (ADR-0007, piece P) is per deployment and is never stored on the organisation. The plan
  decides between organisations on a copy with plans on, where only Enterprise includes
  the Enterprise ids. With plans off, as on a self-hosted copy, the licence alone decides.
  ADR-0007 expected A to add the plan side as its own function. No Enterprise feature
  exists yet, so A leaves that helper to the first one (piece M), together with one open
  question: the Self-hosted plan lists no Enterprise feature, so a self-hosted copy that
  turns plans on and holds a licence would be refused by its plan unless that changes.
- **Personal data.** `ownerIds`, `createdBy` and the `actor` on `organisation_changes`
  hold Firebase UIDs: pseudonymous staff data, the same kind of value
  `tenant_users.userId`, `tenants.ownerId` and `domain_grants.actorUid` already hold. The
  control plane still holds no end-user personal data (ADR-0002). They are kept for the
  life of the organisation. On a staff erase request, the owner removes the uid with
  `set-plan --remove-owner` and rewrites its `actor` values to `"erased"` by hand, as for
  `domain_grants` today, until piece O brings an erase path. Script actors are operator
  labels from `--by` (`script:<label>`, `backfill:<label>`), which refuse `@` and dots, so
  no email address or domain is stored.
- **The change log.** `organisation_changes` is append only, written in the same
  transaction as each change: `organisation.created`, `plan.changed`, `brand.joined`,
  `brand.left`, `organisation.renamed` and `owners.changed`. Row ids carry a random part,
  so two brands joining in the same millisecond never collide. Piece O may fold it into
  the settings history, or piece 0's event envelope may carry it later.
- **The ontology registry.** A merged first, so piece 0 added the `organisations` and
  `organisation_changes` entries: search kind none (control plane records, no brand content
  or people) and no number path.
- **`billingTier` is deprecated.** It was never read, and it is optional in `TenantSchema`.
  New brands still get `"mvp_free"` (the app, the seed and self-host's `create-workspace`),
  because builds from before plans require it: after a rollback to one, a brand without it
  would make `listAllTenants` throw and every job that loops over brands would fail. The
  writes and the field go together in a later cleanup once prod has run on plans.

Rollback:
1. In the deployment's private settings file, set both switches to `"false"` together and
   roll out one new build (`NEXT_PUBLIC_PLANS_ENABLED` is fixed at build time).
2. Leave `organisations`, `organisation_changes` and the brand fields in place. Off ignores
   them, and nothing is deleted.
3. To turn plans on again, set both switches on, roll out, run
   `backfill-organisations` to catch brands made while off, then `--check`.
4. A backfill on the wrong plan: `backfill-organisations --replan <plan> [--from-plan
   <plan>]` as a dry run, then with `--apply --by <label>`.
5. Rolling the build back to one from before plans also works: its `TenantSchema` ignores
   the new brand fields, and every brand made since still has the `billingTier` it requires.

Room left for later pieces, none of it written yet: settings history on the organisation
(piece O, a `settingsVersion` and versions beside it); legal entities and founder profiles
as children of the organisation (Phase 2, only after a residency decision, since (default)
is the US database); connections owned by an organisation (connectors piece 3, an
`organisationId` on each connection rather than a list here); and the licence (piece P),
which stays with the deployment.

Consequences: with plans on, Plan and usage in organisation view costs, per brand, one
registry read, one people count, one read per live launch (up to 5000) and its
`tenant_users` rows; a cache waits until costs show it is needed. Scripts that call
`tenantMayUse`, such as `scripts/search-backfill.ts`, read the plans switch and settings
from the operator's shell, not the deployment. A crash between making a brand and linking
its organisation leaves an open brand, which the backfill catches.

Where: `src/lib/types/organisation.ts`; `src/lib/plans/` (`flags.ts`, `catalog.ts`,
`brandAccess.ts`, `limits.ts`, `preview.ts`, `usage.ts`); `src/lib/tenant/`
(`organisations.ts`, `liveLaunches.ts`, `control.ts`); `src/app/api/admin/tenants/route.ts`;
`scripts/backfill-organisations.ts`, `scripts/set-plan.ts`, `scripts/move-brand.ts`,
`scripts/lib/operatorCli.ts`; `src/app/admin/account/billing/page.tsx`,
`src/components/admin/plans/PlanAndUsage.tsx`; help `/help/plan-and-usage`;
`docs/self-host.md`; `scripts/selfhost/spec.mjs` (`KEPT_OFF`).

---

## ADR-0008 · The core ontology in code: registry, person ids and the event store (2026-11-20)

Context: piece 0 of the build plan makes the core ontology real in code, so the CRM,
connectors and later pieces build on one model. It ships as one pull request in four parts:
the registry (0a), the search kind rename (0b), person ids at write time (0c), and the event
store with agent actions (0e). The owner answered the open questions in the build plan's
decisions 11 to 26 and approved the plan for piece 0, which this record follows where it
differs from the specs. With every switch off, the only change people see is in search, as
decision 11 approved: the result badge reads "Clipping", the filter group "Scrapbook and
images", and the Search help page lists "Scrapbook clippings and templates", ahead of piece D
renaming the Idea Board screen itself. Otherwise two new server switches ship `"false"`,
nothing calls the event store's writers yet, and Vizzy keeps sending the old search kind name.
No dependency, `firestore.rules`, infra or deploy change.

Owner decisions (2026-11-19 and 2026-11-20):

- **The registry is the source of truth for types and stores.** `src/lib/ontology/registry.ts`
  (not the tenant lookup in `src/lib/tenant/registry.ts`) lists every core type, built and
  planned, by place: the five spine steps (idea, signals, product, customers, support) and the
  rails content, company, partner_agent and platform. Each entry gives its stores, its home
  (control or brand), whether it holds people, its erase and export paths with what triggers
  each, and its search and number decisions.
  - Stores beyond Firestore are listed too: Cloud Storage (six writers, all on the one
    `EMAIL_ASSET_BUCKET`, so each records a residency gap), the write-once audit sink, BigQuery
    (`widget_views`, and the `email_events` and `signups` mirrors), Memory Bank, Agent Engine
    sessions, Mailchimp and Mandrill.
  - Planned types carry the piece that builds them. The founder profile lives on the
    organisation (control plane, personal team), with its residency note (decision 16). Gate,
    data share, partner and provision stay "undecided", which only a planned type may be.
    Piece A merged first, so piece 0 added its `organisations` and `organisation_changes`
    stores, as the built organisation and organisation change types.
  - Gaps are written down, not fixed: social engagement outside a person's erase and export,
    email jobs left by a contact erase, launch deletion leaving email rows and knowledge, counts
    without meanings, catalog history kept to 20, the one asset bucket for every region, the
    BigQuery changelog keeping values after erasure, and Vizzy's chats.
  - `registry.test.ts` enforces the rules: every erase and export path names a file that
    exports it, every search kind, alias and meaning is claimed by a type, each spine step has a
    type, and all text follows the house style.
  - `docs/ONTOLOGY.md` is generated from it by `npm run ontology:doc`. `doc.test.ts` fails while
    the file is out of date, and `agents:check` reads it as a guide.
- **The coverage test.** `src/lib/ontology/coverage.test.ts`, with `storeScan.ts`, reads the
  source of `src/lib/tenant/**` and `workers/*/src/**` (comments stripped, strings kept). It
  fails when a Firestore collection, or a file that writes to Cloud Storage, BigQuery or Memory
  Bank, has no registry entry, or sits in another database than its entry says. The two calls
  whose collection is chosen at run time are allowlisted with reasons; a new one fails the test.
  The control plane set comes from the registry, so piece A only adds registry entries and
  never edits the test. `AGENTS.md` and the build-a-feature skill say a new collection or file
  store needs an entry, then `npm run ontology:doc`.
- **One event envelope.** `src/lib/ontology/events.ts` holds `EVENT_KINDS`, each `family.what`:
  - email, product, journey and signup kinds, `person_plan.*` (never `plan.*`, which the
    organisation's plan keeps), `social.engaged`;
  - `record.created`, `record.field_changed`, `record.merged`, `record.repointed` and
    `consent.recorded`;
  - the agent trail: `agent.proposed`, `agent.approved`, `agent.acted`, `agent.undone` and
    `agent.declined`. Expiry, staleness and being superseded are declines with a reason, not
    kinds of their own.

  `OntologyEvent` carries the person (the `ct_` id, or null), identity as ids only and never an
  address, the idea credited, the source, the actor (`actorOf` maps every
  `TenantContext.source`), refs and properties. Pure mappers read today's email, product and
  person move rows into it; a click keeps its link's origin and path only. The file needs no
  Node, so client code can import it.
- **`personId` on rows means the `ct_` contact id** (decision 13): `ContactPersonId`, checked
  by `ContactPersonIdSchema`, so a product user's `pu_` id fails typecheck and parse. The older
  product user meaning of the name (the `personPlans.ts` parameters, `exportPerson`, the canvas
  `person_plan` scope, `/api/agent/lifecycle/people/[personId]` and
  `/api/admin/audience/people/[personId]/*`) becomes `productUserId` in piece B.
- **The search kind rename (0b).** The content kind `idea` becomes `idea_board`, which frees
  "idea" for piece D's business ideas.
  - 0a taught the store to read the new name first (`SEARCH_KIND_ALIASES` was
    `{idea_board: "idea"}`). 0b flips `SEARCH_KINDS` and the alias to `{idea: "idea_board"}`,
    so every version from 0a on reads both names. Both search routes accept both and pass each
    kind once, and a delete removes a record under both names.
  - `SEARCH_KIND_IDEA_BOARD_ENABLED` (server, `"false"`) picks the name the indexer writes
    (`storedKindOf` in `src/lib/search/indexer.ts`). Off: Idea Board items are still written as
    `idea`, so nothing moves at deploy. The scheduled search check, about every 10 minutes,
    moves stored items to the name in use, either way. It shares its time between brands and can
    stop part way, so a move can take several checks; `scripts/search-backfill.ts --apply` moves
    every brand in one run.
  - Labels follow decision 11: the result badge reads "Clipping", the filter group "Scrapbook
    and images" (its key unchanged), and the Search help page and Vizzy's `search_brand`
    docstring say "Scrapbook clippings and templates". The brand context pack and Next up keep
    "saved idea" until piece D moves the item words to clipping.
  - Vizzy's `search_client.py` knows `idea_board` and `learned` but keeps sending `idea`, which
    every app version takes, so its redeploy rides with piece B in any order.
    `src/lib/search/vizzyKinds.test.ts` keeps its list in step with the app's.
- **Person ids at write time (0c).** While `ONTOLOGY_PERSON_IDS_ENABLED` is on, the `ct_`
  person is written on each new row of `email_sends`, `email_events`, `product_events`,
  `lifecycle_enrolments`, `waitlist_enrolments` and `person_plans`, as it is written.
  - The switch is tied in code to `AUDIENCE_PERSON_LINKS_ENABLED`
    (`isOntologyPersonIdsEnabled` in `src/lib/ontology/flags.ts`), as the one view is, so a row
    never points at a person record that isn't kept. Person links have been on in prod since
    29 Oct (decision 15).
  - Only people connections get a person. Sandbox and revoked connections, rehearsal waitlist
    enrolments, shadow sends and erase rows get none. Every caller hands over the connection it
    already holds, so no write pays an extra read.
  - The person is worked out on the server and never put in Mandrill metadata, which keeps its
    short form well under Mandrill's 250 byte limit. The webhook takes the person from the send
    record or the enrolment, else a sign-up's from the address the email went to, never a
    product user's.
  - `TenantCollection.updateWhere` is a paged, tenant scoped update by query, following
    `deleteWhere`: the tenant predicate is always applied, rows are written by id with no second
    read, and a row deleted between the read and the write counts as gone and is never created
    again. It has its own isolation tests.
  - `scripts/backfill-person-ids.ts` stamps older rows: a dry run by default (`--apply`,
    `--tenant`, `--store`), counts only, never against the emulator. A row is written only when
    its person is missing or different; one that resolves to nobody now keeps its value.
- **A product user's rows follow their current person** (decision 14). When a product write
  leaves a product user with another person, the move is kept in the new regional store
  `person_moves`: `record.merged` when a `pu:` person gains an address, `record.repointed` when
  an address changes or is removed. One move per write (`mv_` from the write's message id), ids
  only, and only its `repoint` marker changes, from pending to done, or to dropped when the
  product user can no longer be a person (erased, or their product revoked).
  - A `person_repoint` job on the email queue (`pr_` per product user and target person) moves
    the rows. It works out the person when it runs, so the newest one wins whatever order jobs
    run in, and checks again before each page and at the end. It works in 20 second slices with
    a saved cursor (the queue's new `again` outcome), then marks the moves done and deletes
    itself. It walks the five stamped stores by product user or sign-up, then the event history
    and agent actions: by the product user, and by the person rows were filed under for a merge
    or a from-person whose record is gone.
  - The lifecycle tick queues again any move pending for over 15 minutes, paging through the
    brand's pending moves by document id. A job that fails three times is deleted rather than
    parked as failed, so its key never blocks that. Switch off: the job drops without writing,
    and no move or job is made. `person_moves` is erased and exported with the product user and
    with either person.
- **The event store and agent actions (0e).** Two new collections in the brand's regional
  database, through `forTenant`: `ontology_events` (append only) and `agent_actions` (one
  record per agent suggestion), as decisions 12 and 22 chose. Regional because the rows are
  personal, and because a record's change must commit with its events, which a Firestore
  transaction can only do inside one database.
  - **The subject model.** Each row is about a subject `{type, id}`: a person, company, idea or
    agent action, keyed `type:id` and mapped to its registry type, plus a separate `personId`
    routing key. A person's timeline is every row carrying their `personId`, which also covers
    an agent action about them. Person only was turned down: company field history, idea status
    history and agent actions with no person would have had nowhere to go.
  - **What is stored, and the timeline merged when read** (decision 24). The store keeps only
    what has no other home: `record.created`, `record.field_changed` (person, company and idea
    fields, with stage, tag and idea status moves under `sys.` field ids), `consent.recorded` and
    the `agent.*` trail. `STORED_EVENT_KINDS` holds that list and the writers refuse any other
    kind. Email, product, journey and sign-up moments stay in their own stores and B5 merges
    them when it reads. The cost: raw product track events drop out after the 90 day time to
    live on `product_events`, while steps, milestones and activation stay on the product user.
    Pointer rows that outlive their source would be a later card. Merges and repoints stay in
    `person_moves`.
  - **The writers.** Only `src/lib/tenant/ontologyEvents.ts` and `src/lib/tenant/agentActions.ts`
    write the two stores. Every write runs in a transaction on `regionalStoreFor`, reads first.
    `@/lib/tenant` exports context level functions only: `appendEvents` (up to 200 rows),
    `writeRecordWithEvents` (a contact create, or a contact, company or campaign patch, with its
    events and optionally an agent action's decision in one commit), the blanking, count, erase
    and repoint helpers, and the agent action functions. The raw transaction helpers stay inside
    `src/lib/tenant`, for B2a's field writes.
  - **Ids and keys.** An event's id is `ev_` and 40 hex of a hash of the brand and its key; an
    action's is `aa_` and a hash of the brand and its dedupe key. Keys hold ids and codes only,
    never an address or a spaced name. A key already stored in the brand is skipped as a
    duplicate, another brand's row throws, and a write tries once more when its create meets a
    row that already exists. A field change's key carries a nonce, so it never dedupes: the
    transaction makes it exactly once. Times are canonical (`toISOString`), so string order is
    time order.
  - **Append only.** A stored event changes in three ways and no other: its `personId` (and a
    person subject) is repointed; an erased field's values before and after are blanked in place,
    with `blankedAt` and `blankedReason`; or it is deleted by an erase. The admin SDK ignores
    Firestore rules, so the repository's type, `src/lib/ontology/appendOnly.test.ts` and review
    hold it. `forTenant` gives both stores as a `HistoryCollection`, reads and the erase's
    `deleteWhere` only, so any other write through it fails typecheck. The test scans the source
    and fails on a mutating call on either store outside the two writers (by property, by a
    destructured name or across lines), a store reached by a string key or destructured from
    `forTenant`, either collection named outside the writers, the repository and the registry,
    the writers' collection constants or `eventRef` used elsewhere, a set, update or delete in
    either writer outside the functions allowed to change a row, agent rows staged outside the
    agent action writer, or a direct import of either writer from outside `src/lib/tenant`.
  - **Agent actions.** States are proposed, approved, acted, undone and declined. Proposed goes to
    approved, acted or declined; approved to acted or declined; acted to undone. Every change
    appends exactly one `agent.*` row in the same transaction (proposed straight to acted writes
    approved, then acted 1 ms later, so newest first reads right). Mode is suggest only; acting
    within limits is a later piece with its own switch (decision 42).
    - Every action needs `expiresAt`, at most 90 days on, and `expireAgentActions` declines past
      ones with the reason expired.
    - Proposing a dedupe key again writes nothing and answers `open` or `decided`. Raising
      something again after a decision takes a new key (`agentDedupeKey` lists the patterns).
    - Signals are references with meaning keys, never free text. Targets are a person, company
      or idea, each a registry type. `requestedBy`, `decidedBy`, `actedBy` and `undoneBy` hold
      ids only.
    - `clearDetailsOnClose` on the record, or `clearDetails` on the decision, clears proposal
      and basis in the commit that acts or declines.
  - **Reads.** `src/lib/ontology/timeline.ts` reads one person's or one subject's rows newest
    first, a page at a time, with an opaque cursor. `src/lib/ontology/agentActions.ts` lists open
    actions per action, so one consumer's backlog never pushes another's out of Review.
- **Erase and export reach both stores whatever any switch says.**
  - A contact's erase removes rows by their person id (before its early return, and again after
    the contact goes), by the `pu:` person id of each product user they link, and a company's
    rows when the company is dropped.
  - A product user's erase removes rows by the product user and by their `pu:` person id
    (`productUserPersonId`, the same hash whether or not that record still exists, so it never
    depends on 0c's switch). It also forgets the history of a person who goes with their last
    product user, decided from the person's sources as the person sync decides, so it holds when
    the record only goes at a later sweep (a sync that failed, or person links off).
  - Deleting a launch removes the idea's rows and the actions about it. An archived field's
    values are blanked in place, never deleted.
  - `exportPerson` gains events and agent actions by the product user, their `pu:` person and a
    removed product-only person. `exportWholePerson` (the People view's export) gains both by
    person id, each row once, at most 5,000 events and 500 actions, with a truncated flag.
  - When a sync removes a product-only person, their history stays, reachable through the
    product user's erase and export (decision 26).
  - Team member ids stay as ids in actor and decision fields and show as "Former team member"
    once the member leaves, as O1 decided for settings history. There is no erase or export by
    member.
  - These reads and deletes are equality only, so they work before the indexes are deployed.
- **Retention.** Both stores are kept until erased, with no time to live and no change to
  `infra/lifecycle/setup.sh` (decision 22). Personal values leave through erase, blanking and
  clearing details; open suggestions close by expiry within 90 days once a consumer runs the
  sweep.
- **The indexes and field exemptions, as approved** (decision 23). `firestore.indexes.json`
  gains exactly these and nothing else:
  - `ontology_events` (tenantId ASC, personId ASC, at DESC): one person's timeline;
  - `ontology_events` (tenantId ASC, subjectKey ASC, at DESC): one company's or idea's history;
  - `agent_actions` (tenantId ASC, action ASC, state ASC, createdAt DESC): open suggestions per
    action in Review;
  - `agent_actions` (tenantId ASC, fieldIds CONTAINS): blanking an erased field in suggestions,
    and its count;
  - `agent_actions` (tenantId ASC, state ASC, expiresAt ASC): the expiry sweep;
  - field exemptions (`indexes: []`) for `ontology_events.properties`, `.refs` and `.identity`,
    and for `agent_actions.proposal`, `.basis`, `.result`, `.undo` and `.signals`.

  Every other query on the two stores is equality only, ordered by document id or not at all.
  The emulator ignores composite indexes, so the five must be READY in each environment before
  the first consumer switch there. Deploying them is the owner's step
  (`firebase deploy --only firestore:indexes --project <your-project>`, which applies the file to
  all three databases).
- **Google's pattern**
  (https://firebase.google.com/docs/firestore/query-data/index-overview, "Indexing best
  practices", read through Google's Developer Knowledge on 2026-11-20):
  - Exempt large map and array fields that are never queried, since they can approach the limit
    of 40,000 index entries per document. Those are the eight exemptions above: values nobody
    queries, some of them personal. `fieldIds` stays indexed because the fourth index needs it,
    and it holds at most 100 ids.
  - An indexed field whose values rise in order between documents, like a timestamp, caps a
    collection at 500 writes a second. `ontology_events` indexes `at` for the timeline, so it
    sits under that cap. That is far above the rate we expect: its rows come from edits, consent
    records and agent suggestions, while email and product traffic stays in its own stores.
- **Switches.**
  - `ONTOLOGY_PERSON_IDS_ENABLED` and `SEARCH_KIND_IDEA_BOARD_ENABLED`: server only, `"false"` in
    `apphosting.yaml`, empty in `.env.example`.
  - 0e has no switch. Nothing calls its writers yet, and a library nobody calls ships without one,
    as O1 does. There is no master kill switch for event writes either: values would then change
    with no event. Each consumer card gates its own writes, and its own call of
    `expireAgentActions`, with its own switch.
  - Every consumer switch that writes person rows (B2a, B4, B5, B6a, B6b) is tied in code to
    `isOntologyPersonIdsEnabled()`, as `isOneViewEnabled` is tied to person links, so merged and
    repointed history follows the person on the timeline (decision 25). Erase and export don't
    need it.
  - Decision 25 also clears the proposed values of any suggestion that is declined or expires.
    The store does that through `clearDetailsOnClose`, which defaults to false, so each proposing
    consumer sets it. Who may approve, decline or undo is each consumer's gate: admins for now
    (decision 28).
- **Rollback, in this order:**
  1. Turn `SEARCH_KIND_IDEA_BOARD_ENABLED` off, then move every brand's items back under
     `idea` before going on: anything left under `idea_board` would never be read or removed by
     the reverted code. Don't count on one search check, which shares 30 seconds a tick between
     brands and can stop part way. Run `npx tsx scripts/search-backfill.ts --apply` once with the
     switch unset in that shell (its header says what it needs), and go on only when it ends
     with no failures.
  2. Turn `ONTOLOGY_PERSON_IDS_ENABLED` off, then wait one delivery drain, so queued
     `person_repoint` jobs drop themselves. A revert with jobs still queued makes the job switch
     in `src/lib/email/delivery.ts` throw for them until they park as failed after three
     attempts.
  3. Only then revert. Once consumers of the event store exist, their switches go off before
     this step too.
  4. Once rows exist, any revert keeps the `person_moves` erase and export lines and 0e's erase
     and export commit, with the repository entries and writers they use, or erase and export
     stop reaching personal data. A full revert of 0e after rows exist needs a one-off purge
     first: written then, asked first, dry run first and run by the owner per environment. The
     indexes can stay, since empty indexes cost nothing.

Known gaps (also in the registry):
- Today's agent paths write drafts with no agent action record: canvas drafts for nine kinds,
  brand notes, learning from a repo, autopilot runs, brand map research and lifecycle AI lines.
  The Agent record piece (decision 42, wave 3) records them behind its own switch. Until then
  "every agent action is recorded" does not hold for them.
- An open new person suggestion for someone not yet in People has no export path. Its details
  clear within 7 days, and erase finds it by person id once they are added.
- Rows about a product-only person whose address changed while `ONTOLOGY_PERSON_IDS_ENABLED` was
  off stay under the old person. The switch tie above stops consumers writing such rows.
- A product user's rows keep their `personId` after a contact erase while
  `AUDIENCE_ONE_VIEW_ENABLED` is off, because the product user is kept then.
- `email_events` is mirrored to BigQuery per region, so `personId` appears there, and the
  changelog keeps it after erasure, as it does for every mirrored field.
- Erasing a product user also erases rows under their `pu:` person from before a merge the
  repoint job hasn't moved yet. That errs toward deletion, the safe direction.

Owner steps:
- After merge, on dev: sync the settings, deploy the indexes and wait for READY in all three
  databases, then run the backfill: dry run, apply, dry run (stamped 0 and corrected 0).
- Prod: promote with both switches off, deploy the indexes, then a private settings change
  turns on `ONTOLOGY_PERSON_IDS_ENABLED` and after it `SEARCH_KIND_IDEA_BOARD_ENABLED`. Run the
  prod backfill the same way. Once the search switch is on, `scripts/search-backfill.ts --apply`
  with `SEARCH_KIND_IDEA_BOARD_ENABLED=true` in that shell moves every brand's clippings in one
  run, instead of some dropping out of search for a check or two. Vizzy's search change rides
  the redeploy after piece B.

Deferred:
- Renaming the older product user meaning of `personId` (piece B).
- Every consumer of the event store (B2a, B4, B5, B6a, B6b, 2d, D1, O2b), the timeline view and
  its merge (B5), and wiring `expireAgentActions` into a tick.
- Pointer rows for email and product moments, if the owner wants them later.
- Vizzy sending `idea_board` itself, once every environment runs 0a or later.
- Acting within limits (wave 4).

Consequences: two more regional stores hold personal data, so any new path that removes a
person, company or idea calls `eraseHistory`. Every new collection or file store needs a
registry entry and a regenerated `docs/ONTOLOGY.md`, so piece A and piece 0 rebase on each
other's registry. `person_repoint` jobs share the email queue and run between sends, in the
scheduled drain only: an inline drain inside a request leaves them queued. The fake
Firestore applies transaction writes in order and doesn't enforce reads before writes, so the
writers' tests run through `src/lib/tenant/testing/readsFirst.ts`.

Where: `src/lib/ontology/` (`person.ts`, `types.ts`, `registry.ts`, `storeScan.ts`,
`coverage.test.ts`, `events.ts`, `doc.ts`, `flags.ts`, `personRef.ts`, `moves.ts`,
`repoint.ts`, `backfillPersonIds.ts`, `consent.ts`, `eventBuilders.ts`, `timeline.ts`,
`agentActions.ts`, `erase.ts`, `appendOnly.test.ts`), `scripts/ontology-doc.ts`,
`scripts/backfill-person-ids.ts`, `docs/ONTOLOGY.md`, `scripts/agents-check.mjs`;
`src/lib/tenant/` (`repository.ts`, `ontologyEvents.ts`, `agentActions.ts`, `index.ts`,
`launchDeletion.ts`, `testing/readsFirst.ts`), `src/lib/types/` (`ontologyEvent.ts`,
`agentAction.ts`, `personMove.ts`); `src/lib/search/` (`types.ts`, `indexer.ts`, `sweep.ts`,
`flags.ts`, `labels.ts`), `src/lib/tenant/searchIndex.ts`, both search routes,
`src/components/help/pages/search.tsx`, `agents/root_agent/tools/search_client.py` and
`search.py`; the email, lifecycle and connect writers, `src/lib/crm/eraseWorker.ts`,
`src/lib/connect/erase.ts`, `src/lib/audience/personExport.ts`; `firestore.indexes.json`,
`apphosting.yaml`, `.env.example`, `AGENTS.md`.

---

## ADR-0007 · Open core: the Enterprise boundary, licence keys, licences and the CLA (2026-11-19)

Context: on 2026-11-19 the owner chose open core. The app stays AGPL-3.0, Enterprise
features live in `src/ee` under a commercial licence, and the Node SDK stays MIT. Some
features (single sign-on, user provisioning, field and record level access, audit log
export and retention, retention rules, legal hold) will need a licence key on a
self-hosted copy. This record lays the code boundary and the draft licences before any
Enterprise feature exists, so the lawyer review never holds up the code. Nothing changes
for users: no switch, no Firestore data or index, no new dependency and no Vizzy change.
No Enterprise feature is built yet, so every one of them answers "off".

Owner decisions (2026-11-19):

- **The boundary.** Only `src/lib/enterprise/registry.ts` imports from `src/ee`. Everything
  else asks the registry whether a feature is licensed, so the app builds and runs without
  the folder. Three guards hold it:
  - ESLint: an `import/no-restricted-paths` block over every code file in the repo
    (`ENTERPRISE_MESSAGE` in `eslint.config.mjs`), off only in `src/ee` and the registry.
    It sees import, export from, `import()` and `require()`. It is not part of
    `no-restricted-imports`, which the tenant layer turns off and which misses `import()`
    and `require()`. eslint-config-next already registers the import plugin and its
    resolvers, so there is no new dependency.
  - The source scan, `src/lib/enterprise/boundary.test.ts`. The rule skips a specifier it
    can't resolve, and ESLint ignores `infra`, `agents` and `workers`. So the scan reads
    every code file in the repo with the TypeScript parser (comments never count) and fails
    on any import, require, re-export, import type or `vi.mock` that reaches `src/ee`.
    `eslintBoundary.test.ts` shows the rule at error for files in `src`, `scripts`, `sdk`
    and the root, and absent for the registry and `src/ee` itself.
  - The CI job "Builds without Enterprise code" in `.github/workflows/ci.yml`. It deletes
    `src/ee`, then runs typecheck, lint, the unit tests and the build, beside the verify
    job so a result takes no longer. `agents:check` and the `check:*` steps stay in verify,
    since the guides name files in `src/ee` on purpose. Until Enterprise code lands it
    proves the steps; from then on it is the guard. No test outside `src/ee` reads or
    imports anything in it.
- **The licence key format.** `ygel_<header>.<claims>.<signature>`, each part base64url
  without padding (`src/lib/enterprise/licence.ts`).
  - The header is `{ alg: "EdDSA", typ: "ygel1", kid }`. The kid is the RFC 7638
    thumbprint of the Ed25519 public key, so a key's id comes from the key itself.
  - The claims are `{ v: 1, lid, licensee, seats, features, iat, nbf?, exp }`, times in
    seconds. The signature covers the ASCII text `ygel_<header>.<claims>`.
  - Parsing is strict: 4096 characters at most, the base64url alphabet only, and every part
    must encode back to exactly itself, because Buffer's decoder skips characters it doesn't
    know (the parser in `src/lib/connect/outboundToken.ts` allows that). The signature is
    checked before any claim is read, then the version, the claims' shape, the start time
    (300 seconds of leeway) and the end.
  - Every failure has a reason: `no_key`, `malformed`, `unsupported_alg`, `unknown_key`,
    `bad_signature`, `wrong_version`, `bad_claims`, `not_yet_valid` or `expired`. An expired
    key keeps its claims, so a later screen can say when it ended. Unknown feature ids are
    kept but never match, so a newer key still works on an older copy. The key is never
    logged.
  - The eight feature ids are `sso`, `scim`, `field_access`, `record_access`,
    `audit_export`, `audit_retention`, `retention_rules` and `legal_hold`
    (`src/lib/enterprise/features.ts`). They are written into keys, so renaming one means
    reissuing every key that lists it.
- **The verifier sits in core, not in `src/ee`.** Core must be able to answer "off" with no
  `src/ee`, and the verifier is pure, offline and tested with a fresh key pair on every run,
  so no private key is ever committed. Being AGPL code doesn't change the Enterprise
  Licence: production use of `src/ee` needs a subscription and a key, whatever the verifier
  says. Whether the licence's clause against working around the key check adds anything when
  the verifier itself is AGPL is a question for the lawyer, not a settled fact.
- **Signing keys follow Google's pattern** for asymmetric signing keys
  (https://docs.cloud.google.com/kms/docs/key-rotation): they rotate by hand. Publish the
  new public key first, then sign with the new version, and keep old versions until nothing
  uses them. So `LICENCE_PUBLIC_KEYS` (`src/lib/enterprise/publicKeys.ts`) takes a new key
  beside the old one, and the old one stays until every licence key signed with it has
  expired. The private key lives offline, or in Cloud KMS as an Ed25519 key, and never in a
  repository. The list ships empty, so no key verifies yet; the owner adds the production
  public key in a later commit.
- **`ENTERPRISE_LICENCE_KEY` is a setting, not a switch.** It is never compared with
  `"true"`. It is listed in `.env.example` only, never in `apphosting.yaml`, which holds
  switches. A self-hosted copy keeps it in Secret Manager and names it in its own settings
  file (`docs/self-host.md`, "Enterprise features": create the secret, give the backend
  access, and only then add the line). Empty: every Enterprise feature stays off and
  everything else works. `currentLicence` keeps the signature result for one key string and
  checks the times on every call.
- **Composition.** The registry answers one question: may this deployment run feature X?
  Yes when this build has the code for X and the deployment's key is valid and lists X.
  - It is deployment level and takes no brand or organisation, and its signature will not
    change. It answers in the order `code_absent`, the key's failure, `not_in_licence`,
    `licensed`, and never throws on a bad setting. `EE_CODE` is empty, so today every
    feature answers `code_absent`.
  - Hosted copies carry their own key: hosted dev and prod each get an owner-issued key,
    kept with that deployment's private settings, from piece M (the first Enterprise code)
    on. One code path runs everywhere, with no hosted bypass.
  - Piece A adds the organisation plan check ("may this organisation use X") as a separate
    function in `src/lib/plans`. Callers ask both.
  - `src/lib/plans/brandAccess.ts` stays the per-brand gate for metered features. Piece A
    updates its "the one place a plan or tier check belongs" comment.
  - `registry.ts` and `licence.ts` use `node:crypto`, so they run on the Node runtime only,
    never from middleware or a client component. `features.ts` has no imports, so pages can
    use it. Import the registry as `@/lib/enterprise/registry`; other folders have their
    own `registry.ts`.
- **Seats.** Piece A counts an organisation's users. Piece M enforces a key's seats, and
  adds the grace period after a key expires and the licence status screen.
- **Licences.** `LICENSE` is untouched, so GitHub still detects AGPL-3.0. `LICENSING.md` at
  the root is the map:
  - a copyright and licensor line, YouGrow.AI Limited, as in `sdk/node/LICENSE`;
  - AGPL-3.0-only for everything not listed, the YouGrow Enterprise Licence for
    `src/ee/**`, MIT for `sdk/node/**`, the SIL Open Font Licence 1.1 for each font file
    (with its notice beside it), and ISC for `src/lib/brandMap/packSiblings.ts`;
  - `package.json`'s `license` field is `SEE LICENSE IN LICENSING.md`. The lockfile's root
    entry was edited by hand to match, with no dependency change. If GitHub ever shows
    something other than AGPL-3.0 because of the root file, the map moves to
    `docs/licences.md`.
- **The section 7 permission**, in `LICENSING.md`, is a draft for the lawyer. Anyone who
  combines the app with the code in `src/ee` may convey the result, and make it available
  to users over a network. `src/ee` keeps its own licence, and the Corresponding Source of
  the AGPL parts must still be provided.
- **The YouGrow Enterprise Licence**, version 1 (`src/ee/LICENSE`), is a draft written
  fresh. Read, copy, change, share and test the code freely. Production use needs an active
  subscription and a key that covers at least the number of users. Nobody may remove,
  disable or work around the key check or its limits. Changes stay under it, and code
  outside `src/ee` is not covered. No warranty, and it ends on breach. The governing law and
  the contact are placeholders. New files in `src/ee` start with
  `SPDX-License-Identifier: LicenseRef-YouGrow-Enterprise`.
- **The CLAs.** `docs/cla/individual.md` follows the shape of the Apache ICLA, plus an
  outbound clause: you keep your copyright and grant YouGrow.AI Limited a perpetual,
  worldwide, royalty-free, irrevocable licence to use and sublicense your contributions
  under any licence terms, open source or proprietary. It adds a patent licence that ends
  for anyone who sues over the contribution; you confirm the work is yours to give, you
  answer for work made with AI tools, and it comes as is. `docs/cla/entity.md` has the same
  terms for an organisation and its named GitHub logins, signed by email. A maintainer
  records only an id, the date and the logins in `docs/cla/policy.json`; the signed copy
  stays outside the repository. Every legal text here says "Draft under legal review, not
  yet in force". The AGPL, MIT, OFL and ISC licences already apply.
  - An employer with rights in a person's work signs the entity agreement; the individual
    agreement says so in its opening and in section 5.
  - If a draft's text changes before it is final, it gets a new id (such as
    `individual-v2`) and the policy accepts only that one, so anyone who signed the draft
    signs again. A signature never stands for terms the signer didn't see.
- **The legal chain.** All of today's code was written from the maintainer's own accounts.
  The licensor line, the Enterprise Licence on `src/ee`, the section 7 permission and the
  CLAs' outbound grant all rest on a founder IP assignment of that work to the legal
  entity, YouGrow.AI Limited. It must be signed and confirmed before the first Enterprise
  sale, before any outside contribution is merged, and before the CLA check is made
  required. That is why the maintainer's account is exempt from the CLA, and why
  `CONTRIBUTING.md` says outside pull requests can't be merged until the agreements are
  final and the assignment is signed.
- **The CLA check** (`.github/workflows/cla.yml`, `scripts/check-cla.mjs`,
  `scripts/lib/cla.mjs`):
  - It runs on `pull_request_target` for pull requests to dev and main, and by hand with a
    pull request number. Only the base repository's code runs: the workflow never checks
    out the pull request, so a pull request can't change the checker that judges it. Plain
    `pull_request` was turned down for that reason. The pull request's commits and files
    are read as data through the API, with GET calls only.
  - The token can read contents and pull requests, nothing else. Checkout takes no ref and
    keeps no credentials. There is no `npm ci`, since the checker uses Node built-ins only,
    and no GitHub expression in a run line. It runs on our public repository only.
    `scripts/lib/claWorkflow.test.ts` fails if any of that changes. If code scanning flags
    the trigger, this record is why it is expected.
  - One file per signer, `docs/cla/signatures/<login>.json`, added in the signer's own pull
    request. It holds only the GitHub login, the agreement and the date, and the check
    refuses any other key, so no names or emails creep in. Two people signing at once never
    conflict, and a branch cut before someone else signed never looks like a removal.
  - `docs/cla/policy.json` is maintainer only: the accepted agreements, the exempt logins
    with why (`ygai-jezl`, `dependabot[bot]`, `github-actions[bot]`), the AI coding tools,
    and the organisations. An outside pull request may change nothing in `docs/cla` except
    adding its author's own signature.
  - Trusted reads: the policy and the signatures come from the tip of the base branch (dev
    or main), never from the pull request, so a re-run sees signatures merged since (the
    base commit GitHub records can lag). A dev to main promotion within the repository reads
    at dev's head commit, since everything on dev came through a checked pull request or the
    maintainer. A fork's branch named dev is not a promotion. The only file read from the
    pull request is its author's own new signature.
  - Who is checked: the author, each commit's author and each human co-author. The AI
    addresses and logins come from the policy (`noreply@anthropic.com` and `claude` to
    start; another tool's address is added once a real commit shows it). A commit by one of
    them counts as the pull request author's, and an AI Co-authored-by line is ignored. A
    human co-author is covered through their GitHub noreply address, or through an address
    a covered commit author in the same pull request uses. Otherwise the check fails,
    naming only the short sha, never a name or email. A commit with no linked GitHub
    account fails the same way.
  - It fails closed: a base other than dev or main, a missing or invalid policy, a file it
    can't read, or fewer commits or files than the pull request has (GitHub lists 250
    commits and 3000 files at most). The job summary says in plain words who is missing and
    how to sign.
  - The maintainer override is the ruleset bypass, not code. The check runs once the
    workflow is on main, and stays advisory until a ruleset makes it required.
- **The public list.** `/developers/open-source` gains "What is open and what is
  Enterprise": each part and its licence, the Enterprise features from
  `ENTERPRISE_FEATURES` ("None is released yet"), what only the hosted service offers
  (`HOSTED_ONLY`), and that the app builds without `src/ee`. It sits behind
  `DEVELOPERS_DOCS_ENABLED` like the rest of the page.

Open questions for the lawyer:
- Section 13: is the network wording in the section 7 permission needed, and is it enough?
- Does the Enterprise Licence's clause against working around the key check add anything
  when the verifier itself is AGPL?
- Does Enterprise code that sits unused in a self-hoster's production build count as
  production use?
- Work made with AI tools: is the CLA's clause on it enough, and what does the outbound
  grant cover there?
- Is adding a signature file in one's own pull request a valid way to sign?
- Is a signature made against the draft valid once the text is final, if the text didn't
  change, or should everyone sign again?
- Should an employer's written permission be enough, as in the Apache ICLA, or must an
  employer with rights always sign the entity agreement, as the draft says today?
- The entity agreement's Schedule A and signing block: are they enough, or does it need
  its own execution page?
- How long should signed entity CLAs be kept?
- The governing law and the contact, both placeholders today.

Deferred:
- The fallback alias, with the first Enterprise code (piece M). Once the registry imports
  from `src/ee`, a build without the folder needs an alias for those imports: tsconfig
  `paths`, a vitest alias chosen with `existsSync`, and Turbopack's `resolveAlias` if it is
  adopted.
- Hosted keys, the seat count, the grace period and the status screen (piece M).
- The production public key (the owner), and the tool that issues keys, which lives in the
  private operations repository.
- Making the CLA check required, after the lawyer and the founder IP assignment. At the
  same time, set fork pull request workflows to need approval for all outside
  contributors. A required check matches on its name and on the GitHub Actions app, which
  every workflow shares, so a pull request that adds its own job named CLA could otherwise
  stand in for the real one. The `cla.yml` header says the same.
- Trademark.

Consequences: the CI job without `src/ee` uses runner minutes on every pull request.
Signature files are keyed by lowercase login, so someone who renames their GitHub account
signs again. A pull request over GitHub's listing limits fails the CLA check, so it is split
or merged with the bypass.

Where: `src/lib/enterprise/` (`features.ts`, `publicKeys.ts`, `licence.ts`, `registry.ts`,
`boundary.test.ts`, `eslintBoundary.test.ts`), `eslint.config.mjs`,
`.github/workflows/ci.yml`, `.env.example`; `src/ee/` (`LICENSE`, `README.md`,
`AGENTS.md`), `LICENSING.md`, `package.json`; `docs/cla/` (`individual.md`, `entity.md`,
`policy.json`, `signatures/README.md`), `scripts/lib/cla.mjs`, `scripts/check-cla.mjs`,
`.github/workflows/cla.yml`, `scripts/lib/claWorkflow.test.ts`;
`src/app/developers/open-source/page.tsx`, `CONTRIBUTING.md`, `docs/self-host.md`.

---

## ADR-0006 · Connector security fixes (2026-11-20)

Context: a security review on 17 Nov found these still true for connected accounts
(GitHub, GitLab, X, LinkedIn, LinkedIn Pages) and Mailchimp settings:
- any member of a brand could connect, disconnect or pick repos, and change the brand's
  Mailchimp settings;
- GitLab connections died 2 hours after connecting, because GitLab's refresh token was
  never stored;
- GitHub and GitLab sign-in were not bound to the browser that started them (X and
  LinkedIn already were);
- Disconnect never cancelled anything at the provider.

Reviewing the fixes found four more:
- a brand could claim the shared Mailchimp audience, or another brand's, and so receive
  their unsubscribes, bounces and spam reports;
- disconnecting an X account deleted its `social_subscriptions` row even when another
  brand held it, which wiped that brand's X attribution;
- a token refresh during a publish run wrote the whole connection back, so it could
  bring back an account someone had just disconnected;
- `setTenantGitRepos` wrote onto a connection that a racing Disconnect had removed,
  leaving a partial map the tenant schema rejects, which locked everyone out of the brand.

Decision (one PR, three groups of commits):
- **Admins only.** Connecting, disconnecting, picking repos and changing Mailchimp
  settings need the admin role. Every route under `/api/admin/integrations` goes through
  `src/lib/integrations/admin.ts`: `integrationsAdmin` (origin check, sign-in, then the
  role for anything that changes state) and `integrationsHopAdmin` for the OAuth start
  and callback hops. `src/lib/integrations/routesGate.test.ts` fails when a route skips
  it. The Mailchimp settings `PUT` checks the role in its own route. Members still see
  what is connected, read only, and are told to ask an admin.
- **Sign-in bound to the browser.** Every OAuth hop carries a nonce in its signed state
  that must match a cookie the start set. GitHub (App install and classic OAuth) and
  GitLab now use `git_oauth_state`: httpOnly, SameSite lax, Secure on https, 10 minutes,
  scoped to that provider's callback path. A missing or different cookie goes back with
  `bad_state` before any code exchange. X and LinkedIn already worked this way.
- **Mailchimp only tightens.** A brand can turn `requiresOwnApiKey` on, never off. A new
  audience id is refused when it is the shared audience, another brand holds it (the
  answer never names that brand), the brand has no key of its own, or that key can't
  read the list. Nothing is saved on a refusal, and an unchanged id is not checked again.
- **X attribution.** `deleteTenantSocialConnection` is one transaction that deletes
  `social_subscriptions/{platform}:{userId}` only when this brand is its holder.
- **GitLab stays connected.** The GitLab callback stores the refresh token, sealed with
  AAD `<tenantId>:gitlab:refresh` (`gitRefreshAad`, the pattern of the Mailchimp key
  box), and its expiry. The access token keeps no AAD because the knowledge worker opens
  it. Only the app refreshes, before every use (`src/lib/integrations/tokenRefresh.ts`);
  the worker is unchanged. Before a worker trigger (knowledge ingest, Learn from repo)
  the token must have 90 minutes left: the Job has a 60 minute task timeout and one
  retry, so a retry clones at most about 60 minutes after the trigger and still has 30
  minutes in hand. Every write is compare-and-set on the access token it replaces
  (`swapTenantGitToken`, `markTenantGitReconnect`, `clearTenantGitReconnect`), so
  overlapping refreshes settle on one token and a slower request never marks a
  connection another request has just refreshed. `setTenantGitRepos` is a transaction
  that writes nothing when the connection is gone.
- **The reconnect line.** "This connection needs reconnecting." shows when a refresh was
  refused, the provider rejected the token, an older GitLab connection with no refresh
  token is over 2 hours old, or a social token has expired with no refresh token. Admins
  get Reconnect, which keeps the chosen repos; members get "Ask an admin to reconnect
  it." It is worked out when read (`src/lib/integrations/reconnect.ts`), so older
  connections need no backfill. An uninstalled GitHub App shows in Learn from repo, not
  on this line.
- **Disconnect sticks.** Social token refresh writes are compare-and-set too
  (`swapTenantSocialToken`): a refresh that finds the connection gone stores nothing,
  and the post parks as not connected.

Switches:
- **No switch for these fixes.** AGENTS.md and CONTRIBUTING.md put switches on new
  features, and these repair existing behaviour. The precedent is a2b48e0 (28 Oct, the
  GDPR erase fix), which shipped without a switch after that rule came in on 19 Oct.
  1a8c08f (5 Jul) is history only, because it came before the rule.
- **Revoke on Disconnect is new behaviour**, so it sits behind `CONNECTOR_REVOKE_ENABLED`,
  and X also behind `CONNECTOR_REVOKE_X_ENABLED`, which acts only with the first one on.
  Both are "false" in `apphosting.yaml`, and turning one off again is a config change.
  Revoke runs after the local delete, best effort, with an 8 second timeout, so a failed
  or slow provider still disconnects.
- **A new self-hosted copy.** `npm run selfhost` turns on every switch except its
  `KEPT_OFF` list (`scripts/selfhost/spec.mjs`), and that list holds
  `CONNECTOR_REVOKE_X_ENABLED` with no add-on that turns it on. So a new copy revokes at
  GitLab and on classic GitHub, which end only that brand's token, but not at X until
  its owner runs the two-brand check (`docs/self-host.md`).
- **Revoke policy** (`src/lib/integrations/revoke.ts`, `src/lib/social/revoke.ts`):
  - GitLab: yes, with the refresh token when there is one.
  - The single classic GitHub token: yes, through the one token endpoint, never
    `/grant`, which would end every brand's token for that GitHub user.
  - X: only after the two-brand check passes, because an X account connected to two
    brands may share one grant. That is why X has its own switch. X tokens minted by a
    refresh that finds the connection gone are revoked as well.
  - A GitHub App: never uninstalled, because other brands may use the installation.
  - LinkedIn and LinkedIn Pages: skipped.
  - A token replaced by a reconnect, or a classic GitHub token replaced by the GitHub
    App, is revoked only when it differs from the new one.
- **Classic GitHub revoke is a deliberate exception** to the rule that GitHub access
  goes through the read-only GitHub App. It is allowed because it only removes access.
  The classic OAuth path is to be retired later.

Google's pattern, followed:
- [developers.google.com/identity/protocols/oauth2/web-server](https://developers.google.com/identity/protocols/oauth2/web-server):
  bind `state` to a cookie so the response comes from the same browser. That is the
  nonce cookie.
- [developers.google.com/identity/protocols/oauth2/resources/best-practices](https://developers.google.com/identity/protocols/oauth2/resources/best-practices):
  encrypt stored tokens at rest, revoke tokens that are no longer needed, and keep client
  secrets in Secret Manager. Those are the sealed refresh token, revoke on Disconnect,
  and the existing secrets.
- [developers.google.com/google-ads/api/docs/oauth/credential-management](https://developers.google.com/google-ads/api/docs/oauth/credential-management):
  refresh tokens can be invalidated at any time, so plan for it. That is the reconnect
  line.

Consequences:
- No app path creates a member today: the only `addTenantMember` call adds an admin, and
  home brand claims are always minted as admin in `src/lib/auth/session.ts`. So nobody
  loses access now. Members invited later will ask an admin.
- ADR-0003 P2: its precondition ("before shipping admin-only surfaces") was crossed long
  ago, with dozens of role checks across routes and gates. There is no way to lower a
  role today, so nothing is exposed yet, but a session cookie keeps its role for up to
  5 days after one is lowered. Pieces A and M must revoke refresh tokens or read live
  claims before roles can be lowered.
- These secrets still lack AAD on the global tenant document (every access token, and
  the social refresh tokens), and are not kept in the brand's region. That is
  connectors piece 5.
- PR #46 (connect an already installed GitHub App, finish installs made on GitHub) is to
  be closed and redone on this gate and nonce, behind `GITHUB_APP_LINK_ENABLED` set to
  "false".

Where: `src/lib/integrations/` (`admin.ts`, `providers.ts`, `crypto.ts`,
`tokenRefresh.ts`, `reconnect.ts`, `revoke.ts`, `flags.ts`), `src/lib/social/revoke.ts`
and `tokenRefresh.ts`, the compare-and-set writes in `src/lib/tenant/control.ts`; help
`/help/connected-accounts` and `/developers/connect-your-code`.

---

## ADR-0005 · Sign-ups from a brand's own site go to a launch, with a site key (2026-10-25)

Context: a brand wanted its own "Get the weekly newsletter" box (not our embed) to feed
a newsletter in YouGrow. Three facts shaped the answer. API v2 users (connected-product
users) never get broadcasts or the weekly newsletter: those only go to a launch's
sign-ups, through Mailchimp tags (`waitlist-{id}`, `weekly-{id}`). The public waitlist
sign-up route only takes YouGrow's own form (no CORS; reCAPTCHA when it's on). And each
launch has exactly one journey on both engines (`journey_{id}`, `lcjw_{sha}`), which
takes everyone on the launch when it's turned on.

Owner decisions (2026-10-25), behind `LAUNCH_SITE_SIGNUPS_ENABLED`, off in production:
- **D1**: a newsletter is a launch of its own. Its one journey is the newsletter journey
  (a welcome, then the weekly step). No journey code changes, and the brand's waitlist
  launch is never touched. Rejected: a second journey per launch (both engines, and the
  sweeps that enrol everyone) and skipping journeys (a new "no journey" mark both engines
  must respect, and no welcome email).
- **Site keys**: one per launch, `ygl_…` / `ygls_…`, sealed under `CONNECT_SECRET_ENC_KEY`
  with their own purpose labels (no new secret for self-hosters), routed by the
  control-plane `launch_keys/{keyId}`, separate from `connection_keys` so a site key
  never works as a product key or the reverse. `POST /api/v2/signups`, server to server.
- **YouGrow always confirms**: a site sign-up is unconfirmed whatever the launch's double
  opt-in setting; at most one confirmation per address per launch a day.
- **D2**: the confirmation link opens a page with a Confirm subscription button (POST),
  so mail scanners that open links can't confirm for someone. Existing launches keep
  confirming on the click.
- **D3**: someone who unsubscribed can sign up again; confirming lifts their
  unsubscribe (brand-wide, and the page says so). Spam reports and hard bounces are never
  lifted. Mailchimp won't resubscribe a member it holds as unsubscribed, so they're set to
  pending and Mailchimp asks them once more.
- Unsubscribes stay in YouGrow; nothing is sent to the brand's server for these people.

Where: `src/lib/waitlist/siteKeys.ts`, `siteKeyAuth.ts`, `siteSignup.ts`,
`siteSignupHttp.ts`, `siteConfirmHttp.ts`; help `/help/newsletter-from-your-site`;
developer docs `/developers/site-signups`.

---

## ADR-0004 — Waitlist journeys move to the lifecycle engine (2026-09-24)

Context: a launch's welcome & nurture journey ran on the original waitlist
engine (a job per step in `email_jobs`), while connected products' journeys ran
on the lifecycle engine (versions, test/shadow/live, a lease per person). Two
engines meant two editors, and the original one stranded people when a journey
was paused. Owner decisions (2026-09-24): move fully, staged, one launch at a
time; people part-way through finish on the original engine; nobody ever gets
both engines' emails; new signups during a pause join and wait; people held
over 90 days leave; stranded people are recovered after a dry run; waitlist
sends are capped at 10,000 a day at any time of day and never dropped over a
cap; the owner's launches go first.

Decision (engine move D1–D6, one PR, every part behind a flag off in prod):
- **D1** — the original engine HOLDS a paused or archived journey's steps
  instead of ending them (`WAITLIST_JOURNEY_HOLD_ON_PAUSE`), and stamps each
  person's engine (`signup.journeyEngine`).
- **D2** — a lifecycle journey's audience can be a launch's waitlist (`lcjw_`
  per launch). Waitlist enrolments live in their own collection and due queue
  (`waitlist_enrolments`, two composite indexes) so product journeys are never
  slowed down. The lease/claim/commit/walk loop is shared (`enrolmentRun.ts`).
  Kill switch `WAITLIST_ENGINE_ENABLED` holds, never drops. `LIFECYCLE_MODE_CEILING`
  doesn't apply to waitlist journeys.
- **D3** — parity with the original engine: its renderer, sender, v1
  unsubscribe links, tracking, `signup.*` conditions (its own two-state
  evaluator) and A/B allocation; any-time sending; waits counted from the
  previous step; no hard stop. A converter keeps node, branch and variant ids,
  so each email's history continues. A golden parity suite runs both engines on
  a simulated clock.
- **D4** — the lifecycle editor's welcome-journey mode, one launch → journey
  mapping for every screen, and Vizzy's drafts saved as lifecycle drafts for
  moved launches (`NEXT_PUBLIC_WAITLIST_ENGINE_UI_ENABLED`).
- **D5** — per-launch switching (`campaign.waitlistEngine`: legacy, rehearsal,
  lifecycle) with rehearsal in shadow, a switch with no backfill, a drain that
  retires the original journey, and rollback; a pilot list
  (`WAITLIST_ENGINE_PILOT_TENANTS`, `*` = everyone); the zero-double-send check.
- **D6** — retirement as a switch, not a deletion: `WAITLIST_LEGACY_EDITOR`
  (`read_only`, then `retired`) once every launch has moved and drained and 30
  days have passed. The original engine keeps sending whatever is queued, and
  v1 unsubscribe links keep working, permanently. Deleting the dead code can
  wait for a later tidy-up.

Consequences: two enrolment collections to maintain; `journey_step` processing
stays until no jobs remain; readers must go through the launch → journey
mapping (`src/lib/journey/launchJourney.ts`) rather than `journey_{campaignId}`.

---

## ADR-0003 — Admin portal authentication (2026-06-15)

Context: building the admin portal (All Signups dashboard). Founder decisions:

- **Google Sign-In, restricted to the `@yougrow.ai` Workspace** (Google-only — no
  email/password in the UI). Verified via the Google `hd` hosted-domain claim,
  with an optional explicit `ADMIN_ALLOWED_EMAILS` allowlist for external accounts.
- **Claims bootstrap:** access is gated by `tenant_id`/`region`/`role` custom
  claims (a user cannot self-assign them). On first sign-in, an allowed account
  is granted admin on the bootstrap tenant (`ten_vzb`/`us`) via a two-step
  ID-token refresh (mint claims → refresh → session cookie). Per-tenant invites
  that assign claims explicitly are a later (org/RBAC) slice.
- **Session:** HttpOnly `__session` cookie (firebase-admin `createSessionCookie`),
  `verifySessionCookie(checkRevoked=true)`; tenant context derived ONLY from the
  verified claims, never from request input. The session/isolation layer is
  identical regardless of sign-in method.

Update (2026-07-05, OWASP audit A07 fix): "Google-only" is now ENFORCED in server
code, not just the login UI + console. `ensureAdminAccess` (src/lib/auth/session.ts)
requires a verified Google identity (`isVerifiedGoogleIdentity`: `email_verified ===
true` AND `firebase.sign_in_provider === "google.com"`) before the allowlist/bootstrap
run — closing a bypass where, if a non-Google provider were ever enabled on the
Identity Platform project, a self-asserted `anyone@yougrow.ai` token could pass the
domain allowlist. The check is bypassed only against the local Auth emulator (the
email/password smoke test). This also separates AUTHENTICATION (verified Google —
universal) from AUTHORIZATION (which tenant/role — the `isAllowedAdmin` allowlist +
claims bootstrap), so a **future self-service model** where verified non-`@yougrow.ai`
Google users create their OWN tenants slots in at the labelled seam in
`ensureAdminAccess` without weakening the auth gate. Reminder: keep Email/Password (and
anonymous) sign-in DISABLED on the prod Identity Platform project as defense-in-depth.

Adversarial review (post-build) findings, all addressed:
- **P0 fixed:** the public web config (`NEXT_PUBLIC_FIREBASE_API_KEY` /
  `_AUTH_DOMAIN`) was never wired into App Hosting, so the deployed client shipped
  `apiKey:"emulator"` and every login failed. Now set in `apphosting.yaml` /
  `apphosting.prod.yaml` (public values, not secrets); the client fail-loud if the
  key is missing outside the emulator.
- **P2 fixed:** added a same-origin (Sec-Fetch-Site + Origin/host) guard on the
  admin mutation route (CSRF defense-in-depth on top of SameSite=Lax).
- **P2 (bounded, tracked):** the 5-day session cookie carries claims that
  `setCustomUserClaims` alone doesn't revoke. No impact today (both roles may
  manage signups; only NEW grants happen). Before shipping admin-only surfaces
  (org/billing), call `revokeRefreshTokens(uid)` on downgrade or re-read live
  claims for privileged actions.

---

## ADR-0002 — Regional data residency (2026-06-15)

Context: founder wants regional data residency (US / EU / Asia). Validated against
current Google docs — see [REGIONAL-DATA-RESIDENCY.md](./REGIONAL-DATA-RESIDENCY.md).
An earlier sibling app already ran this named-database pattern in production.

| # | Decision | Choice |
|---|----------|--------|
| 1 | **Residency scope** | **Per tenant/brand** — each brand pinned to one region; all its campaigns + signups co-located. Keeps leaderboard/referrals/analytics single-database (the only cheap, atomic shape given no cross-database queries). |
| 2 | **What stays in-region** | **Data at rest only** — Firestore + BigQuery region-pinned; compute stays central (one US App Hosting backend reads all regional DBs) for the MVP. Full regional compute cells deferred until a latency SLA or in-transit/sovereignty requirement. |
| 3 | **Backend structure** | **Named Firestore databases in one project per env** — `(default)`=US (`nam5`), `signups-eu`=EU (`eur3`), `signups-asia`=Asia (`asia-southeast1`), one service account reaching all via `getFirestore(app, databaseId)`. Per-region BigQuery datasets. Not project-per-region. |

**Hard Google constraints baked into the design:**
- A Firestore database's **location is immutable** → `region` is set at tenant creation and never changes (enforced at the tenant write path in Phase 1). This is why `region` is front-loaded into Phase 0.
- **No Asia multi-region** — only US (`nam5`/`nam7`) and EU (`eur3`). Asia is single-region (`asia-southeast1`, ≥99.99% SLA vs ≥99.999% for US/EU).
- **No cross-database / cross-location queries.** Per-tenant residency keeps each campaign in one DB so this never bites the leaderboard.
- **Only one free database per project**; EU/Asia DBs bill from op #1 (Blaze required).
- `getFirestore(app, databaseId)` carries a stale "preview" banner but is GA and proven in the sibling prod app; `db.settings({ databaseId })` does NOT work.

**Control-plane / data-plane split:**
- Control plane = `(default)` DB: `tenants` + `tenant_users` registry (routing/membership metadata, no end-user PII). Read first to resolve `host → tenant → region`.
- Data plane = regional DBs: `campaigns` + `signups` (the PII), in the tenant's region.

**Implemented in Phase 0 (region-ready, all three databases provisioned in dev):** `Region` enum + immutable `region` on the tenant schema; `src/lib/tenant/region.ts` (`REGION_CONFIGS` + non-defaulting `databaseIdForRegion`); parameterized `getDb(databaseId)` with per-id cache; `region` on `TenantContext`/claims; `forTenant(ctx)` routes campaigns/signups to the regional DB and `tenant_users` to the control plane, and **throws if `region` is absent**.

**Founder decisions — RESOLVED (2026-06-15):**
- **Asia region = `asia-southeast1` (Singapore)** (immutable; matches the sibling app and the `gcp.resourceLocations` allow-list).
- **EU = `eur3`** multi-region (5-nines, in-EU).
- **Sovereignty = no** — residency only. Data-at-rest in-region + the `gcp.resourceLocations` org policy is sufficient. Assured Workloads / CMEK deferred unless a contract demands it.
- **Provisioning:** all three regional databases now exist in **dev** (verified): `(default)`@`nam5` (US), `signups-eu`@`eur3` (EU), `signups-asia`@`asia-southeast1` (Asia). `region.ts` has all three `provisioned: true`; `firebase.json` lists all three so `firebase deploy --only firestore` pushes the deny-all rules + composite indexes to each. (Prod: provision the EU/Asia databases there before routing an EU/Asia tenant.)

---

## ADR-0001 — MVP runtime, security posture, tenancy & scoring (2026-06-15)

Context: kickoff. The original product requirements were validated against current Google
Cloud docs (see [ARCHITECTURE-AND-DELIVERY.md](./ARCHITECTURE-AND-DELIVERY.md)).
Four decisions confirmed with the founder:

| # | Decision | Choice | Rationale |
|---|----------|--------|-----------|
| 1 | **Edge security at MVP** | **Firebase App Hosting + app-layer reCAPTCHA Enterprise + App Check** (no edge Cloud Armor yet) | App Hosting already runs behind a Google-managed LB/CDN you can't attach Cloud Armor to. App-layer `createAssessment` uses the *same* reCAPTCHA risk engine. Edge WAF mainly adds pre-compute volumetric absorption + SQLi/XSS rules — low value on a Firestore (no-SQL) MVP. If a public endpoint is later attacked, peel just that route onto raw Cloud Run + Cloud Armor. |
| 2 | **VPC-SC perimeter / CMEK** | **Defer** — no compliance driver yet | Data is encrypted at rest by default. Keep the design VPC-SC-*ready* (Direct VPC egress, scoped SAs) so the upgrade is non-breaking. Revisit on first enterprise/SOC2/GDPR driver. |
| 3 | **Tenant isolation enforcement** | **Application code**, via the centralized `forTenant(ctx)` repository | Firestore Security Rules do NOT protect server-side (service-account) access. Rules are kept as a deny-all backstop. `tenantId` is always derived server-side (host→tenant map or verified `tenant_id` claim), never from a request body. |
| 4 | **Leaderboard scoring** | Per-campaign **`spotsToMoveUponReferral`** (admin-editable integer); `score = amountReferred × spotsToMoveUponReferral`; ties broken by `createdAt ASC` | Honours the founder's "spots skipped per referral" model. `score` stays a small pure integer — we deliberately do NOT fold the Unix timestamp into it (avoids the seconds-vs-ms precision bug and a magic constant). Exact position/leaderboard math is finalized in Phase 2. Time is always integer Unix **seconds**. |

### Runtime / stack
- **Next.js 15 + React 18 + TypeScript 5.6**, Tailwind, Zod, Vitest.
- Deploy on **Firebase App Hosting**; two projects, one for dev and one for prod. Prod uses `minInstances: 1`.
- Firestore accessed via `firebase-admin` (Application Default Credentials; no key files). `firestore-bigquery-export` extension on a **Blaze** project for the analytics pipeline (Phase 2) — the BigQuery *sandbox* cannot stream.

### Data model (from the original data schema)
Root-level collections, all partitioned by `tenantId`:
- `tenants` (global registry — not tenant-scoped; resolved by id / allow-listed origin)
- `tenant_users` (flat user↔tenant associations; role `admin` | `member`)
- `campaigns` (one per waitlist; holds `spotsToMoveUponReferral`, questions, styling)
- `signups` (waitlist members; identity, state flags, referral mechanics, `score`, `answers`, `metadata`)

### Deviations from the provided schema (intentional)
- **`score` semantics:** the schema's example value looked like a folded
  `referrals*K − timestamp`. We store `score = amountReferred × spotsToMoveUponReferral`
  (pure integer) and tie-break by `createdAt` via the composite index
  `(tenantId, campaignId, status, score DESC, createdAt ASC)`. See decision #4.

### Canonical leaderboard query (fixes the index design)
The public leaderboard query is **always status-filtered** to active members:
`where tenantId == X and campaignId == Y and status == 'verified_active' order by score DESC, createdAt ASC`.
This is served by the composite index
`(tenantId, campaignId, status, score DESC, createdAt ASC)` in
`firestore.indexes.json`. No status-less leaderboard index is created (offboarded
/ deleted members never appear on the public board). **Phase 1 TODO:** add a
Firestore-emulator integration test to CI — the emulator enforces composite
indexes, which the in-memory fake cannot, so missing-index regressions need the
emulator to catch.

### Post-review hardening (2026-06-15, from the adversarial isolation review)
- **P0 fixed:** `TenantCollection.create()` now uses Firestore's atomic
  `create()` (rejects if the id exists in *any* tenant) instead of `set()`,
  closing a cross-tenant overwrite/hijack via a guessed id. Regression tests added.
- **P1 fixed:** `next` pinned to `^15.5.7` (CVE-2025-55182 / App Hosting adapter
  block); ESLint isolation rule hardened against computed access,
  transaction/batch/doc/getAll, and bare client-SDK calls, and now bans
  `firebase/firestore` + `@google-cloud/firestore` imports; the test fake now
  models `ignoreUndefinedProperties` and Firestore's missing-sort-field
  exclusion. Lint runs via the ESLint CLI (not the deprecated `next lint`).

### Known limitation — self-referral (Phase 2, accept for now)
The referral engine credits one referral per signup *document*. A determined
user can still self-refer by signing up a second time with a different contact
(`a+1@x.com`, or email-vs-phone on an `EITHER` campaign) using their own link.
Truly closing this needs identity/verification — it's deferred to the **double
opt-in** slice (and reCAPTCHA, currently flagged off). The
`referrerToken === newSignupToken` guard in `creditReferral` is cheap
defense-in-depth only (the new token is always freshly generated). Tracked, not
fixed in Phase 2 slice 1. The leaderboard ranks by `amountReferred` (not the
spots-weighted score) so it stays correct even when `spotsToMoveUponReferral` is 0.

### Open items carried forward
- Confirm exact per-field PII masking spec for the public leaderboard (Phase 2).
- Confirm leaderboard freshness tolerance (enables CDN/rollup caching vs live count).
- BigQuery PII-erasure SLA (a Firestore delete does not erase the BigQuery copy).
- **Embeddable widget — per-tenant `frame-ancestors` (deferred 2026-06-16; shipped open).** The widget (`/embed/*`, `/embed.js`) ships with `Content-Security-Policy: frame-ancestors *` and `X-Frame-Options` dropped for that route only (all other routes stay `frame-ancestors 'none'`) — so any site can embed the widget today. Acceptable for MVP: the embed exposes only what `/waitlist/<id>` already serves publicly, and the write path is guarded by reCAPTCHA + double opt-in (worst case is mild signup-form clickjacking, which double opt-in neutralizes). **To do later (gated on real third-party tenants):** restrict each tenant's widget to an approved embed allowlist. Notes for whoever picks this up: (1) this is NOT the same as `tenant.allowedOrigins` — those are the tenant's own Host-routing domains, whereas embed ancestors are the *parent sites* permitted to frame the widget; add a dedicated field (e.g. `campaign.embedAllowedAncestors` or tenant-level). (2) `next.config.ts` `headers()` is static and can't read Firestore per-request, so this needs Node-runtime middleware (firebase-admin is Node-only) or an edge-readable cache of each tenant's allowed ancestors. See `next.config.ts` (`/embed/:path*` header block) and docs/self-host.md ("Embed the waitlist on another site").
