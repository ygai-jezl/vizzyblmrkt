# Architecture Decision Record (ADR)

Running log of decisions for **vizzybl-marketing**. Newest first.

---

## ADR-0013 · Search Console queries are Google's aggregates, so they may enter brand search (decision 37) (2026-11-23)

Context: Connectors 2 group 3 (ADR-0012) puts each Search Console connection's top searches into
brand search, so the team and Vizzy can find what people search for beside what the brand wrote.
Brand search keeps people's own words out (sign up answers, AI conversations, social comments,
person plans, notes that may name a customer) until the data processing agreement covers a new
store of personal data (`src/lib/search/types.ts`, `src/lib/search/feeders.ts`). Search queries are
words people typed, so the build plan asked whether they count.

Decided (build plan decision 37, the owner's, before wave 3): **no, they are Google's aggregates.**
- A Search Console row is a count over everyone who searched those words in a day: clicks,
  impressions, click rate and position for the site, never who searched, when or from where.
- Google keeps very rare queries out of the query rows, to protect the privacy of the people who
  searched them, and counts them only in the totals (anonymized queries,
  https://developers.google.com/search/blog/2022/10/performance-data-deep-dive). What reaches YouGrow
  is only words many people searched.
- So they are not one person's own words, may enter brand search before the DPA line, and are not
  personal data in the ontology registry (`metric_snapshot` stays `personal: "none"`).

What follows (group 3, behind `CONNECTORS_SEARCH_TEXT_ENABLED`, which needs collected numbers,
`SEARCH_INDEX_ENABLED` and the brand's `brand_search` access):
- **One `research` source per Search Console connection,** ref `gsc:<connectionId>`, titled
  "Google searches: <site>". Its parts are the top 200 searches by clicks, then impressions, over the
  28 days to the last collected day (the rolled `topic` doc), each with its clicks, impressions and
  position. Never a page: page and query together is Search Console's most expensive load, and a
  search alone says what people want. No new search kind, so Vizzy's tool and its list of kinds
  don't change.
- **Refreshed weekly.** The version is the ISO week of the last collected day, so daily numbers don't
  re-embed 200 parts every day. Listed once 28 days are collected (or all the site has), so the first
  week isn't a partial window. Its link opens the Connected view with that connection selected.
- **Who finds them follows each viewer's access,** as the connection's grants say
  (`src/lib/connectors/grants.ts`). `searchBrand` takes an optional viewer: a person (`role`, `uid`)
  or Vizzy reading for one (`forRole`). With no viewer every `gsc:` hit is dropped, so a caller that
  doesn't say who is looking (Next up, the autopilot, the context pack, which are stored or shared
  with the whole team) never shows them. A hit stays only while its connection is connected and
  `can(viewer, "read_live", grants)` holds; with the switch off, none shows.
- **Erase reaches the index whatever any switch says.** `removeFromIndex` takes `{ force: true }`,
  which skips `SEARCH_INDEX_ENABLED` but still goes through `searchStoreFor`, the brand's own path.
  Disconnect, Change property and the purge remove the source with it; a failed removal leaves the
  erase pending for the lane, and a copy without the search databases has nothing to remove.
- **Switch off:** the feeder stops listing `gsc:` sources and the next sweep removes them (research
  is read in full). With indexing off too, the purge removes them.

Rejected: a new search kind (Vizzy's kinds list and a redeploy for no gain); each search with its
page (the costly query, and the page adds little to finding the words); and leaving the searches
out until the DPA (they hold no one's own words).

---

## ADR-0012 · Collected numbers: where they live, how long, and what they feed (Connectors 2) (2026-11-23)

Context: wave 3's Connectors 2 (build plan decisions 25, 35, 36 and 37; piece 2 of the Connectors
plan v5) turns the live reads Connectors 1 built into numbers YouGrow keeps. Every connected Search
Console site, Google Analytics 4 property and Cloudflare zone is collected once a day into metric
snapshots in the brand's region, kept 90 days, and erased by Disconnect. Vizzy gets a number tool,
Search Console searches go into brand search, and the numbers suggest articles. It ships as one pull
request, `feat/connectors-collect`, in four commit groups: 1 collect, keep and erase; 2 numbers for
Vizzy; 3 searches in brand search; 4 signals. This record covers all four; each group's own notes
follow as it lands.

### Decided before the plan (binding)

- **Decision 35: collected numbers live in regional Firestore with a time to live, not BigQuery.**
  Kept 90 days, about 500 rows per grouping per day. Older figures come from a live read.
  Disconnect deletes at once, the emulators and self-hosted copies need no BigQuery add-on, and
  BigQuery can't delete rows still in its streaming buffer. The build plan's gate "BigQuery tables
  for connectors 2" goes.
- **Decision 36: Connectors 2 has its own switches,** not `BRAND_SIGNALS_ENABLED` and
  `SIGNALS_DATAFORSEO_ENABLED`, which are on in prod: reusing them would turn collecting on at the
  promotion. `CONNECTOR_SIGNALS_ENABLED` needs only collect, so a copy without DataForSEO still gets
  Search Console signals.
- **Decision 37: Search Console queries are Google's aggregates,** counts over everyone who searched,
  not one person's own words, so they may enter brand search before the data processing agreement
  line. Its own entry is ADR-0013.
- **Decision 25: values are cleared when a suggestion closes.** Admins approve for now (decision 28).
  `agent_actions` has no time to live (decision 22) and clears values only on `acted` or `declined`,
  so every way a suggestion closes ends in one of those.

### Where the numbers live (group 1)

- **`metric_snapshots`, regional, through `forTenant`.** One doc per connection, generation, stream,
  grouping and day: `${connectionId}_${gen}_${stream}_${by}_${day}`, with `by` one of `day`, `page`,
  `topic` and `landing`. Rolled docs, `_r28` and `_r90`, are rewritten once a day from the day docs,
  so no hot path adds up 90 day docs on a server already near its memory limit; Search Console also
  gets planning docs (`_question_r28`, and `_subject_r28` from group 4) with a ready line per brand
  map question. Every read is by id; erase reads by equality on `connectionId`. No composite index.
- **A doc holds** the provider's own day and time zone (Search Console: Pacific time; GA4: the
  property's zone; Cloudflare: UTC), whether the day is final, `totals` by meaning key (day docs
  only: a range's totals come from day totals, never from adding page rows), and at most 500 `rows`
  `{ key, host?, m }` ranked by the main measure, with `rowsSeen`, `rowsDropped`, `more` and a `floor`
  (the last kept row's numbers) when rows were cut. A row missing from a cut day is "at most the
  floor", never a zero. A key longer than 500 characters is dropped and counted, and a doc that would
  pass 900 KB loses rows from the bottom.
- **The provider's day stays the provider's.** A daily total can't be moved into another zone, so
  "day, in the brand's time zone" (plan v5, section 6) doesn't hold, and every doc stores its zone.
- **Counts of people don't add up across days.** GA4 active users and Cloudflare unique visitors are
  left empty in every multi day total and row, with a note to read live.
- **The generation.** `collect.gen` is part of every snapshot id and goes on every row with the
  account (site, property or zone). Change property bumps it, so an old site's numbers can never
  share an id with the new site's, even if an erase fails or races a run.
- **Kept 90 days.** `ttlAt`, a Date, is the day plus the stream's `keepDays` (90, a number in the
  manifest's new `collect` block that the lane enforces). Firestore deletes expired docs "typically
  within 24 hours" and shows them until then, so writing day D also deletes D minus 90 by id, and
  readers read by day.
- **Index changes: three field exemptions, no composite.** `metric_snapshots.rows`, an array of up
  to 500 maps, and the two `ttlAt` fields (`metric_snapshots`, `data_signals`), as Google advises for
  large unqueried fields and for TTL fields. The `ttlAt` entries leave out `ttl`, so an index deploy
  only touches their index settings. firebase-tools offers to delete every field override missing
  from `firestore.indexes.json`, and that delete clears its time to live; every TTL here comes from
  `infra/lifecycle/setup.sh ttl`, so an index deploy runs `--non-interactive` with no `--force`, then
  `setup.sh verify`. `setup.sh ttl` gains `metric_snapshots ttlAt` and `data_signals ttlAt`.

### How a day is collected (group 1)

- **Only numbers that won't change, with how final each day is.**
  - Search Console: a small query grouped by date with `dataState: "final"` over the last 10
    Pacific days (Google's own presence check) lists the days that are final; only those are
    collected, once. A missing date at or before the newest listed one had no data and gets a zero
    doc. An empty probe writes nothing and holds collection until the next day. Its rows are the
    property's daily totals, so the `day` doc needs no extra call. Then one query by page and one by
    search per new day, one day each, 1,000 rows asked, 500 kept with the floor.
  - GA4: one report per grouping per day (page, `unifiedPagePathScreen`; landing, `landingPage`),
    `limit` 1,000 ordered by the main measure, with `metricAggregations: TOTAL` for the day's totals,
    at most 5 reports per `batchRunReports` (2 days a call), and `returnPropertyQuota` on every call.
    A first pass two days after the day, at 06:00 property time, is marked not final; a second pass
    on day 8 marks it final (Google: "some data can arrive late, potentially up to 7 days"). An
    answer past 512 KiB halves the limit and is retried once. `(other)` rows are left out;
    `dataLossFromOtherRow`, sampling and thresholding become notes.
  - Cloudflare: zone totals only, two UTC days after the day (the Free plan's 24 hour delay). End
    user numbers as far back as the adaptive dataset reaches; the daily totals before that, clamped
    to the `httpRequests1dGroups.notOlderThan` its settings node gives, with `basis` set.
- **Backfill.** The first collect fills 90 days, one slice per run, newest first: Search Console 5
  days a run after one 90 day totals call, GA4 6 days a run, Cloudflare all in one. A paused or
  broken connection resumes from its last day; out longer than 90 days, it starts again.
- **The lane.** Every 15th tick of the 2 minute lifecycle tick, at offset 7
  (`Math.floor(now / 120_000) % 15 === 7`), so it never shares a tick with the competitor scan, the
  search sweep or Found live, with its own 25 second budget inside the scheduler's 105 seconds.
  Brands take turns from a rotating offset, one `data_connections` query each, skipping suspended
  brands; one connection at a time, under a 60 second lease held through `changeDataConnection`; no
  new day starts with under 10 seconds left. Each run logs how far behind it is (the oldest
  `collect.nextAt` it saw). Its housekeeping (erase retries now; `connector_signals` expiry and the
  brand map reconcile in group 4) runs whenever `CONNECTORS_ENABLED` is on; collecting only with
  `CONNECTORS_COLLECT_ENABLED`.
- **Collecting is not reading.** The collector opens a connection's token as a system job (the share
  access mint, the sign in keeper or the vault), with no grant check: grants say who may see
  numbers, not whether the brand keeps them. Every way out checks grants.
- **No collect toggle, and the collector's holds stay out of health.** Pause already stops every
  call. Quota backoff for collection lives in `collect.holdUntil` and `collect.holdReason`, so a
  collect backoff never blocks Vizzy's live reads; `health.pausedUntil` stays for real provider
  failures under today's rules. Search Console's first `quotaExceeded` holds collection 15 minutes, a
  second the same Pacific day holds it to the next Pacific midnight; GA4 holds for an hour when its
  project tokens for the hour drop under 20% or after 2 server errors; 3 failed tries hold any
  connection to the next day. Every other outcome goes through the same `outcomePlan` a live read
  uses: a refused token marks the connection broken.
- **Rollback safety.** `collected` and `erased` activity rows stay off the record's recent list, as
  Vizzy's `read` rows do, because an older build's parse throws on an unknown kind there. The
  `collect` block is optional, and an older build's parse drops it.

### Erase (group 1)

- **Disconnect and Change property erase everything that came from the connection:** its snapshots
  now; its `data_signals` rows, its brand search source, its open suggestions (declined as `stale`,
  values cleared) and the undecided brand map questions it proposed (removed, not dismissed) as
  groups 3 and 4 add them. Decided questions stay: a person adopted them.
- **Disconnect** sets `collect.erasePending`, then erases after the disconnect is saved. **Change
  property** takes the collect lease, sets `erasePending` and bumps `gen` in one change, erases the
  old generation, clears `erasePending` and starts the new backfill. **The operator purge** erases
  too, whatever any switch says. Each erase is idempotent and records one `erased` activity row; the
  lane retries any connection with `erasePending` set whenever `CONNECTORS_ENABLED` is on.

### What people see (group 1)

- **Review, "Data sources that need you"** (kind `data_source`: `connection` is the product context
  endpoint's): a link item, admins only, for a connection that is broken, needs a property, has
  failed collecting since 3 or more days ago (`collect.failedSince`; `health.failures` counts calls,
  not days) or was paused by an admin 7 days ago. It links to the Connected view with that connection
  selected (`?c=<id>`).
- **Say when access was lost.** A shared connection that had worked and whose Google address was
  removed from the property shows `share_access_lost` ("YouGrow lost access to this property on 19
  Nov. ...") instead of the first time message. Health keeps `since`, when the failures in a row
  began, for that date.
- **The Connected view** gets a Collected column and a Collected numbers block on the Manage card
  (last day, days kept, rows a day, filling progress), hidden while collect is off. The manifests'
  `where` lines lose "Nothing is stored."; each collected stream says it is kept 90 days in the
  brand's region and Disconnect deletes it, on the Listing and the help page only while collect is
  on.

### Numbers, searches and signals (groups 2 to 4)

- **Planning uses a connection only when both members and Vizzy may read it.** Next up is stored once
  per brand and read by everyone and by Vizzy; brand map proposals are seen by the whole team. None
  can follow one viewer's access, so signals, Next up lines and pack numbers come only from such
  connections, and the Connected view says which ones feed planning. No third grant.
- **Vizzy's numbers** (`get_connected_numbers`) read snapshots by id behind their own limit,
  `connectors_numbers` (burst 10, 120 an hour), with the canvas token giving the brand and role and
  the connection's Vizzy grant checked; every number carries its meaning. The server works out the
  period; Vizzy never computes dates.
- **Searches in brand search** are one `research` source per Search Console connection
  (`gsc:<connectionId>`), refreshed weekly, and a hit shows only to a viewer who may read that
  connection.
- **The decision lives on the agent action; `data_signals` only indexes it.** Plan an article moves
  the action to `acted` with its link; Dismiss to `declined` (`dismissed`), values cleared and the
  row blanked, kept 30 days so it doesn't come back. A rising search becomes a proposed brand map
  question with the map at scale (`RecordFrom` gains `search_console`; older builds read it as
  `person`), else a Review suggestion. The lane reconciles brand map proposals once a day instead of
  hooking every decision path. Strict starting thresholds, row cuts respected, at most 5 new and 15
  open per brand.
- **Open to every plan.** Collect, numbers and signals cost about 2 to 3 cents a brand a month, so
  there is no per brand check. Next up lines appear only where Next up is already allowed (Ultra).
- **`BrandSignal` stays DataForSEO only:** its queue, lease and cost fields are DataForSEO's, and
  `readySignals` feeds the Get from Google screens.
- **Out of scope:** DataForSEO as a connector (piece 5), Cloudflare AI crawlers by bot and page (a
  later card: other datasets, some paid only), and YouGrow's own form view and product event counts,
  whose registry gaps move from "(connectors 2)" to "(semantic layer)".

### Switches

All server side, `"false"` in the "== Connectors ==" group of `apphosting.yaml`, empty in
`.env.example`, and kept off by `npm run selfhost`.

| Switch | Group | Needs | Self-host |
| --- | --- | --- | --- |
| `CONNECTORS_COLLECT_ENABLED` | 1 | `CONNECTORS_ENABLED`. Erase and housekeeping never depend on it | `KEPT_OFF`, addon null |
| (none) | 2 | `CONNECTORS_CHAT_ENABLED` and collect, else 503 | |
| `CONNECTORS_SEARCH_TEXT_ENABLED` | 3 | collect, `SEARCH_INDEX_ENABLED`, `brand_search` | `KEPT_OFF`, addon `search` |
| `CONNECTOR_SIGNALS_ENABLED` | 4 | collect, and 0e's indexes READY | `KEPT_OFF`, addon null |

A connector manifest may never claim a platform switch: a refine refuses `CONNECTOR_SIGNALS_ENABLED`
and `CONNECTOR_GOOGLE_REVOKE_ENABLED` as a connector's `switch` or a sign in method's, and `signals`
joins the reserved connector ids.

**What each switch leaves behind when turned off:**

| Off | Stops | Stays until |
| --- | --- | --- |
| `CONNECTORS_COLLECT_ENABLED` | collecting, the Review row, the Connected column, the numbers route | snapshots expire within 90 days, or Disconnect or the purge removes them |
| `CONNECTORS_SEARCH_TEXT_ENABLED` | new `gsc:` sources | the next sweep removes them, or the purge if indexing is off |
| `CONNECTOR_SIGNALS_ENABLED` | detection, Review suggestions, chips, pack lines, the suggestions route | open suggestions expire within 30 days (the lane still expires them); undecided proposals are withdrawn at expiry |
| `CONNECTORS_ENABLED` | everything | erase still runs from the purge, whatever any switch says |

Reverting the whole pull request is safe: snapshots and signals leave through their time to live,
the sweep removes `gsc:` sources once the feeder stops listing them, and agent actions are left
declined or expired. A brand that wants its data gone at once runs the purge before the revert.

### Owner gates

The TTL policies (`setup.sh ttl`, then `setup.sh verify`) before collect or signals go on in an
environment; the index deploy with no `--force`; 0e's indexes READY before `CONNECTOR_SIGNALS_ENABLED`;
a published consent screen before the dev soak (Testing mode sign ins end after 7 days; share access
is unaffected); the three switches added as `"false"` to a deployment's own file before its sync;
and a Vizzy redeploy after groups 2 and 4.

---

## ADR-0011 · Connected data: the connector core and Cloudflare (Connectors 1) (2026-11-21)

Context: wave 2's Connectors 1 (build plan decisions 13, 32 and 33; the Connectors plan v5, whose
nine decisions were all accepted) builds a shared connector core and the first three connectors:
Cloudflare with an API token, then Google Search Console and Google Analytics 4. It ships as one
pull request in three commit groups. This record covers group 1, the core and Cloudflare; groups 2
(sign in with Google, Search Console) and 3 (share access, GA4, Vizzy) have their own sections below. The
Browse, Listing and Connected screens wait for the owner's OK on their mockups. No dependency, index,
rules or infra project change. Switches, all `"false"` in a new "== Connectors ==" group in
`apphosting.yaml`, empty in `.env.example` and kept off by `npm run selfhost`: `CONNECTORS_ENABLED`,
`NEXT_PUBLIC_CONNECTORS_ENABLED` and `CONNECTOR_CLOUDFLARE_ENABLED`.

Decisions:

- **Names.** A connection's record is `data_connections` (ids `dcn_`), its activity
  `data_connection_activity` (ids `dca_`), and people read "Connected data". "Connection" already
  means a connected product (`product_connections`, `pcn_`) and a Review kind.
- **A manifest is pure data** (`src/lib/connectors/manifest.ts`): connect methods, fields, api
  hosts and limits, one verify request, shares, produces, uses and hooks. Code a connector needs is
  named by a hook id (`cloudflare.zoneProbe`) and lives in `src/lib/connectors/handlers`, so the
  same file could come from a contributor or a vendor later. A test proves every manifest survives
  a JSON round trip. The ids `browse`, `callback`, `connections` and `connected` are reserved
  because routes and pages sit beside `[connectorId]`. Every permission or scope a sign-in asks for
  needs a shares line that names it, and shares must say what is never read or written.
- **The registry** (`src/lib/connectors/registry.ts`) offers a connector only while its own switch
  is on (each needs `CONNECTORS_ENABLED`), refuses a sign-in method not built yet (token_fields now,
  oauth_pkce with group 2, share_access with group 3) and any stream marked personal until the data
  processing agreement covers it.
- **Switch off and rollback.** With `CONNECTORS_ENABLED` off every connector route answers 404
  before it reads the session, nothing calls a provider, and sealed tokens stay sealed, working
  again when the switch is turned back on. Rolling back means turning the switch off; removing the
  data means `scripts/connectors-purge.ts` (dry run first, then `--apply --by <label>`), which works
  whatever the switches say.
- **The vault** (decision 32, `src/lib/connectors/vault.ts`). Its own root key,
  `CONNECTORS_VAULT_KEY` (core secret `connectors-vault-key`), AES-256-GCM through `secretBox`, with
  AAD `tenant:connection:slot` so a blob opens nowhere else. `secretBox` gains `keyId(label)`: the
  first 8 bytes, in hex, of an HMAC of the root. Each blob stores `encKeyId`, because `keyId`
  already means a ygk_ connection key id. Saving with no root is refused.
  - Rotation: set the old root as `CONNECTORS_VAULT_KEY_PREVIOUS` and a new current root, roll out,
    run `scripts/reseal-connector-secrets.ts` as a dry run, then with `--apply`, then the dry run
    again. Remove the previous root only when it counts 0 off the current key, or every token still
    on it is lost. API tokens never refresh, so "reseal on the next refresh" would never reach them.
  - The reseal works per connection in a transaction, opens and compares each new blob before it
    replaces the old one, reports a blob that won't open and never replaces it, and runs on the
    emulators with `--local` as the organisation scripts do.
- **Tokens live per connection in the brand's regional database.** Social and git tokens stay on
  the control plane brand record without AAD, so two patterns sit side by side until Connectors 5
  moves them.
- **One writer, one transaction.** `src/lib/tenant/dataConnections.ts` writes a connection and the
  activity row of each change together. Activity rows carry `ttlAt` as a Date, 90 days on, deleted
  by the TTL that `infra/lifecycle/setup.sh ttl` turns on. The record keeps the last 20 changes for
  the Connected view, so the activity log is written and never queried. `forTenant` gives the records
  read only and the activity a count. Every query is by id or equality with no sort (a shape test
  holds it), so no composite index is needed.
- **Safe fetch** (`src/lib/connectors/safeFetch.ts`), the one outbound call for connector APIs:
  the exact host must be declared in the manifest, over https on 443, before any request; a paused
  connection is refused; rate limits per connection and per brand for the connector
  (`isRateLimited`); `security/ssrf.ts` `safeFetch` with `maxRedirects: 0` and `allowedPorts: [443]`.
  That helper copies the same init, Authorization included, into every redirect hop, so with 0 any
  3xx ends the call after one request, and a 3xx that comes back anyway is refused: a token is never
  sent to a second address. Its own timeout; the body read up to the manifest's cap, 512 KB at most
  (`readBytesUpTo`, which tells an empty body from one cut short); logs name the host and the code,
  never the path, query, body or token.
- **Health.** ok, check, broken and paused. A refused token, an account the token can't read or a
  token that won't open sets broken. A provider's rate limit pauses calls for its Retry-After (1 to
  60 minutes, 15 when it gives none) and five failures in a row pause them for an hour. Because
  `isRateLimited` fails open, that pause on the record is the hard stop. Each code has plain words
  (`src/lib/connectors/messages.ts`); a provider's own words are never stored.
- **Grants** (`src/lib/connectors/grants.ts`, tested cell by cell):

  | Who | Sees name and health | Sees details | Reads live | Manages |
  | --- | --- | --- | --- | --- |
  | Admin | yes | yes | yes | yes |
  | Member | yes | no | with `{to: "members", can: "read"}` | no |
  | Vizzy | with `{to: "agent:vizzy", can: "read"}` | no | with its grant, and the members grant when reading for a member | never |

  Only admins change grants, and a new connection starts with none. "Manage" is the admin role, not
  a grant. The admin who connected (`ownerUid`) gets nothing extra, and the connection stays when
  they leave. Grants don't fit the settings log's fixed subjects and archive only model, so they live
  on the record and each change goes into the activity log; piece O part 2 can move them.
- **Routes** under `/api/admin/connectors` check the switch, then go through `integrationsAdmin`
  (origin check, sign-in, role). Only the list, one connection and its live read let a member in;
  the grants table decides the rest. `src/lib/connectors/routesGate.test.ts` fails when a route
  skips the switch or the gate. Connect runs the manifest's verify request before anything is
  saved, and one account is connected once per brand.
- **Cloudflare.** The token is checked with a GraphQL zone query, not `user/tokens/verify`, which
  may refuse account tokens and doesn't prove the token reads this zone. GraphQL answers HTTP 200 on
  errors, so the `errors` array is read first. Requests and page views come from
  `httpRequests1dGroups`; visits only from `httpRequestsAdaptiveGroups` (`sum.visits`, sampled,
  about 31 days on every plan), so when only that part fails the totals come back with a note. The
  token needs Zone Analytics Read, and Zone Read to list the zones it can see (see Cloudflare's
  Listing under Screens). It is also asked for Account Analytics Read (see Screens). A pre-filled
  link fills in all three (keys `analytics`, `zone` and `account_analytics`).
  Disconnect deletes the stored token; Cloudflare can't cancel it for us, so the answer says to
  delete it there.
- **Live reads** are bounded: at most 93 days and 100 rows, a fixed list of dimensions per stream,
  page paths without query strings, and every number with its meaning. A number with no meaning is
  dropped.
- **Meaning keys are namespaced** (`cfRequests`, `cfPageViews`, `cfVisits`), because plain
  impressions and clicks already mean social post numbers.
- **The ontology.** `data_connection` (personal: the team's; a secret, never exported or searched)
  is built. As finally built (with groups 2 and 3) it has three stores, `data_connections`,
  `data_connection_activity` and `data_connection_states`, and claims all 11 meanings (cf, search
  and ga4) through Vizzy's number tool, `read_connected_live`; group 1 first claimed the cf
  meanings through `readLive`. `connector_manifest` stays planned: manifests live in code, with no
  store.
- **Not metered** (owner, 21 Nov): every plan can connect. A plan hook comes later if a connector
  gets costly.
- **Self-hosted copies.** `connectors-vault-key` is a core secret. The `backend` step now reads each
  core secret's IAM policy and gives the backend access to any added since it last ran, which before
  failed the next rollout with `Error resolving secret version`. `docs/self-host.md` has Connected
  data and the upgrade note: existing copies run `--apply core`, then `setup.sh ttl` once.

### Group 2: Sign in with Google and Search Console

Switches, `"false"` in the Connectors group, empty in `.env.example` and kept off by
`npm run selfhost`: `CONNECTOR_SEARCH_CONSOLE_ENABLED` (needs `CONNECTORS_ENABLED` and a Google
client) and `CONNECTOR_GOOGLE_REVOKE_ENABLED`. Settings, by name only in the public repo:
`CONNECTOR_GOOGLE_CLIENT_ID`, `CONNECTORS_OAUTH_ORIGIN` and the secret `CONNECTOR_GOOGLE_CLIENT_SECRET`.
The screens (Listing, Connected, the site picker) wait for the mockups; everything they call is
built. Grounded in Google's "Using OAuth 2.0 for Web Server Applications" and the Search Console
API reference, read through the Developer Knowledge MCP.

- **The client lives in an identities project of its own**, never the app project, so the app's own
  admin sign in (Firebase Auth) is never put through Google's app verification or limited to test
  users. While that project's consent screen is in testing, Google ends each sign in after 7 days,
  so dev connections need reconnecting weekly until it is published. `webmasters.readonly` is non
  sensitive (checked in the console on 21 Nov), so Search Console's Sign in can go on in prod after
  Google's brand check alone.
- **The flow:** authorization code with `access_type=offline` and `prompt=consent` (a refresh token
  on every sign in), one scope per connection, no `include_granted_scopes`, PKCE S256 (documented by
  Google for installed apps; the dev check confirms the web client accepts it, and the bindings
  below hold without it).
- **Four bindings, all checked before a code is swapped:** a state signed with the vault's own state
  key (`connector-state-v1`) naming brand, connector, admin and a nonce, 10 minutes; this attempt's
  httpOnly cookie, its name from the nonce so two tabs never clash, holding the nonce and the PKCE
  verifier, SameSite=Lax (Strict would drop it on Google's redirect back) and path scoped to
  `/api/admin/connectors/callback`; a single use record in the new regional
  `data_connection_states` (id the nonce's SHA-256, `usedAt` set in a transaction, then deleted,
  `ttlAt` a Date for the TTL that `setup.sh ttl` turns on); and PKCE. The X and LinkedIn flows never
  consume their state; this one does. Another brand's state, another admin's, another browser's
  cookie, an expired or replayed state are each refused and tested.
- **Routes.** `POST /api/admin/connectors/[connectorId]/start` is a same-origin admin request
  (`integrationsAdmin`) answering Google's address and setting the cookie. `GET
  /api/admin/connectors/callback` has no origin check because Google's redirect is cross-site; it
  uses `integrationsHopAdmin` (admins only), and sends people back by path only, never built from the
  request's host, to the connector's Listing page with `status` and `reason`, with no code or token.
  `CONNECTORS_OAUTH_ORIGIN` pins the redirect address; a production server without it refuses to
  start (fail closed), and a local run uses the request's origin.
- **After the swap** the granted scope must be exactly the one asked for (one missing or one extra
  is refused), a refresh token must have come, and the connector's verify request must pass, before
  anything is saved. Every refusal has plain words (`SIGNIN_REASONS`).
- **A site is picked after signing in.** A sign in reaches every site the Google account sees, so a
  new connection is saved with no account and reads nothing until an admin picks one from
  `sites.list` (unverified sites left out, at most 200), through `GET` and `PUT
  .../connections/[id]/accounts`. The pick is checked against what the sign in sees then, refused
  when another of the brand's connections reads that site, and recorded as `account_picked`.
  Signing in again for a connection (`start` with its id) keeps its site, grants and history.
- **The token keeper** (`src/lib/connectors/tokenKeeper.ts`), modelled on GitLab's refresh: refresh
  5 minutes early, only under a 30 second lease on the record (as `claimSignal`); compare-and-set on
  the sealed access token; keep the refresh token when Google sends none; on `invalid_grant`, read
  the record again inside the write and mark it broken (`signin_refused`) only if nobody saved a new
  token meanwhile; a 5xx, 429, timeout or network error is soft and the current token is used while
  it works; `invalid_client` is this copy's setup and marks nothing.
- **Disconnect deletes the tokens; revoking at Google sits behind
  `CONNECTOR_GOOGLE_REVOKE_ENABLED`, off** (owner, decision 2): Google's revoke ends every grant that
  Google account gave the app, so it can cut off another brand, the problem ADR-0006 found with X.
  The purge revokes behind the same switch. The help words say how to remove access in a Google
  account.
- **Search Console.** Hosts `searchconsole.googleapis.com` and `oauth2.googleapis.com` only. Google's
  reference writes the paths under `www.googleapis.com/webmasters/v3`; the same paths answer on the
  API's own host, which the dev check confirms. Live reads: `searchAnalytics.query`, web results,
  finalized data, by date, page or query, at most 93 days and 100 rows; pages cut to their paths and
  rows for one path added together. Lag 3 days, Pacific time dates. Meanings `searchClicks`,
  `searchImpressions`, `searchCtr` and `searchPosition`, claimed by `data_connection`. Google's error
  reasons tell this copy's setup (API not on), a quota and a site the account can't read apart.
- **Help.** Generated words now cover signing in: which account, the unverified warning, the 7 day
  testing limit, Google's limit of 100 sign ins per Google account for one app (the 101st quietly
  ends the oldest), reconnecting, removing access, and every reason a sign in didn't finish.
- **No index change**: states and connections are read by id or equality (shape tests). Self-hosted
  copies follow "Connect Google data on your own copy" in `docs/self-host.md`; there is no selfhost
  step for the identities project yet.

### Group 3: Share access, Google Analytics 4 and Vizzy

Switches, `"false"` in the Connectors group, empty in `.env.example` and kept off by
`npm run selfhost`: `CONNECTOR_GA4_ENABLED` (needs `CONNECTORS_ENABLED`, and the identities project
or GA4's Sign in), `CONNECTOR_GA4_SIGNIN_ENABLED` (GA4 by Sign in, with the Google client) and
`CONNECTORS_CHAT_ENABLED` (needs `CONNECTORS_ENABLED`; addon `vizzy`). One
new setting, by name only in the public repo: `CONNECTORS_IDENTITIES_PROJECT`. No new collection,
index, rules or dependency. The screens (Share access steps on the Listing, Check access, the
property picker) wait for the mockups; every route they call is built. Grounded in Google's IAM docs
(projects.serviceAccounts create, delete and list; iamcredentials generateAccessToken; the IAM roles
reference; service account quotas) and the Analytics Admin and Data API references, read through the
Developer Knowledge MCP.

- **One Google address per connection** (`src/lib/connectors/shareAccess.ts`). Share access makes a
  service account for that one connection in the identities project, so removing one brand's access
  never touches another's, and Disconnect can delete it outright. Its account id is `ygc-` and 20
  random characters (Google's rule: 6 to 30 characters, `[a-z]([-a-z0-9]*[a-z0-9])`); it never holds
  the brand, because the admin pastes the address into their property. The description names the
  connection, a one way brand tag and a one way copy tag (SHA-256 prefixes of the tenant id and of
  `GOOGLE_CLOUD_PROJECT`), so the operator purge can find a brand's leftovers and never takes
  another copy's addresses for them when two copies share an identities project; an address with no
  copy tag is never deleted as a leftover. Only the identities project's operators can read it.
  Each copy should still have an identities project of its own, because the quota is per project.
- **Least privilege.** The app's runtime account holds three roles on the identities project only:
  Create Service Accounts (`iam.serviceAccounts.create`, `get`, `list`), Delete Service Accounts and
  a custom role with only `iam.serviceAccounts.getAccessToken`; not Service Account Admin or Token
  Creator. The addresses get no roles of their own. Calls are the app's own, with its token from
  `google-auth-library`, through `security/ssrf.ts` safeFetch to `iam.googleapis.com` and
  `iamcredentials.googleapis.com` only, with no redirects, on 443, a timeout and a capped body.
- **Tokens last 300 seconds and are never stored.** `generateAccessToken` with the connector's one
  read scope and `lifetime: "300s"`, on `projects/-/serviceAccounts/{email}` (the wildcard Google
  requires), kept in the server's memory until a minute before they run out and forgotten on
  disconnect. A shared connection keeps no sealed secret; its record holds the address
  (`serviceAccount {email, uniqueId, createdAt, deletedAt}`).
- **Check access retries.** IAM reads are eventually consistent and Google says a new account can
  take 60 seconds or more to work, so minting a token for an account younger than 10 minutes retries
  after 1, 2 and 4 seconds, then answers `share_pending` ("Google is still setting up this
  connection's address"), which leaves health alone. `POST .../connections/[id]/access` lists what
  the address sees for the picker and checks the picked one, recorded as `access_checked`. Nothing
  visible is `share_not_visible` ("We can't see your property yet"), which marks it broken.
- **Starting share access** is `POST /api/admin/connectors/[connectorId]/share`, admins only. A brand
  with a shared connection still waiting for its property gets that one back, and making addresses
  is limited per brand (3 a minute, 10 an hour), so the project's quota isn't spent by double
  clicks. That limit lets a request through when its store fails, so a brand also holds at most 5
  addresses per connector (`SHARE_ADDRESS_CAP`: connected ones, plus disconnected ones a failed
  delete left at Google), counted by equality queries; past it, `share_limit` says to disconnect one
  or sign in with Google. One brand can't fill the project every brand shares. A shared connection's failures read in its own words: a refused token or property is
  `share_not_visible`, an API or permission missing in the identities project `share_unconfigured`.
- **Quota plan and fallback.** A project holds a limited number of service accounts (100 by
  default; deleted ones don't count). The owner asks Google for more on the identities project. A
  full project answers `share_quota`, which says so plainly and offers Sign in with Google.
- **Self-hosted copies.** Without `CONNECTORS_IDENTITIES_PROJECT` the share access method is not
  offered (the registry's readiness check), which is how a copy without one behaves; Sign in with
  Google still works. `docs/self-host.md` says how to set one up. A selfhost add-on is a follow up.
- **Disconnect deletes the address** at Google after the disconnect is saved, by its unique id, so a
  later account with the same name is never touched; already gone counts as done. A failed delete is
  recorded as `cleanup_failed` and the address stays on the record. The address's entry in the
  property's users stays until the admin removes it; the help says it does no harm.
- **The purge reconciles.** `scripts/connectors-purge.ts` deletes each purged connection's address,
  lists YouGrow's addresses in the identities project and deletes the brand's that no live
  connection owns (a crash between making an address and saving its connection, or a failed
  delete). `--addresses` does only that, plus disconnected connections' leftover addresses, and
  leaves every record and its history alone; `--local` never reaches a real identities project.
- **Search Console by share access**: the admin adds the address as a Restricted user. Google
  documents service accounts as Search Console users only for the Indexing API; the dev check proves
  it reads search analytics before prod turns it on.
- **Google Analytics 4** (`google-analytics`, `analytics.readonly`, which Google classes as
  sensitive: Sign in waits for Google's sensitive scope review, share access as a Viewer doesn't).
  The Google client that Search Console's Sign in uses would otherwise bring GA4's Sign in with it
  as soon as GA4 goes on for share access, through an unverified app (Google's warning, the 100 user
  cap, and a risk to the client every Search Console sign in shares). So the manifest's `oauth_pkce`
  names a switch of its own, `CONNECTOR_GA4_SIGNIN_ENABLED`, off, which the registry's readiness
  check and the start and callback routes read; the registry refuses a method switch nothing reads.
  The picker is the Admin API's `accountSummaries.list` (3 pages of 200 at most). Live reads are the
  Data API's `runReport` by `date` or `pagePath` (the path without its query string), at most 93
  days and 100 rows, with `returnPropertyQuota`; metrics are matched by Google's header names;
  `(other)` and `(not set)` rows are left out; thresholding, sampling, a property low on tokens and
  days not yet final each become a note. Lag 2 days, in the property's time zone. Meanings
  `ga4Sessions`, `ga4ActiveUsers`, `ga4Views` and `ga4KeyEvents`, claimed by `data_connection`.
- **Vizzy reads, never manages.** `GET /api/agent/connectors` and `POST /api/agent/connectors/live`
  go through `src/lib/connectors/agentGate.ts`, a copy of `resultsAgentGate`: the switch (503 when
  off), the signed canvas token (the brand comes only from it) and 10 a minute, 60 an hour per brand,
  because each read spends the provider's quota. Vizzy reads for the token's person: anything but
  admin reads as a member, so a connection needs `{to: "agent:vizzy", can: "read"}` (403
  `no_agent_grant` without it) and, for a member, the members grant (403 `no_read_grant`). The list
  shows only granted connections and says only that others aren't shared. A read is the people's
  bounded read; every number comes with its meaning and nothing else in an answer is a number. Each
  read is logged as `read` by `agent:vizzy`, kept off the record's recent list
  (`ActivityWrite.recent: false`) so Vizzy never pushes an admin's changes off the Connected view.
- **Vizzy's tools** `list_connections` and `read_connected_live`: a pure client and a thin ADK
  wrapper, the brand only from the session token, input checked before any call, and a system
  instruction to read numbers by their meaning and lag, say plainly when it has no access and that an
  admin can allow it, and never claim a change. Tools change only with a Vizzy redeploy (ask first);
  the ontology names `read_connected_live` as `data_connection`'s number tool.
- **Help.** Generated words cover share access (what is kept, Check access, why it may be hidden,
  what Disconnect leaves, the Workspace sharing message), Google Analytics and letting Vizzy read,
  and the troubleshooting quotes.

### Screens

Built from the approved Design canvas (Browse, the Search Console and Cloudflare Listings, the
picker and Connected), in the app's own Tailwind. Every screen calls the routes above, and
Cloudflare's Listing adds one, the token check below.
Hidden while `NEXT_PUBLIC_CONNECTORS_ENABLED` is off; a connector's card and Listing only while its
own switch is on and a way to connect is ready (the list route already decides that).

- **The Settings tab is Connections again** (owner, 21 Nov), not Integrations: the tab list, the
  breadcrumbs, places, the help pages and the post messages that point there. The rename isn't
  switched, because every message names the tab. Inside it, with the switch on, a layout adds the
  sub-tabs **Accounts** (the GitHub, GitLab, LinkedIn and X panel, unchanged, on the base route every
  callback returns to), **Browse** and **Connected**. `connected` joins the reserved ids. Email
  sending stays under Sending.
- **Tiles show two letters, as the approved screens** (owner, 22 Nov): SC, GA and CF. A manifest
  may give its own (`initials`, two capitals or digits), which a one word name such as Cloudflare
  needs; without it the screens take its words' first letters, leaving out a version number and
  Google in a longer name, and a one word name gives its first two letters.
- **One server read per request** (`src/lib/connectors/screens.ts`, through `listForActor`, so a
  member gets name and health only) feeds the layout's Connected count and the page; changes go
  through the routes and the page refreshes.
- **The Listing** follows the manifest's order: Sign in with Google first, then share access (Make
  the address, Copy, the manifest's steps and role, Check access), or the token fields. Sign in comes
  back to the Listing; a new one goes on to the picker. A token can't be replaced in place (connect
  refuses an account already connected), so Reconnect on a turned down token disconnects it, connects
  the new one and copies its grants.
- **Cloudflare's Listing is token first, as its approved mockup** (owner, 22 Nov; the first build
  typed the Zone ID beside the token). The admin pastes the token and presses Check:
  `POST /api/admin/connectors/[connectorId]/check` (admins only, behind the switch and gate connect
  uses, the vault checked, rate limited per brand) runs the manifest's `accounts` hook,
  `cloudflare.zones` (`GET /client/v4/zones`, which needs Zone Read, at most 4 pages of 50), with the
  token for that one call. Nothing is saved, sealed or logged beyond safe fetch's host and code, and
  the token is never sent back. The admin picks a zone from the list, and Connect checks the token
  against it with the zone probe before saving, as before. A token Cloudflare refuses outright
  (401, or codes 1000, 6003 and 6111) is turned down; one that may not list zones (403, or none
  listed) falls back to a typed Zone ID with a short note, and so does a zone past the 200 listed. A
  token method picks from a list when its manifest gives `pick` (the list's label and that note),
  which needs `hooks.accounts`. Each way to a typed Zone ID has its own words (owner, 22 Nov): the
  manifest's note when the token can't list zones, and "Cloudflare listed more than fit here, so type
  the Zone ID of the one you want" after Type the Zone ID; the field's own hint says only where to
  find it, and the help page says it is typed only when Check doesn't list your zone.
- **Account Analytics Read is asked for too** (owner, 22 Nov, as the approved Listing), beside Zone
  Read and Zone Analytics Read, so later features that read account analytics don't need every
  admin to make a new token. Nothing reads with it today. The manifest rule still holds: its shares
  line says it is asked for now and that nothing is read with it, the steps say the same, and the
  link fills it in with Cloudflare's template key `account_analytics` (from Cloudflare's token
  template docs). The steps also say to include only the site's account under Account Resources.
- **The picker** lists what the sign in or address sees and marks, never blocks, one whose website
  isn't the brand's root domain; with no root domain, or a property whose name doesn't say its
  website, nothing is marked. Cancel on a new connection disconnects it.
- **Connected** shows who connected each connection as You or Someone else, because the record holds
  only a user id and there is no name lookup per brand yet, and a sign in as "Signed in with Google",
  because the Google account's email isn't kept.
- **The help page** `/help/connected-data` (`onlyWhen: "connectors"`) renders the generated words.
  The How to drawer renders it in the browser, so the words now read a pure catalog
  (`src/lib/connectors/catalog.ts`) and `lag.ts`, and a test walks their imports; the Vizzy section
  shows only with `CONNECTORS_CHAT_ENABLED`, passed to the drawer like the other server switches.

### Follow-ups: reads match the provider's own report (2026-11-23)

The owner's dev check found Vizzy's Search Console impressions for "the last 28 days" off the Pages
report, for the home page and for one other page. A read-only review traced
it to the days read and to merging page rows, and found the same kind of gap in GA4 and Cloudflare.
No new switch: these ride the connector switches.

- **The server picks the days, not Vizzy.** A live read asks for a `period` (`yesterday`,
  `last_7_days`, `last_28_days`, `last_90_days`) or explicit `from` and `to`, never both. Each hook
  resolves a period the way its provider's report does, in the provider's time zone
  (`src/lib/connectors/period.ts`; a stream's `timeZone` in its manifest where it is fixed, and
  "today" from `Intl.DateTimeFormat` in that zone). Explicit days are capped at the provider's last
  complete day with a dated note. Every answer returns `period {from, to, timeZone, finalThrough,
  words}`, `totals` where the provider gives them, `more` when rows were left out, each note once,
  and the connector's id and name for a source line. The stream's lag stays in `list_connections`
  and on the screens, no longer repeated in each answer. A read by day keeps the latest days when it
  cuts. An optional `page` filter (one path) works where a stream lists it (`liveFilters`): GA4
  matches it exactly, and Search Console on every host of the site, keeping each host a row of its
  own.
  Vizzy's read row in the activity log keeps the stream, grouping, days read, limit, period and
  whether a page filter was used, never a number or the page.
- **Search Console.** A probe grouped by date over the last 10 days with `dataState: "all"` reads
  `metadata.first_incomplete_date` (either spelling); the day before it is the last complete Pacific
  day (the newest day listed without it, yesterday with nothing listed). Google documents that date
  as the first day still being collected, not as the report's boundary, so the dev check compares
  the days read with the report's Dates tab. Reads use `dataState: "all"` ending on that day, as the
  report does, and `rowLimit` 1,000 before page rows for the same host and path are added together;
  different hosts stay apart (`host` beside `page`, which stays the path and the join key), and a
  merged row says how many addresses it adds up (`merged`, a meaning of its own that no manifest
  lists). A read for one page asks for `page` beside its grouping, so a read by day or search for
  `/` gives a row per host too, never www and the bare host added together. The report's headline
  totals (clicks, impressions, click rate, position for the site) come from the same query with no
  dimensions, except for one page (its rows are by host) and settled reads; if that query fails,
  the rows stand with a note. Google finishes a day 2 to 3 days later and the read doesn't ask
  which, so the note on those days says they "may not be final yet". `settledOnly` reads final
  numbers only, for Connectors 2.
- **GA4.** A period goes to Google as its relative dates (`28daysAgo` to `yesterday`), which Google
  resolves in the property's time zone; the answer's `metadata.timeZone` names it. Explicit days whose
  last one isn't over there are read again ending yesterday. `metricAggregations: TOTAL` and
  `rowCount` give the totals (users counted once) and a "lists N, shows the top M" note. Pages group
  by `unifiedPagePathScreen` with views, active users and key events (Pages and screens), web paths
  only: an app's screen class (`MainActivity`) isn't a page, so it is left out with a note. A new
  `landing` grouping by `landingPage` with sessions sends no filter, as the Landing page report's
  table doesn't (only its chart leaves out `(not set)`), so its totals and `rowCount` are the
  report's; the `(not set)` row is left out of the rows instead. It joins on page
  (`LIVE_BY_JOINS`). Days ask for every day with `keepEmptyRows`, and a read by day for one page
  asks for that page's views, active users and key events, never sessions, which by page match no
  report (one page's sessions come from `landing`).
- **Cloudflare.** Requests, page views (successful HTML responses) and visits come from end users
  (`requestSource: "eyeball"` on `httpRequestsAdaptiveGroups`), as the dashboard's Traffic tab shows,
  for the days the zone's settings node (`notOlderThan`, `maxDuration`) allows, with Cloudflare's
  documented floor (31 days kept, 30 a request) when the settings can't be read. Older days come
  from `httpRequests1dGroups`, which count all traffic, with a note naming them. Unique visitors
  (`uniq.uniques`, what the Free plan's dashboard shows) come from the daily totals. Totals for the
  period come from the same datasets with no dimensions, as the dashboard's: unique visitors always
  (daily visitors can't be added up), and end user requests, page views and visits when every day
  read is within their reach. Days are UTC, ending yesterday, and a read that reaches yesterday
  notes the Free plan's 24 hour delay, so `finalThrough` stops the day before. The page
  view filter (`edgeResponseContentTypeName: "html"`, status 200 to 299) and the settings field
  names come from Cloudflare's docs and public queries; the dev check compares a read with the
  Traffic tab set to UTC.

### Follow-ups: Vizzy's connected answers (2026-11-23)

The same dev check showed Vizzy's table as raw pipes on one line, and an answer padded with the
dates it asked for, the freshness fact twice and a line of filler.

- **Tables in the chat.** `MarkdownMessage` reads pipe tables with the blog's own reader, moved to
  `src/lib/content/markdownTable.ts` so the two can't disagree. No new dependency (react-markdown
  and remark-gfm stay out). Unswitched, like the earlier canonical fix: it fixes every chat.
- **Answers in a few lines.** `read_connected_live` takes a `period` and an optional `page`, with
  dates only for days the person named. The connected-data rule says the order: the answer in one or
  two sentences, the period as `period.words` gives it, then a short list or a small table only when
  3 or more rows are compared on 2 or more numbers, a note once, `totals` for totals, and never
  zeros for rows left out when `more` is true. The general format line says the same for numbers.
- **A source line.** The chat reads the connector id from a successful `read_connected_live`
  result on the stream and shows that connector's mark and name, linked to its dashboard (a
  manifest's new optional `home`). Google Analytics shows its linked wide logo, as its branding
  policy asks of a commercial app that shows its data. Names, marks and links come from the
  manifests, never from the stream, and Vizzy's payloads still carry no icon data.

### Follow-ups: connector marks (2026-11-23)

- **Official marks now (owner, 22 Nov),** knowing Google's and Cloudflare's published rules ask for
  permission first. The files, owners, sources and hashes are in `public/marks/NOTICE.md`, and
  `LICENSING.md` keeps them out of YouGrow's licences, with the site's other brand marks.
- **The Cloudflare cloud is a crop, for the owner to clear.** The press kit's `Logos.zip` holds only
  the full logo with the word Cloudflare, no cloud on its own. The icon is that logo cut to its
  cloud with its colours unchanged, and Cloudflare's trademark guidelines say not to modify its
  marks. The crop goes to Cloudflare with the permission request; until then, deleting the
  manifest's `icon` shows CF.
- **The Google Analytics logo links into Google Analytics** (`analytics.google.com`), which its
  branding policy allows, so every source line under a Vizzy answer leads to where the numbers can
  be checked.

---

## ADR-0010 · People (piece B) (2026-11-21)

Context: piece B of the CRM and tiers plan turns Audience into People and adds what a CRM
needs on top of the person record: fields, filters, adding someone by hand, a timeline and
Vizzy's suggestions. It also starts the settings log (piece O part 1) and stops catalog
history being pruned. It ships as one pull request in eleven commit groups, all covered here.
The only Firestore changes are the two composite indexes and the four field exemptions below;
`src/lib/settings/indexes.test.ts` checks every composite query the piece makes has its index,
and the field exemptions. No dependency, rules or infra change. Seven switches, all `"false"` in
`apphosting.yaml` and empty in `.env.example`: `NEXT_PUBLIC_NAV_PEOPLE_ENABLED`,
`AUDIENCE_FIELDS_ENABLED`, `AUDIENCE_FIELD_FILTERS_ENABLED`, `AUDIENCE_ADD_PERSON_ENABLED`,
`AUDIENCE_TIMELINE_ENABLED`, `AUDIENCE_VIZZY_FIELDS_ENABLED` and
`AUDIENCE_VIZZY_ADD_PERSON_ENABLED`, with the settings log, catalog history and the rules that
keep people added by hand needing none. Help: your-audience (with Data model, filters, Add
someone by hand, the timeline and Vizzy and their fields), people, review-and-approvals,
plan-and-usage and connect-your-product.

Owner decisions (build plan decisions 27 to 31, and the answers of 2026-11-20):

- **People in the words people read (group 1, decision 27).** `NEXT_PUBLIC_NAV_PEOPLE_ENABLED`
  (BUILD and RUNTIME, `"false"`) renames Audience to People in the sidebar, ⌘K, the header
  crumbs (also the page label Vizzy is told), page titles, the How to button and help. The
  nav key `audience`, the `/admin/crm` route, the `/api/admin/audience` paths,
  `src/lib/audience`, the contacts collection and the `/help/your-audience` slug keep their
  names, as `programmeWord()` did for programmes.
  - It needs nav phase 3 and the one People list. The list is a server switch, so
    `isPeopleNameEnabled()` is worked out in the admin layout and passed down as a `people`
    prop to the sidebar, ⌘K, the header and `ShellProvider`. People never sits over the
    old Signups and Product users tabs.
  - Help bodies take an optional `people` prop. The `/help` routes, Markdown copies and
    llms-full.txt work it out on the server; the How to drawer renders in the browser,
    where server switches read off, so it passes the shell's answer.
  - Vizzy's Python can't read the switch, so its prompts and relayed messages use words that
    fit both names ("from your list of people"). Any redeploy is safe.
- **The settings log (group 2, decisions 30 and the answer on who changed it).**
  - One version per change in the brand's regional `settings_versions`, with no
    organisation id: piece O reads an organisation's history through its brands.
  - `commitSettingsChange` (`src/lib/tenant/settingsLog.ts`) is the only writer. The setting
    and its version are written in one regional transaction. The setting keeps its `rev`
    and versions have fixed ids (`ss_<hash of brand and subject>_r<rev>`), so a write reads
    two documents by id and needs no index, and a retry never writes a second version. A
    stale rev returns `settings_changed`. Versions are created, never updated or deleted:
    `forTenant` gives them read only.
  - Who saved a version is piece 0's event actor, ids only. Names are looked up when shown
    (`teamMemberNames`, `src/lib/team/names.ts`), and anyone no longer on the team shows as
    "Former team member".
  - Items are archived, never removed: every save goes through `assertNoRemoval`, and a
    type change makes a new item and archives the old one with `replacedBy`. A restore is a
    new version on top.
  - The People and Company field lists (subjects `fields:person` and `fields:company`) live
    in the regional `record_field_lists`, one document per brand and subject. The registry
    lists that store under `settings_version` until the fields are built (group 4), which
    gives it to `custom_field`. The version shape keeps a draft state for piece O; only live
    versions are written.
- **Catalog history kept whole (group 2, decision 30).** No more pruning: every version is
  kept. A new version stores the saver's user id, never their address. The list reads by
  (tenantId, connectionId, rev DESC) with a cursor, and falls back to the old query while
  that index builds. `scripts/scrub-catalog-savers.ts` replaces the addresses already
  stored with user ids, or null (dry run, then `--apply`). Until it runs, an old address
  shows as it is. The version is still written just after the save, best effort, as
  before.
- **Indexes (asks approved with the plan).** `settings_versions (tenantId, subject, rev
  DESC)` and `catalog_revisions (tenantId, connectionId, rev DESC)`.
  `src/lib/settings/indexes.test.ts` checks each new query shape has its index.
  - Field exemptions (approved 2026-11-21): `settings_versions.snapshot` and
    `settings_versions.items` (`indexes: []`), in the shape of piece 0's `ontology_events` and
    `agent_actions` exemptions. Versions are read only by id or by subject and rev, and each
    holds a whole setting, so indexing every option label in it would only cost writes.
- **People added by hand are kept (group 3).** A contact may carry `addedBy` (a team
  member's user id or an agent action's id, when, and from the form, ⌘K or Vizzy) and
  `consent.marketing_email` (state, how, note, who recorded it, when). The kinds are
  `member` and `agent`, matching piece 0's event actors.
  - Being added by hand is a source of its own, keyed on `addedBy`, with no switch:
    turning New person off never lets a sync delete or hide anyone. `summarize` takes it as
    an input: the person is live, tagged `all` and `added:hand`, and active from when they
    were added, and their reach is yes only with marketing email granted, an email address
    (someone added with only a phone can't be emailed) and no brand-wide opt-out. `added:hand` stays internal: the People list has no pill for it (owner, 20 Nov).
  - Every path keeps them: `syncPerson` and the fast path read it from the record inside
    the transaction; the delete branch and the product-only rename skip them; their status
    stays active when a sign-up goes; a later sign-up never replaces a typed name.
  - Tags other writers own (the field writer's `field:` tags and `added:hand`) are carried
    over by every sync and compared with the rest, so a sync never wipes them and never
    writes when only they differ. Field tags are carried only while the person is in Everyone
    (`all`): someone whose last launch goes keeps their values but loses the tags, so a field
    filter is always part of Everyone, and the sync that brings them back rebuilds the tags
    from their values (`repairFieldTags`). The field writer makes none for someone out of
    Everyone.
  - A record holding the team's field values is never deleted by a sync. One that only came
    from products stays, out of Everyone, when its last product user goes another way (the
    product is revoked, the user moves to a new address, or a `pu:` person joins an address),
    as a sign-up contact whose launches went does. Only a product user's erase removes it
    with its values (`erase: true` on `personAfterProductErase` and on the dry run that
    decides whether to erase the history), and that erase also reaches the people the user
    left behind on a move (`forgetLeftBehindPeople`: their `pu:` person, and earlier
    addresses from `person_moves`).
  - **Values follow the person (approved 2026-11-21).** On a product user's address change or
    a `pu:` record merging into an address, the `person_repoint` job first moves the values off
    each record their pending moves left behind (out of Everyone) onto the person they are now,
    through the one field writer (`moveRecordFieldValues`, one transaction): a value goes where
    the new record has none for that field (its own values win; one it already holds just leaves
    the old record), with `record.field_changed` on the new record (source "sync", by the system)
    and one clearing it on the old, both records' field tags in step, archived fields included.
    A value that would push the new record past its budget stays behind, logged as a code with a
    count. Event keys carry both records, the field and the moment, and a moved value is no longer
    there to move, so a retried job writes nothing twice. A record left empty is synced again, so
    one nothing else keeps goes as it would have without values, and its history follows in the
    walk; one still holding a value stays, and the product user's erase still reaches it. A record
    still in Everyone (a sign-up, another product user, added by hand) is still someone in People
    and keeps its values. A sync a product write couldn't make is made by the job first (a record
    left behind still in Everyone while it owes one, `needsSync`, or a new record not there yet),
    then the move is tried once more. Values that still didn't move (a failed transaction, or that
    sync failing again) keep their record's history with them, and the job answers "again" with
    its moves still pending, from the history stores, counting runs on the job (`valueTries`); at
    `MAX_VALUE_TRIES` (5) it settles the moves and logs `move_field_values_left_behind` with a
    count, and the values stay as with a value that won't fit. The timeline shows each value that came with them ("Came with them from
    their earlier record") and not its clearing. No switch of its own: values exist only once
    fields were on, and the job runs only with `ONTOLOGY_PERSON_IDS_ENABLED`.

- **Fields: data and the one writer (group 4, decisions 28 and 30, answer 2).**
  `AUDIENCE_FIELDS_ENABLED` (RUNTIME, `"false"`) is read in `src/lib/audience/peopleFlags.ts`
  with the one People list and, by decision 25, `ONTOLOGY_PERSON_IDS_ENABLED`, so every value
  change is filed under its person. That file imports both flag files, which avoids the cycle.
  - Twelve types (`src/lib/types/recordField.ts`): text, number, currency, date, checkbox,
    select, multi select, status, email, phone, link and team member. Currency is whole minor
    units with the code on the field; a date is a calendar day with no time; a team member is a
    user id, named when shown, and "Former team member" once they leave.
  - One list per brand per object in the regional `record_field_lists`, saved only through
    `commitSettingsChange`, so every change is a settings version. Field ids are `fld_` and 12
    characters, option ids `opt_` and 8. A field is archived, never deleted, and its type is
    fixed once made: a type change makes a new field and archives the old one with `replacedBy`;
    old values stay under the archived field. Options are archived, never removed, too: a restore
    brings back the older version's options as they were and archives any added since, and the
    settings log refuses a save that drops an option, as it does a field. Caps: 100 fields in use, 300 in all, 50 options,
    and the whole list under 200 KB, which keeps it under the document limit and the settings
    snapshot whatever the counts.
  - One writer, `src/lib/tenant/recordFieldWrites.ts`: in one regional transaction it reads
    the list, the record and any agent action, checks each change against the list as read
    there, and writes the dotted `fields.<id>` patch, a person's `field:` tags, one
    `record.field_changed` per changed value (companies too, with no person) and the action's
    decision. It takes an optional `agentAction`, so Vizzy's confirm (group 10) needs no
    rewrite. The record is budgeted at 900 KB. A source scan keeps every other writer off
    `fields`, and `syncPerson` never touches it. An option archived since may stay in a value
    while the record holds it (and an undo may put it back), so the value can still be edited;
    a newly chosen option must be live. The editor shows such an option as no longer in use.
  - Admins change lists and values; members read. Routes sit behind `fieldsAdmin`, in
    `oneViewAdmin`'s order. A stale rev answers 409 `fields_changed`, a broken cap 400
    `field_list_full`.
  - Export and erase whatever the switch says: the whole person export lists values with labels
    and the archived mark; values go with the contact and the company, and their events with the
    history. Company values stay when one of several people there is erased, a gap the registry
    names; a person's export leaves out their company's values.
  - Index ask (approved): `contacts.fields` and `companies.fields` exempt from automatic
    indexing, as `contacts.products` already is.
- **Fields on screen, with the voice chat (group 5, answers 3, 10 and 11).**
  - Fields are managed in Settings › Data model (`/admin/account/data-model`). Its tab is a
    server switch, worked out in the account layout and passed to `AccountTabs`; How to opens
    `/help/your-audience#fields`, and the How to drawer gets `fields` from the shell, as it gets
    `people`. Restoring an older list waits for piece O's settings history screen; the route is
    there.
  - Fields panels on a person's page and on the company panel: admins edit values in place,
    members read, archived fields are hidden.
  - Fields from elsewhere are worked out when shown and never stored
    (`src/lib/audience/readOnlyFields.ts`): sign-up answers from each of the person's sign-ups,
    labelled with their launch, read only because questions are keyed by their text, which
    admins can edit; each product's stage, traits and facts; company enrichment.
  - The voice chat on a sign-up page: B shows a read-only Voice chat field with its summary,
    labelled as sent by the person's browser and unchecked. What was said stays out of
    `loadWholePerson` and is served only by `GET .../everyone/[personId]/conversation`, behind
    `voiceChatAdmin`: admins only, as export is, and only while the Fields panel or the timeline,
    which link to it, is on. Analysing it (a server summary, suggested values,
    themes, brand search) is the later "Voice chat insights" card, after the DPA.
- **Filters (group 6, answer 4).** `AUDIENCE_FIELD_FILTERS_ENABLED` (RUNTIME, `"false"`, needs
  fields) gives the People list a menu for each select, multi select, status and checkbox field,
  and "Everyone in this group" on a person's page (`?group=<connectionId>:<entity id>`). Field
  pills and the group filter share the switch.
  - Each value is a `memberOf` tag the field writer keeps in step: `field:<fieldId>:<optionId>`
    for a select or status and for each option of a multi select, `field:<fieldId>:yes` for a
    ticked checkbox, at most 50 a person. `isFilterTag` accepts them and `group:` tags, whose
    entity ids may hold `.` and `:`. They use the existing (tenantId, memberOf, sortKey) and
    (tenantId, reach, memberOf, sortKey) indexes: one filter at a time, as before. No new index.
  - Counts: the filters route lists the fields without counts and counts one field's options
    with `?field=` when its menu opens, so a page load never runs a count per option.
  - Archived fields and options keep their tags with their values; their pills are hidden, and a
    restore brings them back with nothing to run. No "Added by hand" pill: `added:hand` stays
    internal (owner, 20 Nov). Companies have no filters in B.
  - The tags are written whatever the filters switch says (they are derived and harmless), for
    people in Everyone, and the sync's keep-field-tags rule has no switch. `scripts/backfill-field-tags.ts` rebuilds them
    from stored values (dry run, then `--apply`), for values written without them.

- **New person (group 7, decisions 28 and 29, answers 6 and 8).** `AUDIENCE_ADD_PERSON_ENABLED`
  (RUNTIME, `"false"`) needs the one People list and the person ids (decision 25). Admins add
  someone by hand from a New person button on People, the empty list, and Create in ⌘K (the
  layout passes `canAddPerson`, which opens `/admin/crm?new=person`). Members can't.
  - **Keyed like a sign-up:** the normalised address, or the phone trimmed and nothing more,
    so a later sign-up with the same address or phone joins them. Someone can be added with
    only a phone; the form notes that a later sign-up with an email becomes a separate person.
    Normalising phones is its own decision. A key already held opens that person (200
    `existing`) and writes nothing.
  - **One transaction:** `addPerson` (`src/lib/audience/addPerson.ts`) creates the contact, its
    `record.created` event and, when they agreed, its `consent.recorded` event through
    `writeRecordWithEvents`. The record is group 3's hand-added summary (tagged `all` and
    `added:hand`, live, active from now), with the address's opt-outs read first,
    `needsSync: false`, no launches, `addedBy` (member, user id, when, form or palette) and the
    company a work address matches. It is never enriched (enrichment needs a confirmed
    sign-up) and never on a launch's Signups tab. Field values are checked against the list
    first and set through the one writer once the person exists.
  - **Ways to agree:** Told me in person, Signed a form, Replied by email, and Other, which
    needs a note (`in_person`, `signed_form`, `email_reply`, `other`). Kept on the record as
    `consent.marketing_email` (granted, how, note, who by user id, when) and as a
    `consent.recorded` event, which is the proof. Reach is yes only with it and no brand-wide
    opt-out. `PATCH .../everyone/[personId]/consent` records it later for someone added by hand
    only; anyone else answers 409 `consent_elsewhere`, because their consent comes from their
    launch or product (piece F decides the rest).
  - **Can email** on someone added by hand means the team recorded that they agreed. No send
    path reads them yet: journeys and broadcasts reach people added by hand with lists (piece
    E). The form, the list ("Yes, recorded", "Not yet") and the person's page say so.
  - **Withdrawing is in B (approved 2026-11-21); piece F still owns consent for every
    channel.** `POST .../everyone/[personId]/consent/withdraw` (`{ note? }`, admins only, behind
    `AUDIENCE_ADD_PERSON_ENABLED` with the person ids, in New person's gate order) withdraws what
    the team recorded for someone added by hand: in one `writeRecordWithEvents` transaction the
    entry becomes withdrawn (`how` "withdrawn", who by user id, when, the note) with a
    `consent.recorded` event of state "withdrawn", and reach is worked out again through
    summarize's hand-added input, so what the team recorded no longer counts towards can email
    (a launch or product of theirs still can) and every later sync keeps it. Withdrawn already writes nothing; nothing recorded answers 409 `nothing_to_withdraw`,
    anyone not added by hand 409 `consent_elsewhere`, another brand's person 404. Recording
    agreement again is the same PATCH as the first time. The person page's Consent card has
    **Withdraw** for admins (members see the state), the list says "Withdrawn", the timeline
    shows it, and export and erase cover the entry and its event. Consent from a launch or a
    product is untouched: that stays piece F's, and for someone who also joined a launch or uses
    a product the confirm says that agreement still stands (`withdrawElsewhere`).
  - **The plan's people:** the form reads piece A's `checkAllowance` and says when under 1% of
    the limit is left or it is passed. It never blocks (gates guide, never lock).
  - Rate limited per admin; export and erase cover `addedBy`, the consent and both events
    whatever the switch says, with no code change.

- **Timeline (group 8, answer 5).** `AUDIENCE_TIMELINE_ENABLED` (RUNTIME, `"false"`) needs the
  one People list and the person ids. It gates the recording as well as the screen: nothing is
  written while it is off, and history starts the day it goes on, with no backfill.
  - **Moves are recorded inside `syncPerson` and `syncProductLink`,** after their commit, so every
    caller is covered (the write hooks, the sweep's owed syncs and daily check, the previous-key
    sync, the owed fallbacks). `src/lib/audience/personMoves.ts` turns a sync's tag changes into
    moves with an explicit list: `launch:<id>` (`sys.launch.<id>`), `product:<id>`
    (`sys.product.<id>`), `stage:<id>:<stage>` (`sys.stage.<id>`; a swap in one product is one
    move, from one stage to the other) and `quiet:<id>` (`sys.quiet.<id>`). Ignored: `all`,
    `launch:any`, `product:any`, `via:*`, `group:*`, `field:*` (the field writer records those),
    `added:hand`, `launches:many` and unknown prefixes.
  - Each move is a `record.field_changed` made by the system at the sync's `changedAt`, keyed
    `move|<personId>|<changedAt>|<tag>`, written in one `appendEvents` batch per sync: a retry
    writes nothing twice. A product's moves carry its product user, so erasing or moving that
    product user takes them along. Best effort: a lost move leaves a gap, never a wrong value.
  - **Never recorded** on a dry run, for a person who was deleted, on the erase path
    (`personAfterProductErase` passes `moves: "skip"`, so no row is written after the history
    it would belong to was erased), or by `scripts/backfill-person-links.ts`, which passes
    `moves: "skip"` so a rebuild never floods timelines.
  - **The read** (`src/lib/audience/personTimelineView.ts`, `GET .../everyone/[personId]/timeline`,
    members can read) pages piece 0's `listPersonEvents` (index `(tenantId, personId, at DESC)`,
    piece 0's) and merges in their sign-ups, launch emails and voice chats between this page's
    oldest event and the last page's, under its own opaque cursor. Each product's own story stays
    on its part of the page, so `personTimeline` is not repeated. A launch joined shows once, as
    the sign-up; a first stage comes with starting to use the product.
  - Export and erase cover the moves whatever the switch says, with no code change: piece 0's
    history erase and export find them by person and by product user. No new index.

- **`productUserId` where `personId` meant a product user (group 9, decision 13 of piece 0).**
  `personPlans.ts` (its parameters and the plan's id), `exportPerson` and the admin folder
  `api/admin/audience/people/[personId]` (now `[productUserId]`; the URLs are unchanged) say
  `productUserId`. The person page route keeps its name, because it serves both kinds of id.
  - **Both names work for a while,** so either side can deploy first: the `person_plan` canvas
    scope takes `productUserId` or `personId` (given both, they must match), and the brief names
    its product user as `productUserId` and as `personId`. Vizzy's tools take
    `product_user_id`; its client reads `productUserId` or `personId` and sends both in the
    plan's scope. Once Vizzy has been redeployed everywhere, a later change drops `personId`
    from the scope and the brief.
  - **Deviation:** the agent route `api/agent/lifecycle/people/[personId]` keeps its segment
    name. Like the person page, it takes a whole person's `ct_` id as well as a product user's,
    so `productUserId` would be wrong for half its callers; the rename reaches what it returns.
  - The chat's `personId` state key stays: it names the person in view, of either kind.

- **Vizzy reads fields and suggests edits (group 10, decisions 31 and answer 7).**
  `AUDIENCE_VIZZY_FIELDS_ENABLED` (RUNTIME, `"false"`) needs fields and not the lifecycle person
  brief. Off in production until the DPA line, like every B Vizzy part.
  - **Who's open:** `isPersonInContextEnabled()` (the brief, or this switch) decides whether the
    shell's chat names the person in view, and the chat route checks it again, so the id never
    leaves the app otherwise. "Whenever fields are on" is read as this switch: telling Vizzy who
    is open while it can read nothing about them would only send an id. The Ask Vizzy panel offers
    the situation's starters with the brief, and starters about fields without it.
  - **What Vizzy reads:** `GET /api/agent/audience/fields` and
    `GET /api/agent/audience/people/[personId]/fields` (signed canvas token, rate limited, 503
    `unavailable` while off) serve only select, multi select, status, checkbox, number, currency
    and date fields in use, never text, email, phone, link or team member ones, scrubbed of the
    person's name and address (`identityScrubber`), with the fields that already have a suggestion
    waiting. They read the contact directly, so they work for people who only joined a launch or
    were added by hand. Google's Agent Sandbox stays an option for analysis that needs more.
  - **Suggestions:** the `person_fields` canvas kind saves an agent action
    (`person_fields.suggest`, agent `vizzy`) through `proposeAgentAction`: admins only (a token
    without a role fails closed), rate limited, checked against the live list. The proposal holds
    the suggested values under `fields` and a reason of at most 280 characters, scrubbed; the
    basis holds the values it changes from. The dedupe key is the person and a hash of the change
    and its basis: the same suggestion again answers with the one waiting, and a decided one is
    never raised again from the same values. A newer suggestion for a field declines the waiting
    one as `superseded`. Each waits 30 days, then the tick declines it as expired (group 11).
  - **Confirm, dismiss, undo:** `.../everyone/[personId]/proposals` (members read, admins decide,
    behind `vizzyFieldsAdmin`). Confirm goes through group 4's writer with source `agent` and the
    action's move to acted (agent.approved then agent.acted) in one transaction, with
    `expect: basis`: the writer refuses with `stale` unless each field still holds what the
    suggestion was made from, and the route then declines it as stale with a plain message. Undo
    writes `undo.before` back with source `undo`, `expect: result`, and agent.undone; a field
    changed since refuses with `edited_since`. Undo is offered for 7 days. The writer's new
    `expect` map is the only change to it.
  - **Review:** a new kind, `person_suggestion` ("Suggestions about people"), listed from
    `listOpenAgentActions` (piece 0's index on action, state and createdAt). Titles name only the
    brand's own field labels, never the person, their address or a value. The person's page reads
    their actions by equality only.
  - **Vizzy:** Lifecycle Ops gains `people_fields_list`, `person_fields_read` and
    `person_fields_propose`, with rules on what it sees, when to suggest, that a person confirms,
    that it never records consent, and that fields work when the brief is unavailable. The root
    agent's block for the person in view says one person's page and sends their fields there too.
    The tools exist once Vizzy is redeployed; until then and while off, the routes answer
    unavailable.
  - Export and erase cover suggestions whatever the switch says, with no code change: piece 0's
    history export and erase find agent actions by person.
  - **Text fields Vizzy may read (owner's choice, 2026-11-21).** On dev the owner asked Vizzy for
    a Job Title text field and it couldn't see it. A per-field opt-in: an admin ticks "Vizzy can
    read this field" (`vizzyReads`, only on a People text field, off by default) in Data model, and
    Vizzy reads and suggests it like the seven types, always confirmed by a person.
    `vizzyReadsField` (`src/lib/types/recordField.ts`) is the one rule for the reads, suggestions
    and New person drafts. A text value is scrubbed of the person's name and address as stored and
    in words, and cut to 500 characters; Vizzy's text over 500 characters, or holding `[name]`,
    `[email]` or `[id]`, is refused, so a scrubbed value never goes back over the real one. A
    value Vizzy read cut can be cleared, never written over. A proposal over the agent action
    limits answers `too_large`. A restore or Bring back can untick it, never tick it. Once it is
    unticked, confirming sets a waiting text suggestion aside (checked inside the write's own
    transaction), and a New person draft no longer fills the field in.
    Email, phone, link (web addresses often name someone and the scrubber doesn't know them) and
    team member fields stay hidden whatever is set. `AUDIENCE_VIZZY_TEXT_FIELDS_ENABLED` (RUNTIME,
    `"false"`, needs Vizzy's fields) is a kill switch for free text alone: off, the tick can't be
    changed, the checkbox and "Vizzy reads" column are hidden and every text field stays hidden.
    Off in production with the other Vizzy switches until the DPA line. Vizzy needs a redeploy for
    its new words.

- **Vizzy fills in the New person form (group 11, decisions 29 and 31, answer 9).**
  `AUDIENCE_VIZZY_ADD_PERSON_ENABLED` (RUNTIME, `"false"`) needs New person, not Vizzy's fields.
  Off in production until the DPA line.
  - **The draft:** the `new_person` canvas kind saves an agent action (`new_person.draft`) with
    `personId = personIdOf(key)`, the key worked out exactly as New person does (the normalised
    address, else the trimmed phone), so erasing that person finds it. Admins only, rate limited.
    The proposal holds the typed name, address or phone and field values; `clearDetailsOnClose`
    clears them with any decision, and it expires after 7 days. Each request has its own dedupe
    key (a random part), so a dismissed draft never blocks asking again; the same details again
    answer with the draft waiting, and new details for the same person replace it (declined as
    superseded, details cleared). Someone already in People gets no draft, only a link to their
    page.
  - **Never consent:** the request has no place for it and one that tries is refused
    (`consent_not_allowed`); the form starts at Not yet and the admin says how they agreed.
  - **Field values** only of fields Vizzy may read (the seven types, or text fields Vizzy may
    read: see Text fields Vizzy may read), named by label or id, options by label or id; anything
    else comes back to Vizzy as a warning for the admin to type. Names and addresses typed into
    chat pass through Vizzy to fill the form, as they already did whenever someone typed them.
  - **Confirming runs group 7's create:** the card and Review link to `/admin/crm?draft=<id>`,
    the id only. The form loads the draft from the admin-only drafts route and posts to the New
    person route with `draftId` and `via: "vizzy"` (refused without a draft id); after the create,
    or for an address already held, the route moves the draft to acted with only
    `{ personId }` in its result and the details cleared. Two steps, not one transaction: if the
    close were lost, the details still go at expiry. Dismiss declines it and clears the details.
    A draft whose typed address was changed in the form keeps its first person id, with no
    details left in it.
  - **Expiry runs whenever person links are on**, not behind a Vizzy switch: after the people
    sweep, the lifecycle tick calls `expireDueAgentActions`, which declines every action past its
    expiry a page at a time within the run's deadline. That clears a draft's details and sets
    aside field suggestions after their 30 days. A Firestore TTL policy would do it without code
    but needs a gcloud change, so the tick does it.
  - **Vizzy:** the root agent gains `new_person_propose` (adding someone isn't about the person in
    view). Its rules: nobody is added until an admin confirms, it never records consent, never
    asks for details the operator didn't offer, and what it sent is kept 7 days at most.
  - **Review** lists open drafts under Suggestions about people, titled without anything about the
    person. The timeline of someone added from a draft says Vizzy filled in New person for them.

Rollback: turning `NEXT_PUBLIC_NAV_PEOPLE_ENABLED` off (a rebuild) changes only words. The
settings log has no switch and nothing calls it until the fields. Never revert group 3 once
anyone has been added by hand: without the `addedBy` rule the next sync would delete them. Once
field values exist, turn `AUDIENCE_FIELDS_ENABLED` off rather than reverting: the values stay on
the records, and export and erase still cover them. Turning the filters off hides the pills; the
tags stay. If the field writer were reverted, rerun the backfill once it is back. Turning
`AUDIENCE_ADD_PERSON_ENABLED` off hides the form and its routes; everyone added stays. Turning
the timeline off stops recording and hides it; the rows stay and are exported and erased.
Reverting group 9 is safe only while Vizzy still sends `personId` too; after a Vizzy that sends
only `productUserId`, keep the app's scope taking both. Turning `AUDIENCE_VIZZY_FIELDS_ENABLED`
off stops Vizzy being told who is open (unless the brief is on), makes its field routes answer
unavailable and hides suggestions; open ones stay, expire on the tick, and are exported and
erased. Turning `AUDIENCE_VIZZY_ADD_PERSON_ENABLED` off stops new drafts and hides their links; open
drafts still expire on the tick with their details cleared, and erase still finds them. Keep the
tick's expiry once any draft exists. Turning `AUDIENCE_VIZZY_TEXT_FIELDS_ENABLED` off hides every
text field from Vizzy at once; the ticks stay on the fields, Data model can't change them while
it is off, and they count again once it is on.

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
