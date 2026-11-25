# The YouGrow ontology

Generated from `src/lib/ontology/registry.ts`. Don't edit this file: change the registry, then run `npm run ontology:doc`.

Every kind of thing YouGrow knows about, built or planned: where it is kept, whether it holds the brand's people, how it is erased and exported, how it is found, and how its numbers reach an agent. The spine runs from an idea to its signals, an optional product, customers and support, with rails beside it. A new collection or file store needs an entry in the registry: `src/lib/ontology/coverage.test.ts` fails until it has one.

102 types: 81 built and 21 planned.

On rows, `personId` means the `ct_` id of a person record (`src/lib/ontology/person.ts`). Events share one envelope (`src/lib/ontology/events.ts`).

## Idea

Spine step 1. A hypothesis, its site and its waitlist.

### Idea (`idea`)

A business idea being tested: a hypothesis with its waitlist, its questions and its emails. Called a launch in the app; the data stays in `campaigns`. With LAUNCH_IDEAS_ENABLED it carries `idea`: a hypothesis, a status with who set it and when, an outcome, the product it was handed off to, and Just a list for a newsletter or sign-up list that isn't an idea. The states are its status, set by an admin; closing the waitlist (`archivedAt`) is separate, and a parked or killed idea only offers it. Status and hand-off changes are record.field_changed events (`sys.idea.status`, `sys.idea.product`) on `idea:<campaignId>`.

- Status: built
- Home: the brand's region
- Personal: no
- Stores:
  - `campaigns`, the brand's regional Firestore, in `src/lib/tenant/repository.ts`
- Links: `signup` through signups.campaignId (many); `site_key` through launch_site_keys, by launch id; `launch_journey` through journeys.campaignId; `broadcast` through broadcasts.campaignId (many); `invite` through invites.campaignId (many); `knowledge` through campaigns/{campaignId}/knowledge_bases (many); `product` through idea.productConnectionId, once handed off; `ontology_event` through subjectKey idea:<campaignId> (many)
- Events: `record.field_changed`
- States: `exploring`, `testing`, `validated`, `launched`, `parked`, `killed`
- Erase:
  - `deleteLaunch` in `src/lib/tenant/launchDeletion.ts`, on deleting a launch
- Export: none. The brand's own settings, with no one's personal data.
- Search: none. Found by name on the Launches screen; what it sends is searched as broadcasts and journey emails. Its hypothesis and outcome are not searched and have no agent path until piece C puts ideas on the brand index.
- Numbers: gap. People counts per launch and product reach Vizzy through get_counts with no meanings (`src/lib/audience/agentCounts.ts`); the funnel the compare screen shows for each idea has no agent tool.

### Site key (`site_key`)

The key a brand's own site uses to send sign-ups to one launch, sealed, with its lookup in the control plane.

- Status: built
- Home: the brand's region
- Personal: no
- Stores:
  - `launch_site_keys`, the brand's regional Firestore, in `src/lib/tenant/repository.ts`
  - `launch_keys`, control plane Firestore, in `src/lib/tenant/launchKeys.ts`. The lookup from key id to brand, no secret.
- Links: `idea` through the launch id
- Erase:
  - `deleteLaunch` in `src/lib/tenant/launchDeletion.ts`, on deleting a launch
  - `deleteLaunchKey` in `src/lib/tenant/launchKeys.ts`, on removing the record
- Export: none. A sealed secret, never exported.
- Search: none. A secret, never searched.
- Numbers: none. No numbers an agent reads.

### Sign-up (`signup`)

One person joining one launch's waitlist: their address or phone, answers, referral and consent. An identity of a person.

- Status: built
- Home: the brand's region
- Personal: yes, the brand's people
- Stores:
  - `signups`, the brand's regional Firestore, in `src/lib/tenant/repository.ts`
  - `signups`, BigQuery, in `extensions/fsbq-signups-us.env`. Dataset waitlist_us, mirrored from Firestore by the firestore-bigquery-export extension.
  - `signups`, BigQuery, in `extensions/fsbq-signups-eu.env`. Dataset waitlist_eu, mirrored from Firestore by the firestore-bigquery-export extension.
  - `signups`, BigQuery, in `extensions/fsbq-signups-asia.env`. Dataset waitlist_asia, mirrored from Firestore by the firestore-bigquery-export extension.
- Links: `idea` through campaignId; `person` through contacts.campaigns[].signupId
- Events: `signup.joined`, `signup.confirmed`, `signup.referred`, `signup.left`
- States: `unverified`, `verified_active`, `offboarded`, `deleted`
- Erase:
  - `processContactEraseJob` in `src/lib/crm/eraseWorker.ts`, on a person's erase or export
  - `deleteLaunch` in `src/lib/tenant/launchDeletion.ts`, on deleting a launch
  - Gap: the BigQuery changelog mirror keeps a row's values after the row is erased in Firestore
- Export:
  - `exportWholePerson` in `src/lib/audience/personExport.ts`, on a person's erase or export (AUDIENCE_ONE_VIEW_ENABLED is on)
- Search: none. People's words wait for the data processing agreement to cover a new store of personal data.
- Numbers: gap. People counts per launch and product reach Vizzy through get_counts with no meanings (`src/lib/audience/agentCounts.ts`).

### Invite (`invite`)

An invite from a launch's waitlist into the product: one per person per launch, holding a hash of the address, never the address.

- Status: built
- Home: the brand's region
- Personal: yes, the brand's people
- Stores:
  - `invites`, the brand's regional Firestore, in `src/lib/tenant/repository.ts`
- Links: `signup` through signupId; `product_user` through productUserId; `invite_wave` through waveId
- Events: `signup.invited`
- Erase:
  - `processContactEraseJob` in `src/lib/crm/eraseWorker.ts`, on a person's erase or export
  - `eraseProductUserHistory` in `src/lib/connect/erase.ts`, on a product user's erase or export (keeps the invite and drops its link to the product user)
  - `deleteLaunch` in `src/lib/tenant/launchDeletion.ts`, on deleting a launch
- Export:
  - `exportWholePerson` in `src/lib/audience/personExport.ts`, on a person's erase or export (AUDIENCE_ONE_VIEW_ENABLED is on)
- Search: none. People's words wait for the data processing agreement to cover a new store of personal data.
- Numbers: none. Invite counts show on the launch's Invite screen; no agent reads them yet.

### Invite wave (`invite_wave`)

A batch of invites a launch sends together.

- Status: built
- Home: the brand's region
- Personal: no
- Stores:
  - `invite_waves`, the brand's regional Firestore, in `src/lib/tenant/repository.ts`
- Links: `idea` through campaignId
- Erase:
  - `deleteLaunch` in `src/lib/tenant/launchDeletion.ts`, on deleting a launch
  - `removeWave` in `src/lib/invites/adminApi.ts`, on removing the record
- Export: none. The brand's own work, with no one's personal data.
- Search: none. A batch setting, not text.
- Numbers: none. No numbers an agent reads.

### Launch email journey (`launch_journey`)

The older email sequence a launch sends its sign-ups, one per launch, drawn on the Journey Canvas.

- Status: built
- Home: the brand's region
- Personal: no
- Stores:
  - `journeys`, the brand's regional Firestore, in `src/lib/tenant/repository.ts`
- Links: `idea` through campaignId
- Erase:
  - `deleteLaunch` in `src/lib/tenant/launchDeletion.ts`, on deleting a launch
- Export: none. The brand's own work, with no one's personal data.
- Search: none. The older launch sequences are not read into search; journeys on the lifecycle engine are.
- Numbers: none. Its emails are counted as email sends.

## Signals

Spine step 2. What happened, credited to an idea where there is one.

### Email send (`email_send`)

One email sent to one person, and everything that happened to it: delivery, opens, clicks, bounces, complaints and unsubscribes.

- Status: built
- Home: the brand's region
- Personal: yes, the brand's people
- Stores:
  - `email_sends`, the brand's regional Firestore, in `src/lib/tenant/repository.ts`
- Links: `signup` through signupId (a sign-up id, or a product user id for product journeys); `idea` through campaignId; `enrolment` through enrolmentId
- Events: `email.sent`, `email.delivered`, `email.opened`, `email.clicked`, `email.bounced`, `email.soft_bounced`, `email.complained`, `email.rejected`, `email.unsubscribed`
- Person fields: `signupId` (written with the row), `personId` (written with the row)
- Erase:
  - `processContactEraseJob` in `src/lib/crm/eraseWorker.ts`, on a person's erase or export
  - `eraseProductUserHistory` in `src/lib/connect/erase.ts`, on a product user's erase or export
  - Gap: deleting a launch removes its sign-ups but leaves their rows here
  - Gap: while AUDIENCE_ONE_VIEW_ENABLED is off a person's erase keeps their product users, so a product user's rows keep that person's personId until the product user is erased (src/lib/crm/eraseWorker.ts step 2)
- Export:
  - `exportWholePerson` in `src/lib/audience/personExport.ts`, on a person's erase or export (AUDIENCE_ONE_VIEW_ENABLED is on)
  - `exportPerson` in `src/lib/audience/personExport.ts`, on a product user's erase or export
- Search: none. People's words wait for the data processing agreement to cover a new store of personal data.
- Numbers: `sends`, `delivered`, `people`, `deliveryRate`, `uniqueOpens`, `uniqueClicks`, `openRate`, `clickRate`, `totalOpens`, `totalClicks`, `hardBounces`, `softBounces`, `deferrals`, `complaints`, `unsubscribes`, through `get_email_results`

### Email event (`email_event`)

One kind of thing that happened to an email for one person (sent, opened, clicked, bounced and so on), counted once, from the email provider's webhooks.

- Status: built
- Home: the brand's region
- Personal: yes, the brand's people
- Stores:
  - `email_events`, the brand's regional Firestore, in `src/lib/tenant/repository.ts`
  - `email_events`, BigQuery, in `extensions/fsbq-email-events-us.env`. Dataset waitlist_us, mirrored from Firestore by the firestore-bigquery-export extension.
  - `email_events`, BigQuery, in `extensions/fsbq-email-events-eu.env`. Dataset waitlist_eu, mirrored from Firestore by the firestore-bigquery-export extension.
  - `email_events`, BigQuery, in `extensions/fsbq-email-events-asia.env`. Dataset waitlist_asia, mirrored from Firestore by the firestore-bigquery-export extension.
- Links: `email_send` through the same journey, step, person and arm; `idea` through campaignId
- Events: `email.sent`, `email.opened`, `email.clicked`, `email.bounced`, `email.soft_bounced`, `email.complained`, `email.rejected`, `email.unsubscribed`
- Person fields: `signupId` (written with the row), `personId` (written with the row)
- Erase:
  - `processContactEraseJob` in `src/lib/crm/eraseWorker.ts`, on a person's erase or export
  - `eraseProductUserHistory` in `src/lib/connect/erase.ts`, on a product user's erase or export
  - Gap: deleting a launch removes its sign-ups but leaves their rows here
  - Gap: the BigQuery changelog mirror keeps a row's values after the row is erased in Firestore
  - Gap: while AUDIENCE_ONE_VIEW_ENABLED is off a person's erase keeps their product users, so a product user's rows keep that person's personId until the product user is erased (src/lib/crm/eraseWorker.ts step 2)
- Export:
  - `exportWholePerson` in `src/lib/audience/personExport.ts`, on a person's erase or export (AUDIENCE_ONE_VIEW_ENABLED is on)
  - `exportPerson` in `src/lib/audience/personExport.ts`, on a product user's erase or export
- Search: none. People's words wait for the data processing agreement to cover a new store of personal data.
- Numbers: `sends`, `uniqueOpens`, `uniqueClicks`, `openRate`, `clickRate`, `hardBounces`, `softBounces`, `complaints`, `unsubscribes`, through `get_email_results`

### Form view (`widget_view`)

Views of a launch's sign-up form: counts per launch per day, and one row per view in BigQuery with the referrer and campaign tags, never a person.

- Status: built
- Home: the brand's region
- Personal: no
- Stores:
  - `widget_view_days`, the brand's regional Firestore, in `src/lib/tenant/repository.ts`
  - `widget_views`, BigQuery, in `src/lib/analytics/bigquery.ts`. One table per region's dataset.
- Links: `idea` through campaignId
- Erase: none. Counts and page views with no person.
- Export: none. Counts and page views with no person.
- Search: none. Numbers, not text.
- Numbers: gap. Form view counts have no meanings yet (semantic layer).

### Product event count (`product_event_day`)

Accepted product events per connection per day by name, kept after the events themselves expire.

- Status: built
- Home: the brand's region
- Personal: no
- Stores:
  - `product_event_days`, the brand's regional Firestore, in `src/lib/tenant/repository.ts`
- Links: `product` through connectionId
- Erase: none. Counts by event name with no person.
- Export: none. Counts by event name with no person.
- Search: none. Numbers, not text.
- Numbers: gap. Product event counts have no meanings yet (semantic layer).

### Brand signal (`brand_signal`)

Outside numbers about the brand: Google's results for each of its questions, read through DataForSEO.

- Status: built
- Home: the brand's region
- Personal: no
- Stores:
  - `brand_signals`, the brand's regional Firestore, in `src/lib/tenant/repository.ts`
- Links: `brand_question` through the question it was searched for
- Erase: none. Public search results.
- Export: none. Public search results.
- Search: `research`
- Numbers: `googlePosition`, `peopleAlsoAsk`, `aiOverviewSources`, through `get_brand_context`

### Social engagement (`social_event`)

A reply, mention, like or message on one of the brand's social accounts, from the person who made it.

- Status: built
- Home: the brand's region
- Personal: yes, the brand's people
- Stores:
  - `social_events`, the brand's regional Firestore, in `src/lib/tenant/repository.ts`
- Links: `social_profile` through platform and userId
- Events: `social.engaged`
- Erase: gap. A person's erase does not reach social engagement rows (`social_events`).
- Export: gap. A person's export does not include social engagement rows (`social_events`).
- Search: none. People's words wait for the data processing agreement to cover a new store of personal data.
- Numbers: none. Not counted for agents yet.

### Post results (`post_result`)

How each published post did: impressions, reactions, comments, shares and clicks, read from the social platform over its first days.

- Status: built
- Home: the brand's region
- Personal: no
- Stores:
  - `post_performance`, the brand's regional Firestore, in `src/lib/tenant/postPerformance.ts`
- Links: `scheduled_post` through the post it measures
- Erase: none. The brand's own post statistics.
- Export: none. The brand's own post statistics.
- Search: none. Numbers; the post's text is searched as a post.
- Numbers: `impressions`, `likes`, `comments`, `shares`, `reposts`, `quotes`, `bookmarks`, `clicks`, `engagementRate`, `linkedinEngagement`, `publishedAt`, `posts`, through `get_post_results`

### Trending topics (`trending_topic`)

What is being talked about in the brand's area, found with Google Search grounding: one latest set per brand.

- Status: built
- Home: the brand's region
- Personal: no
- Stores:
  - `trending_topics`, the brand's regional Firestore, in `src/lib/tenant/trendingTopics.ts`
- Erase: none. Public topics, overwritten each time.
- Export: none. Public topics.
- Search: none. Refreshed often and read by the writer directly.
- Numbers: none. No numbers an agent reads.

### Competitor (`competitor`)

A competitor the brand watches: their sitemap's pages, their news posts, monthly changes and the findings from articles read in full.

- Status: built
- Home: the brand's region
- Personal: no
- Stores:
  - `competitors`, the brand's regional Firestore, in `src/lib/tenant/repository.ts`
  - `competitor_pages`, the brand's regional Firestore, in `src/lib/tenant/repository.ts`
  - `competitor_posts`, the brand's regional Firestore, in `src/lib/tenant/repository.ts`
  - `competitor_changes`, the brand's regional Firestore, in `src/lib/tenant/repository.ts`
  - `competitor_articles`, the brand's regional Firestore, in `src/lib/tenant/repository.ts`. Findings and short quotes, never the article's text.
- Erase:
  - `removeCompetitor` in `src/lib/competitors/store.ts`, on removing the record
  - `removeArticles` in `src/lib/competitors/articles.ts`, on removing the record
- Export: none. Public pages about another business.
- Search: `competitor`
- Numbers: none. No numbers an agent reads.

### Data connection (`data_connection`)

A brand's link to an outside source of numbers, such as a Cloudflare zone, a Search Console site or a Google Analytics property: which connector, how it signs in, its health, who may read it live, and its secrets (a pasted token, or a Google sign in's access and refresh tokens), sealed with the brand, connection and slot bound in. A shared connection keeps no secret, only the Google address made for it. It may also be a part its organisation gave it (Connectors 3): then `source` names the organisation's connection and the region it is kept in, it keeps no secret and no address, and its token is read through the organisation's. Each change goes into an activity log kept 90 days.

- Status: built
- Home: the brand's region
- Personal: the brand's own team
- Stores:
  - `data_connections`, the brand's regional Firestore, in `src/lib/tenant/repository.ts`. One record per connection, written only through `src/lib/tenant/dataConnections.ts`; its secrets are sealed and never leave the server.
  - `data_connection_activity`, the brand's regional Firestore, in `src/lib/tenant/repository.ts`. Each change to a connection and who made it, by user id; a live read's row also keeps what was asked and the days read, never a number or a page; written with its change, never queried, deleted 90 days on by a time to live on ttlAt.
  - `data_connection_states`, the brand's regional Firestore, in `src/lib/tenant/dataConnectionStates.ts`. A sign in with Google under way: the brand, the admin's user id and the connector, read by id, valid 10 minutes, claimed once and deleted, and removed by a time to live on ttlAt.
  - `connection_parts`, the brand's regional Firestore, in `src/lib/tenant/settingsLog.ts`. The parts a brand's organisation gives it (Connectors 3), as its `connections:shared` setting: one document per brand, id from settingsDocId, one item per part (the organisation's connection and its region, the brand record, the part, who gave it by user id), archived when the part ends, never removed; written with its settings version in the same transaction as the brand record, by `src/lib/tenant/organisationConnections.ts` only.
- Links: `brand` through tenantId; `settings_version` through the connections:shared subject, one version per part given, changed or ended (many); `member` through ownerUid, and by on each activity row; `connector_manifest` through connectorId; `organisation_connection` through source, on a part its organisation gave it
- States: `connected`, `disconnected`
- Erase:
  - `disconnect` in `src/lib/connectors/service.ts`, on removing the record (an admin's Disconnect removes the sealed secrets; the record stays, marked disconnected)
  - `deleteConnectionAddress` in `src/lib/connectors/service.ts`, on removing the record (a shared connection's Google address is deleted at Google on Disconnect and on the purge, which retries a failed delete)
  - `purgeDataConnection` in `src/lib/tenant/dataConnections.ts`, on removing the record (an operator purge removes the secrets, the recent list and the activity)
  - `ACTIVITY_KEEP_DAYS` in `src/lib/tenant/dataConnections.ts`, on retention (activity rows go 90 days on, through the TTL on ttlAt)
  - `consumeConnectionState` in `src/lib/tenant/dataConnectionStates.ts`, on retention (a sign in state is deleted once used, and by the TTL on ttlAt 10 minutes after it was made)
  - Gap: a team member's user id in ownerUid and in by stays after they leave the brand, as settings history does
- Export: none. A sealed secret and its settings, never exported.
- Search: none. Credentials and settings, never searched.
- Numbers: `cfRequests`, `cfPageViews`, `cfVisits`, `cfUniqueVisitors`, `searchClicks`, `searchImpressions`, `searchCtr`, `searchPosition`, `merged`, `ga4Sessions`, `ga4ActiveUsers`, `ga4Views`, `ga4KeyEvents`, through `read_connected_live`

### Organisation connection (`organisation_connection`)

An organisation's own link to an outside source of numbers (Connectors 3, ADR-0015): one Google sign in, one Google address made for the organisation, or one pasted token, whose owners give each of the organisation's brands one part of it (a site, a property or a zone). Kept in the regional database of the brand it was connected from, and never moved; its parts can go to the organisation's brands in any region. It holds the sealed secrets, with the organisation, connection and slot bound in, its health, pause and collect hold, the owner who signed in, and for each part the brand's id and region, the part and the brand record's id: what the sign in reads for each brand, never what was collected. Each part is a data connection in its brand's own region, where everything collected stays. Written only through `src/lib/tenant/organisationConnections.ts`; each change goes into an activity log kept 90 days.

- Status: built
- Home: the region of the brand it was connected from, serving the organisation's brands in any region
- Personal: the brand's own team
- Stores:
  - `organisation_connections`, the brand's regional Firestore, in `src/lib/tenant/organisationConnections.ts`. One record per organisation connection, read by id and by equality on organisationId (with connectorId) or status, in every provisioned region; its secrets are sealed and never leave the server; residency gap: kept in the region of the brand it was connected from, which may not be the region of every brand it serves: only the sign in (its token, read into server memory) and each part's brand id, region and name cross; collected numbers stay in each brand's region.
  - `organisation_connection_activity`, the brand's regional Firestore, in `src/lib/tenant/organisationConnections.ts`. Each change to an organisation connection and who made it, by user id, and the brand a part change is about; written with its change, never queried, deleted 90 days on by a time to live on ttlAt.
- Links: `organisation` through organisationId; `data_connection` through parts[].useId, each brand record pointing back with source (many); `brand` through parts[].tenantId, and connectedFromTenantId (many); `member` through createdBy, signerUid, givenBy and endedBy, and by on each activity row (many); `connector_manifest` through connectorId
- States: `connected`, `disconnected`
- Erase:
  - `disconnectOrganisationConnection` in `src/lib/connectors/organisation.ts`, on removing the record (Disconnect at the organisation empties the sealed secrets, ends every brand's part and erases what it collected in that brand's region, and deletes its Google address; the record stays, marked disconnected)
  - `purgeOrganisations` in `src/lib/connectors/purge.ts`, on removing the record (the organisation purge (`connectors-purge --organisation <orgId|all>`) removes the secrets, the recent list, the parts, the activity and leftover addresses in every region, whatever any switch says)
  - `purgeOrganisationConnection` in `src/lib/tenant/organisationConnections.ts`, on removing the record (the purge's last step for one record)
  - `sweepOrganisationConnections` in `src/lib/connectors/organisation.ts`, on retention (the lane disconnects the connections of an organisation that is gone or has no brands left, and every move or reused organisation id does too)
  - `ORGANISATION_CONNECTION_ACTIVITY` in `src/lib/tenant/organisationConnections.ts`, on retention (activity rows go 90 days on, through the TTL on ttlAt)
  - Gap: an owner's user id in createdBy, signerUid, givenBy and by stays after they stop being an owner, as settings history does
- Export: none. A sealed secret and the parts it serves, never exported.
- Search: none. Credentials and settings, never searched.
- Numbers: none. Its parts' numbers are each brand's data connection's.

### Connector stream (`connector_stream`)

Data collected from a connected source once a day, as its manifest's stream and its collect block describe it: Search Console's search numbers, Google Analytics' traffic and Cloudflare's zone totals. Every built stream is about the brand's own site, never a person (a stream marked personal is refused until the data processing agreement covers it).

- Status: built
- Home: the brand's region
- Personal: no
- Stores:
  - `metric_snapshots`, the brand's regional Firestore, in `src/lib/tenant/repository.ts`. A stream has no store of its own: its collected days are the metric snapshots its connection writes.
- Links: `connector_manifest` through the manifest; `data_connection` through connectionId on each snapshot
- Erase: none. No store of its own: its collected days go with the metric snapshots.
- Export: none. Numbers about the brand's own site, with no person.
- Search: none. Found on its connector's Listing.
- Numbers: none. Its numbers become metric snapshots.

### Metric snapshot (`metric_snapshot`)

A connected source's numbers for one day, or for the 28 or 90 days to its last collected day, collected once a day and kept 90 days in the brand's region (ADR-0012). Each number is keyed by its meaning, with the provider's own day and time zone and how final it is. Rows are keyed by day, page path, landing page or search: Search Console's topic rows hold the words people searched and the brand's page paths, Google's aggregates over everyone who searched (decision 37), not only numbers; the top 200 searches of the 28 days go into brand search as research, found only by those who may read the connection (ADR-0013).

- Status: built
- Home: the brand's region
- Personal: no
- Stores:
  - `metric_snapshots`, the brand's regional Firestore, in `src/lib/tenant/repository.ts`. One doc per connection, generation, stream, grouping and day, plus the rolled 28 and 90 day docs and Search Console's planning docs, each by a fixed id and at most 500 rows; written only through `src/lib/connectors/snapshots.ts`, read by id (Vizzy's collected numbers through `src/lib/connectors/numbers.ts`), deleted 90 days on by a time to live on ttlAt.
- Links: `connector_stream` through the stream it was read from; `data_connection` through connectionId, and the generation it was read under
- Erase:
  - `eraseConnectionData` in `src/lib/connectors/erase.ts`, on removing the record (Disconnect erases every snapshot of the connection and Change property its old generation, whatever any switch says, and both remove a Search Console connection's searches from brand search with indexing forced on; a pending erase is retried by the lane whenever CONNECTORS_ENABLED is on)
  - `purgeConnections` in `src/lib/connectors/purge.ts`, on removing the record (the operator purge erases them, and the searches in brand search, with every switch off)
  - `sweepBrand` in `src/lib/search/sweep.ts`, on removing the record (with CONNECTORS_SEARCH_TEXT_ENABLED off the feeder lists no searches, so the scheduled check removes them from brand search)
  - `dropAgedDay` in `src/lib/connectors/snapshots.ts`, on retention (writing a day deletes the day 90 days before it, by id; the time to live on ttlAt is the backstop)
- Export: none. Numbers about the brand's own site and Google's aggregates, not about a person.
- Search: `research`
- Numbers: `searchClicks`, `searchImpressions`, `searchCtr`, `searchPosition`, `merged`, `ga4Sessions`, `ga4ActiveUsers`, `ga4Views`, `ga4KeyEvents`, `cfRequests`, `cfPageViews`, `cfVisits`, `cfUniqueVisitors`, `rowsDropped`, `lagDays`, `nearbySearches`, through `get_connected_numbers`

### Suggestion from your numbers (`data_signal`)

What a brand's collected Search Console numbers suggest (Connectors 2 group 4, CONNECTOR_SIGNALS_ENABLED): a search with clearly more impressions than the 14 days before, a page with clearly fewer clicks than the 28 days before, or a brand map question whose search sits just off Google's first page. One row per connection, rule and key, from connections both members and Vizzy may read; it indexes its agent action, where the decision lives (Plan an article to acted, Dismiss to declined). It holds the search's words or the page's path, Google's aggregates (decision 37), never a person.

- Status: built
- Home: the brand's region
- Personal: no
- Stores:
  - `data_signals`, the brand's regional Firestore, in `src/lib/tenant/repository.ts`. One row per connection, generation, rule and key, by a fixed `dsg_` id; written only through `src/lib/connectors/signals/store.ts`, read by id or by equality on the connection; blanked on dismiss, plan or stale; deleted 30 days on by a time to live on ttlAt.
- Links: `data_connection` through connectionId, and the generation it was detected under; `agent_action` through agentActionId, the suggestion where its decision lives; `brand_question` through the question it is about or proposed; `metric_snapshot` through the collected days it was detected from (many)
- Erase:
  - `eraseConnectionData` in `src/lib/connectors/erase.ts`, on removing the record (Disconnect deletes every row of the connection and Change property its old generation's, declines their open suggestions as stale with values cleared, and removes the undecided brand map questions they proposed, whatever any switch says)
  - `purgeConnections` in `src/lib/connectors/purge.ts`, on removing the record (the operator purge does the same with every switch off)
  - `expireConnectorSignals` in `src/lib/connectors/signals/reconcile.ts`, on retention (the lane declines suggestions 30 days old and withdraws the questions they proposed, whenever CONNECTORS_ENABLED is on; the time to live on ttlAt removes the rows)
- Export: none. Suggestions about the brand's own site from Google's aggregates, not about a person.
- Search: none. Derived suggestions, found on Review and the brand map.
- Numbers: `searchClicks`, `searchImpressions`, `searchPosition`, `ga4Sessions`, through `get_number_suggestions`

## Product

Spine step 3, and optional: the idea built and connected. Its users are identities of people.

### Product (`product`)

A product connected to the brand: its keys, endpoints, catalog and what has arrived from it so far.

- Status: built
- Home: the brand's region
- Personal: no
- Stores:
  - `product_connections`, the brand's regional Firestore, in `src/lib/tenant/repository.ts`
  - `connection_keys`, control plane Firestore, in `src/lib/tenant/connectionKeys.ts`. The lookup from key id to brand, no secret.
  - `connection_diagnostics`, the brand's regional Firestore, in `src/lib/tenant/repository.ts`. Event names, trait keys and recent rejections.
- Links: `product_user` through connectionId (many); `catalog` through the connection's catalog; `repo_map` through connectionId (many); `idea` through campaigns.idea.productConnectionId, the ideas handed off to it (many)
- Erase:
  - `deleteConnectionKey` in `src/lib/tenant/connectionKeys.ts`, on removing the record (when the connection's key is replaced or removed)
- Export: none. The brand's own settings.
- Search: none. Found on the Connections screen; its product map is searched as repo_map.
- Numbers: gap. People counts per launch and product reach Vizzy through get_counts with no meanings (`src/lib/audience/agentCounts.ts`).

### Catalog (`catalog`)

What a product says about its users: traits, facts, steps and event names. The live catalog sits on the connection, and every earlier version is kept whole for undo, with who saved it as a user id.

- Status: built
- Home: the brand's region
- Personal: the brand's own team
- Stores:
  - `catalog_revisions`, the brand's regional Firestore, in `src/lib/tenant/repository.ts`. Every version is kept; `savedBy` is the saver's user id, never an address, shown by name only while they are on the team.
- Links: `product` through connectionId; `member` through savedBy
- Erase: gap. No path removes a team member's user id in `savedBy` when they leave the team; it stays an id and shows as Former team member.
- Export: gap. Team member ids in `savedBy` stay as ids, with no export by team member.
- Search: none. Read by Vizzy through the connection, not searched.
- Numbers: none. No numbers an agent reads.

### Product map (`repo_map`)

What Vizzy learned from a product's code, read only: its screens, entities and steps, proposed as a catalog.

- Status: built
- Home: the brand's region
- Personal: no
- Stores:
  - `repo_analyses`, the brand's regional Firestore, in `src/lib/tenant/repository.ts`
  - `repo_analyses`, the brand's regional Firestore, in `workers/knowledge-scraper/src/productMap/run.ts`. Written by the knowledge scraper job.
- Links: `product` through connectionId
- Erase: none. The brand's own product, described from its code.
- Export: none. The brand's own work, with no one's personal data.
- Search: `repo_map`
- Numbers: none. No numbers an agent reads.

### Product user (`product_user`)

One user of a connected product, built from what the product sends: their address, traits, facts and stage. An identity of a person.

- Status: built
- Home: the brand's region
- Personal: yes, the brand's people
- Stores:
  - `product_users`, the brand's regional Firestore, in `src/lib/tenant/repository.ts`
- Links: `product` through connectionId; `person` through contacts.products[].productUserId
- Events: `product.identified`, `product.erased`
- States: `active`, `deleted`
- Erase:
  - `eraseProductUser` in `src/lib/connect/erase.ts`, on a product user's erase or export
  - `processContactEraseJob` in `src/lib/crm/eraseWorker.ts`, on a person's erase or export (AUDIENCE_ONE_VIEW_ENABLED is on: their user in every product is erased too)
  - `TOMBSTONE_TTL_MS` in `src/lib/connect/profile.ts`, on retention (the erased user's tombstone goes 30 days later)
- Export:
  - `exportPerson` in `src/lib/audience/personExport.ts`, on a product user's erase or export
  - `exportWholePerson` in `src/lib/audience/personExport.ts`, on a person's erase or export (AUDIENCE_ONE_VIEW_ENABLED is on)
- Search: none. People's words wait for the data processing agreement to cover a new store of personal data.
- Numbers: gap. People counts per launch and product reach Vizzy through get_counts with no meanings (`src/lib/audience/agentCounts.ts`).

### Product event (`product_event`)

One identify or track message a product sent about one of its users, kept 90 days for the debugger and journeys.

- Status: built
- Home: the brand's region
- Personal: yes, the brand's people
- Stores:
  - `product_events`, the brand's regional Firestore, in `src/lib/tenant/repository.ts`
- Links: `product_user` through productUserId; `product` through connectionId
- Events: `product.identified`, `product.tracked`, `product.erased`
- Person fields: `productUserId` (written with the row), `personId` (written with the row)
- Erase:
  - `eraseProductUserHistory` in `src/lib/connect/erase.ts`, on a product user's erase or export
  - `processContactEraseJob` in `src/lib/crm/eraseWorker.ts`, on a person's erase or export (AUDIENCE_ONE_VIEW_ENABLED is on: their user in every product is erased too)
  - `EVENT_TTL_MS` in `src/lib/connect/ingest.ts`, on retention (each event goes 90 days after it arrives)
  - Gap: while AUDIENCE_ONE_VIEW_ENABLED is off a person's erase keeps their product users, so a product user's rows keep that person's personId until the product user is erased (src/lib/crm/eraseWorker.ts step 2)
- Export:
  - `exportPerson` in `src/lib/audience/personExport.ts`, on a product user's erase or export
  - `exportWholePerson` in `src/lib/audience/personExport.ts`, on a person's erase or export (AUDIENCE_ONE_VIEW_ENABLED is on)
- Search: none. People's words wait for the data processing agreement to cover a new store of personal data.
- Numbers: gap. Product event counts have no meanings yet (semantic layer).

### Product webhook (`product_webhook`)

A signed message waiting to go to a product, such as a user's email preference change or a suppression, retried until it expires.

- Status: built
- Home: the brand's region
- Personal: yes, the brand's people
- Stores:
  - `lifecycle_webhooks`, the brand's regional Firestore, in `src/lib/tenant/repository.ts`. Carries the product's own user id, never an address.
- Links: `product` through connectionId
- Erase: gap. A product user's erase leaves webhooks still waiting to go; each expires after its retries.
- Export: gap. Not in a person's export: a webhook only carries a change on its way to the product.
- Search: none. People's words wait for the data processing agreement to cover a new store of personal data.
- Numbers: none. No numbers an agent reads.

### Group (`group`)

A workspace, team or household inside a product, as a shared record with members and fields.

- Status: planned, in G
- Home: the brand's region
- Personal: yes, the brand's people
- Links: `person` through members (many)
- Erase: gap. Planned: piece G erases and exports a person's memberships with them.
- Export: gap. Planned: piece G erases and exports a person's memberships with them.
- Search: none. People's words wait for the data processing agreement to cover a new store of personal data.
- Numbers: none. Planned: piece G decides it with the store.

## Customers

Spine step 4. The people the brand grows with, and how it reaches them.

### Person (`person`)

One human, once per brand: every sign-up, product user and address they came through, joined on one record. Its id is the `ct_` id a row's `personId` means.

- Status: built
- Home: the brand's region
- Personal: yes, the brand's people
- Stores:
  - `contacts`, the brand's regional Firestore, in `src/lib/tenant/repository.ts`
- Links: `signup` through campaigns[].signupId (many); `product_user` through products[].productUserId (many); `company` through companyId
- Events: `record.merged`, `record.repointed`, `record.created`, `consent.recorded`, `record.field_changed`
- Erase:
  - `processContactEraseJob` in `src/lib/crm/eraseWorker.ts`, on a person's erase or export
  - `eraseProductUser` in `src/lib/connect/erase.ts`, on a product user's erase or export (a record that only came from products goes with its last product user, field values and all)
  - `forgetLeftBehindPeople` in `src/lib/ontology/erase.ts`, on a product user's erase or export (a person the product user left behind on a move (their pu: person, an earlier address), kept while it held field values, goes with its history when nothing else keeps it)
  - Gap: a record that only came from products is kept when it holds field values its person can't take: its product was revoked, or, after a new address or a join to an address, the new record had its own value for that field or no room for it, or moving them failed on every one of the job's tries; it stays out of Everyone until the team erases it or the product user's erase takes it
  - Gap: a person left behind on an address change while ONTOLOGY_PERSON_IDS_ENABLED was off has no move for the product user's erase to find; fields need that switch, so values are only left behind while it is on
- Export:
  - `exportWholePerson` in `src/lib/audience/personExport.ts`, on a person's erase or export (AUDIENCE_ONE_VIEW_ENABLED is on)
- Search: none. People's words wait for the data processing agreement to cover a new store of personal data.
- Numbers: gap. People counts per launch and product reach Vizzy through get_counts with no meanings (`src/lib/audience/agentCounts.ts`).

### Company (`company`)

A business people work at, by its web address, with how many of the brand's people are there, and the brand's own company fields (`fields.<fieldId>`), which can hold what the team knows about the people there.

- Status: built
- Home: the brand's region
- Personal: yes, the brand's people
- Stores:
  - `companies`, the brand's regional Firestore, in `src/lib/tenant/repository.ts`
- Links: `person` through contacts.companyId (many)
- Events: `record.field_changed`
- Erase:
  - `processContactEraseJob` in `src/lib/crm/eraseWorker.ts`, on a person's erase or export (the company, its field values and its history go when its last person is erased)
  - Gap: erasing one person keeps their company's field values while others still work there
- Export: gap. A person's export leaves out their company's own field values.
- Search: none. Found on the Companies tab; joins brand search with people once the data processing agreement covers it.
- Numbers: none. No numbers an agent reads.

### Opt out (`email_suppression`)

An unsubscribe, spam complaint or hard bounce that stops every send to an address, across the brand.

- Status: built
- Home: the brand's region
- Personal: yes, the brand's people
- Stores:
  - `email_suppressions`, the brand's regional Firestore, in `src/lib/tenant/repository.ts`
- Links: `person` through the address, hashed in the id
- Events: `email.unsubscribed`, `email.complained`, `email.bounced`
- Erase:
  - `scrubSuppressionEmails` in `src/lib/connect/erase.ts`, on a person's erase or export (blanks the address; the row stays so the opt out keeps holding)
  - `scrubSuppressionEmails` in `src/lib/connect/erase.ts`, on a product user's erase or export (blanks the address; the row stays so the opt out keeps holding)
- Export:
  - `exportWholePerson` in `src/lib/audience/personExport.ts`, on a person's erase or export (AUDIENCE_ONE_VIEW_ENABLED is on)
  - `exportPerson` in `src/lib/audience/personExport.ts`, on a product user's erase or export
- Search: none. People's words wait for the data processing agreement to cover a new store of personal data.
- Numbers: none. Counted from email events.

### Engaged social profile (`social_profile`)

A social profile that engaged with the brand's posts: handle, name, bio and how often, on the Engaged tab.

- Status: built
- Home: the brand's region
- Personal: yes, the brand's people
- Stores:
  - `social_engaged`, the brand's regional Firestore, in `src/lib/tenant/repository.ts`
- Links: `social_event` through platform and userId (many)
- Events: `social.engaged`
- Erase: gap. A person's erase does not reach engaged social profiles (`social_engaged`).
- Export: gap. A person's export does not include engaged social profiles (`social_engaged`).
- Search: none. People's words wait for the data processing agreement to cover a new store of personal data.
- Numbers: none. Not counted for agents yet.

### Journey (`lifecycle_journey`)

An email journey on the lifecycle engine, for a product's users or a launch's waitlist: the draft, its published versions and its daily send counters.

- Status: built
- Home: the brand's region
- Personal: no
- Stores:
  - `lifecycle_journeys`, the brand's regional Firestore, in `src/lib/tenant/repository.ts`
  - `lifecycle_versions`, the brand's regional Firestore, in `src/lib/tenant/repository.ts`. Published versions never change.
  - `lifecycle_counters`, the brand's regional Firestore, in `src/lib/tenant/repository.ts`
- Links: `enrolment` through journeyId (many); `product` through connectionId; `idea` through campaignId, for a waitlist journey
- Erase:
  - `deleteLaunch` in `src/lib/tenant/launchDeletion.ts`, on deleting a launch (a launch's waitlist journey goes with it)
  - `COUNTER_TTL_MS` in `src/lib/lifecycle/enrol.ts`, on retention (daily counters go after 40 days)
- Export: none. The brand's own work, with no one's personal data.
- Search: `journey_email`
- Numbers: `sends`, `delivered`, `people`, `deliveryRate`, `uniqueOpens`, `uniqueClicks`, `openRate`, `clickRate`, `totalOpens`, `totalClicks`, `hardBounces`, `softBounces`, `deferrals`, `complaints`, `unsubscribes`, through `get_email_results`

### Journey enrolment (`enrolment`)

One person's way through one journey: where they are, what they were sent and when they left.

- Status: built
- Home: the brand's region
- Personal: yes, the brand's people
- Stores:
  - `lifecycle_enrolments`, the brand's regional Firestore, in `src/lib/tenant/repository.ts`. Product journeys, and the runner's queue.
  - `waitlist_enrolments`, the brand's regional Firestore, in `src/lib/tenant/repository.ts`. Waitlist journeys on the lifecycle engine.
- Links: `lifecycle_journey` through journeyId; `product_user` through productUserId; `signup` through signupId
- Events: `journey.entered`, `journey.completed`, `journey.exited`
- States: `active`, `completed`, `exited`
- Person fields: `productUserId` (written with the row), `signupId` (written with the row), `personId` (written with the row)
- Erase:
  - `eraseProductUserHistory` in `src/lib/connect/erase.ts`, on a product user's erase or export
  - `processContactEraseJob` in `src/lib/crm/eraseWorker.ts`, on a person's erase or export
  - `deleteLaunch` in `src/lib/tenant/launchDeletion.ts`, on deleting a launch
  - Gap: while AUDIENCE_ONE_VIEW_ENABLED is off a person's erase keeps their product users, so a product user's rows keep that person's personId until the product user is erased (src/lib/crm/eraseWorker.ts step 2)
- Export:
  - `exportPerson` in `src/lib/audience/personExport.ts`, on a product user's erase or export
  - `exportWholePerson` in `src/lib/audience/personExport.ts`, on a person's erase or export (AUDIENCE_ONE_VIEW_ENABLED is on)
- Search: none. People's words wait for the data processing agreement to cover a new store of personal data.
- Numbers: none. Journey numbers are counted from email sends.

### AI line (`ai_line`)

A line Vizzy wrote for one person's email from their facts, waiting for (or past) a team member's approval.

- Status: built
- Home: the brand's region
- Personal: yes, the brand's people
- Stores:
  - `lifecycle_drafts`, the brand's regional Firestore, in `src/lib/tenant/repository.ts`. Holds the person's facts and a preview of the email.
- Links: `product_user` through productUserId
- Erase:
  - `eraseProductUserHistory` in `src/lib/connect/erase.ts`, on a product user's erase or export
  - `processContactEraseJob` in `src/lib/crm/eraseWorker.ts`, on a person's erase or export (AUDIENCE_ONE_VIEW_ENABLED is on: their user in every product is erased too)
  - `DRAFT_TTL_MS` in `src/lib/lifecycle/drafts.ts`, on retention (each line goes 90 days after its send)
- Export:
  - `exportPerson` in `src/lib/audience/personExport.ts`, on a product user's erase or export
  - `exportWholePerson` in `src/lib/audience/personExport.ts`, on a person's erase or export (AUDIENCE_ONE_VIEW_ENABLED is on)
- Search: none. People's words wait for the data processing agreement to cover a new store of personal data.
- Numbers: none. No numbers an agent reads.

### Person plan (`person_plan`)

A plan for one product user, in the team's words, drafted by Vizzy and approved by a team member.

- Status: built
- Home: the brand's region
- Personal: yes, the brand's people
- Stores:
  - `person_plans`, the brand's regional Firestore, in `src/lib/tenant/repository.ts`
- Links: `product_user` through productUserId
- Events: `person_plan.drafted`, `person_plan.approved`
- Person fields: `productUserId` (written with the row), `personId` (written with the row)
- Erase:
  - `eraseProductUserHistory` in `src/lib/connect/erase.ts`, on a product user's erase or export
  - `processContactEraseJob` in `src/lib/crm/eraseWorker.ts`, on a person's erase or export (AUDIENCE_ONE_VIEW_ENABLED is on: their user in every product is erased too)
  - Gap: while AUDIENCE_ONE_VIEW_ENABLED is off a person's erase keeps their product users, so a product user's rows keep that person's personId until the product user is erased (src/lib/crm/eraseWorker.ts step 2)
- Export:
  - `exportPerson` in `src/lib/audience/personExport.ts`, on a product user's erase or export
  - `exportWholePerson` in `src/lib/audience/personExport.ts`, on a person's erase or export (AUDIENCE_ONE_VIEW_ENABLED is on)
- Search: none. People's words wait for the data processing agreement to cover a new store of personal data.
- Numbers: none. No numbers an agent reads.

### Person move (`person_move`)

A product user who moved to another person: merged when one known only by their own record gave an address, repointed when their address changed or went. Their rows follow, moved by the person_repoint job, and so do the team's field values on a record the move left behind (the new record's own values win). Ids only.

- Status: built
- Home: the brand's region
- Personal: yes, the brand's people
- Stores:
  - `person_moves`, the brand's regional Firestore, in `src/lib/tenant/repository.ts`. Pending until the job has moved their rows, then done, or dropped when the product user can no longer be a person (erased, or their product revoked); the event fields never change.
- Links: `product_user` through productUserId; `person` through personId and fromPersonId; `product` through connectionId
- Events: `record.merged`, `record.repointed`
- States: `pending`, `done`, `dropped`
- Person fields: `personId` (written with the row), `fromPersonId` (written with the row), `productUserId` (written with the row)
- Erase:
  - `eraseProductUserHistory` in `src/lib/connect/erase.ts`, on a product user's erase or export
  - `processContactEraseJob` in `src/lib/crm/eraseWorker.ts`, on a person's erase or export (moves to or from the person, by personId and fromPersonId)
- Export:
  - `exportPerson` in `src/lib/audience/personExport.ts`, on a product user's erase or export
  - `exportWholePerson` in `src/lib/audience/personExport.ts`, on a person's erase or export (AUDIENCE_ONE_VIEW_ENABLED is on)
- Search: none. People's words wait for the data processing agreement to cover a new store of personal data.
- Numbers: none. No numbers an agent reads.

### Event history (`ontology_event`)

One row per thing that happened to a person, company, idea or agent action and has no other home: a record created, a field changed with its values before and after, consent recorded, and each step of an agent action. A person's timeline is every row carrying their personId. Append only: a row changes only when its person is repointed or an erased field's values are blanked, and goes when its subject is erased. Email, product, journey and sign-up moments stay in their own stores and are read beside it. Kept until erased, with no time to live.

- Status: built
- Home: the brand's region
- Personal: yes, the brand's people
- Stores:
  - `ontology_events`, the brand's regional Firestore, in `src/lib/tenant/repository.ts`. Written only through `src/lib/tenant/ontologyEvents.ts` and `src/lib/tenant/agentActions.ts`; field changes hold personal values.
- Links: `person` through personId, and the subject when it is a person; `company` through the subject, when it is a company; `idea` through the subject, when it is an idea; `agent_action` through agentActionId
- Events: `record.created`, `record.field_changed`, `consent.recorded`, `agent.proposed`, `agent.approved`, `agent.acted`, `agent.undone`, `agent.declined`
- Person fields: `personId` (written with the row)
- Erase:
  - `processContactEraseJob` in `src/lib/crm/eraseWorker.ts`, on a person's erase or export (by their person id, and the pu: person id of each product user they link, whatever the one view says)
  - `processContactEraseJob` in `src/lib/crm/eraseWorker.ts`, on a person's erase or export (a company's rows, when the company has no contacts left)
  - `eraseProductUserHistory` in `src/lib/connect/erase.ts`, on a product user's erase or export (by the product user, and by their pu: person's id)
  - `forgetGonePersonHistory` in `src/lib/ontology/erase.ts`, on a product user's erase or export (the person goes with their last product user, whether their record goes then or at a later sweep)
  - `forgetLeftBehindPeople` in `src/lib/ontology/erase.ts`, on a product user's erase or export (a person the product user left behind on a move (their pu: person, an earlier address), kept while it held field values, goes with its history when nothing else keeps it)
  - `deleteLaunch` in `src/lib/tenant/launchDeletion.ts`, on deleting a launch (an idea's rows, and the agent actions about it)
  - Gap: team member ids in actor, requestedBy, decidedBy, actedBy and undoneBy stay as ids after the member leaves and show as Former team member, as settings history does
  - Gap: rows about a product-only person whose address changed while ONTOLOGY_PERSON_IDS_ENABLED was off stay under the old person; consumer switches require that switch so this cannot happen
- Export:
  - `exportWholePerson` in `src/lib/audience/personExport.ts`, on a person's erase or export (AUDIENCE_ONE_VIEW_ENABLED is on; each row once, in its product's section when it is there)
  - `exportPerson` in `src/lib/audience/personExport.ts`, on a product user's erase or export (by the product user, their pu: person, and a removed product-only person)
  - Gap: an open new person suggestion for someone not yet in People has no export path; erase finds it by personId once they are added, and its details clear on confirm, dismiss or expiry within 7 days
  - Gap: team member ids stay as ids, with no export by team member
- Search: none. Personal data, kept out of brand search until the data processing agreement covers it.
- Numbers: none. A history of changes, not a brand number.

### Field (`custom_field`)

A field the brand adds to people or companies, of one of twelve types, managed in Settings › Data model. One list per object is a setting kept in the settings log, so every change is a version; a field is archived, never deleted, and its type is fixed once made. Values sit on the person or company under `fields.<fieldId>`, written only by `src/lib/tenant/recordFieldWrites.ts`, each change a record.field_changed event. Fields from sign-up questions, the catalog and enrichment are shown beside them, read only and never stored. Values that reach Vizzy (`vizzyReadsField`): a person's select, multi select, status, checkbox, number, currency and date fields, and text fields an admin ticked ‘Vizzy can read this field’ while AUDIENCE_VIZZY_TEXT_FIELDS_ENABLED is on, scrubbed of their name and address and cut to 500 characters; never email, phone, link or team member values, or a company's.

- Status: built
- Home: the brand's region
- Personal: the brand's own team
- Stores:
  - `record_field_lists`, the brand's regional Firestore, in `src/lib/tenant/repository.ts`. One document per brand and object (subjects fields:person and fields:company) with its `rev`, written only with its settings version (`src/lib/tenant/settingsLog.ts`); `createdBy` and `archivedBy` hold user ids, never an address; under 200 KB.
- Links: `settings_version` through its subject, one version per change of the list (many); `person` through contacts.fields.<fieldId> (many); `company` through companies.fields.<fieldId> (many); `ontology_event` through fieldId, one row per change of a value (many)
- Erase: gap. A field is archived, never deleted, and a team member's user id in createdBy or archivedBy stays an id when they leave; erasing archived values comes with piece O part 2.
- Export: gap. Team member ids stay as ids, with no export by team member; a person's export names each field of theirs with its label.
- Search: none. A field's values are found with its person.
- Numbers: none. A value belongs to one record and is not a brand metric.

### Consent purpose (`consent_purpose`)

What a person can agree to. The starting purposes are marketing email, product email and transactional, in CONSENT_PURPOSES (`src/lib/ontology/consent.ts`); support replies count as transactional. Piece F adds the settings.

- Status: planned, in F
- Home: the brand's region
- Personal: no
- Erase: none. Planned: piece F decides it with the store.
- Export: none. Planned: piece F decides it with the store.
- Search: none. A short fixed list.
- Numbers: none. Planned: piece F decides it with the store.

### Consent record (`consent_record`)

One person's consent for one purpose. The current state stays on the person record; each change is a consent.recorded event in the event history, shaped by `src/lib/ontology/consent.ts`. Every send checks it. Piece B records agreement and its withdrawal for people added by hand, each as easy as the other; this type brings consent for every channel (piece F).

- Status: planned, in F
- Home: the brand's region
- Personal: yes, the brand's people
- Links: `person` through personId; `consent_purpose` through purpose; `ontology_event` through its consent.recorded events (many)
- Erase: gap. Planned: piece F erases and exports it with the person.
- Export: gap. Planned: piece F erases and exports it with the person.
- Search: none. People's words wait for the data processing agreement to cover a new store of personal data.
- Numbers: none. Planned: piece F decides it with the store.

### View (`view`)

A saved filter, sort and set of columns over people or another record, shared or personal.

- Status: planned, in C
- Home: the brand's region
- Personal: no
- Erase: none. Planned: piece C decides it with the store.
- Export: none. Planned: piece C decides it with the store.
- Search: none. A saved query, found by name.
- Numbers: none. Planned: piece C decides it with the store.

### List (`list`)

Records in a process with their own fields and stages, such as investors or beta testers. Joining one never adds consent. People added by hand can be emailed only while their recorded agreement stands; withdrawing it is in piece B.

- Status: planned, in E
- Home: the brand's region
- Personal: yes, the brand's people
- Links: `person` through list entries (many)
- Erase: gap. Planned: piece E erases and exports list entries with the person.
- Export: gap. Planned: piece E erases and exports list entries with the person.
- Search: none. People's words wait for the data processing agreement to cover a new store of personal data.
- Numbers: none. Planned: piece E decides it with the store.

### Own object (`own_object`)

A kind of record the brand makes itself, such as deals or partners, registered like a core type.

- Status: planned, in I
- Home: the brand's region
- Personal: yes, the brand's people
- Erase: gap. Planned: piece I erases and exports records that point at a person.
- Export: gap. Planned: piece I erases and exports records that point at a person.
- Search: none. People's words wait for the data processing agreement to cover a new store of personal data.
- Numbers: none. Planned: piece I decides it with the store.

### Workflow (`workflow`)

A rule that starts a journey or a step when a field changes, a view gains someone or an idea's status moves.

- Status: planned, in L
- Home: the brand's region
- Personal: no
- Erase: none. Planned: piece L decides it with the store.
- Export: none. Planned: piece L decides it with the store.
- Search: none. Found by name on its own screen.
- Numbers: none. Planned: piece L decides it with the store.

### Import (`import`)

A file of records brought into an object or list, matched on email or domain, where a blank never overwrites.

- Status: planned, in J
- Home: the brand's region
- Personal: yes, the brand's people
- Links: `person` through the people it added or changed (many)
- Erase: gap. Planned: piece J decides how an import's rows are erased with the person.
- Export: gap. Planned: piece J decides how an import's rows are exported with the person.
- Search: none. People's words wait for the data processing agreement to cover a new store of personal data.
- Numbers: none. Planned: piece J decides it with the store.

## Support

Spine step 5. Help after the sale.

### Knowledge (`knowledge`)

Sites, files and repos the brand chose to read, in chunks with embeddings, plus a record of each page and each run.

- Status: built
- Home: the brand's region
- Personal: no
- Stores:
  - `ingestion_tickets`, the brand's regional Firestore, in `src/lib/tenant/repository.ts`. One per run.
  - `knowledge_bases` at `campaigns/{campaignId}/knowledge_bases`, the brand's regional Firestore, in `src/lib/tenant/knowledge.ts`
  - `knowledge_bases` at `workspaces/{workspaceId}/knowledge_bases`, the brand's regional Firestore, in `src/lib/tenant/knowledge.ts`
  - `knowledge_pages` at `campaigns/{campaignId}/knowledge_pages`, the brand's regional Firestore, in `src/lib/tenant/knowledge.ts`
  - `knowledge_pages` at `workspaces/{workspaceId}/knowledge_pages`, the brand's regional Firestore, in `src/lib/tenant/knowledge.ts`
  - `knowledge_bases`, the brand's regional Firestore, in `workers/knowledge-scraper/src/pipeline.ts`. The chunks, written by the knowledge scraper job.
  - `knowledge_pages`, the brand's regional Firestore, in `workers/knowledge-scraper/src/pipeline.ts`. The page records, written by the knowledge scraper job.
  - `ingestion_tickets`, the brand's regional Firestore, in `workers/knowledge-scraper/src/ticket.ts`. The job's progress.
- Links: `idea` through campaigns/{campaignId}; `workspace` through workspaces/{workspaceId}
- Erase:
  - `deleteOwnerKnowledge` in `src/lib/tenant/knowledge.ts`, on removing the record
  - `deleteWorkspace` in `src/lib/admin/workspaces.ts`, on removing the record
  - Gap: deleting a launch leaves its knowledge under `campaigns/{campaignId}`
- Export: none. Pages the brand chose to read, not anyone's personal data.
- Search: `knowledge`
- Numbers: none. No numbers an agent reads.

### Support conversation (`support_conversation`)

A thread from email or an in app chat, linked to the person, group and product, with help from the brand's knowledge.

- Status: planned, in support after the DPA line
- Home: the brand's region
- Personal: yes, the brand's people
- Links: `person` through personId; `knowledge` through the help it drew on (many)
- Erase: gap. Planned: support erases and exports conversations with the person, after the data processing agreement.
- Export: gap. Planned: support erases and exports conversations with the person, after the data processing agreement.
- Search: none. People's words wait for the data processing agreement to cover a new store of personal data.
- Numbers: none. Planned: support decides it with the store.

## Content

A rail beside the spine: the brand's own writing and assets.

### Programme (`workspace`)

A programme of content (a blog, a newsletter, an ebook), holding its plans, clippings, templates and knowledge.

- Status: built
- Home: the brand's region
- Personal: no
- Stores:
  - `workspaces`, the brand's regional Firestore, in `src/lib/tenant/repository.ts`
- Links: `content_plan` through workspaces/{workspaceId}/content_plans (many); `content_idea` through workspaces/{workspaceId}/idea_items (many); `template` through workspaces/{workspaceId}/templates (many)
- Erase:
  - `deleteWorkspace` in `src/lib/admin/workspaces.ts`, on removing the record
  - Gap: deleting a programme leaves its plans, clippings and templates in their subcollections
- Export: none. The brand's own work, with no one's personal data.
- Search: none. Its plans, clippings and templates are searched one by one.
- Numbers: none. No numbers an agent reads.

### Content (`content_plan`)

An article, newsletter, ebook, post or journey email: its plan, drafts and the final text.

- Status: built
- Home: the brand's region
- Personal: no
- Stores:
  - `content_plans` at `workspaces/{workspaceId}/content_plans`, the brand's regional Firestore, in `src/lib/tenant/workspaceContent.ts`
- Links: `workspace` through workspaceId
- Erase:
  - `deleteContentPlan` in `src/lib/tenant/workspaceContent.ts`, on removing the record
  - `removePlanPage` in `src/lib/content/blog/pageActions.ts`, on removing the record
- Export: none. The brand's own work, with no one's personal data.
- Search: `article`, `newsletter`, `ebook`, `post`, `journey_email`
- Numbers: none. A post's numbers are post results.

### Scrapbook clipping (`content_idea`)

Something the team clipped to write about later: a link, a note or a screenshot, kept in a programme's Scrapbook (once called the Idea Board). Not a business idea, which is `idea`.

- Status: built
- Home: the brand's region
- Personal: no
- Stores:
  - `idea_items` at `workspaces/{workspaceId}/idea_items`, the brand's regional Firestore, in `src/lib/tenant/workspaceContent.ts`
  - `workspace/{tenantId}/{workspaceId}/{file}`, Cloud Storage, in `src/lib/workspace/assetStore.ts`. The screenshots, private; residency gap: one EMAIL_ASSET_BUCKET holds every brand's files, whatever the brand's region.
- Links: `workspace` through workspaceId
- Erase:
  - `deleteIdeaItem` in `src/lib/tenant/workspaceContent.ts`, on removing the record
- Export: none. The brand's own work, with no one's personal data.
- Search: `idea_board`
- Numbers: none. No numbers an agent reads.

### Template (`template`)

A reusable shape for content.

- Status: built
- Home: the brand's region
- Personal: no
- Stores:
  - `templates` at `workspaces/{workspaceId}/templates`, the brand's regional Firestore, in `src/lib/tenant/workspaceContent.ts`
- Links: `workspace` through workspaceId
- Erase:
  - `deleteTemplate` in `src/lib/tenant/workspaceContent.ts`, on removing the record
- Export: none. The brand's own work, with no one's personal data.
- Search: `template`
- Numbers: none. No numbers an agent reads.

### Email template (`email_template`)

A saved email layout a programme reuses.

- Status: built
- Home: the brand's region
- Personal: no
- Stores:
  - `email_templates` at `workspaces/{workspaceId}/email_templates`, the brand's regional Firestore, in `src/lib/tenant/workspaceContent.ts`
- Links: `workspace` through workspaceId
- Erase:
  - `deleteEmailTemplate` in `src/lib/tenant/workspaceContent.ts`, on removing the record
- Export: none. The brand's own work, with no one's personal data.
- Search: none. A layout; the emails made with it are searched.
- Numbers: none. No numbers an agent reads.

### Broadcast (`broadcast`)

A one off email to a launch's waitlist.

- Status: built
- Home: the brand's region
- Personal: no
- Stores:
  - `broadcasts`, the brand's regional Firestore, in `src/lib/tenant/repository.ts`
- Links: `idea` through campaignId
- Erase:
  - `deleteLaunch` in `src/lib/tenant/launchDeletion.ts`, on deleting a launch
- Export: none. The brand's own work, with no one's personal data.
- Search: `broadcast`
- Numbers: none. Its sends are counted as email sends.

### Scheduled post (`scheduled_post`)

A social post waiting to go out on one of the brand's accounts, and what happened when it did.

- Status: built
- Home: the brand's region
- Personal: no
- Stores:
  - `campaign_scheduled_posts`, the brand's regional Firestore, in `src/lib/tenant/repository.ts`
- Links: `content_plan` through the plan it came from; `post_result` through its results
- Erase: none. Kept as the record of what the brand published.
- Export: none. The brand's own work, with no one's personal data.
- Search: none. Its text is searched from its content plan as a post.
- Numbers: none. Its numbers are post results.

### What posts taught (`post_learning`)

What the brand's best posts have in common, for the writer: the top posts, each post's vector for finding near repeats, and the versions of the patterns learned.

- Status: built
- Home: the brand's region
- Personal: no
- Stores:
  - `performance_exemplars`, the brand's regional Firestore, in `src/lib/tenant/exemplars.ts`
  - `post_perf_vectors`, the brand's regional Firestore, in `src/lib/tenant/postVectors.ts`
  - `learned_pattern_versions`, the brand's regional Firestore, in `src/lib/tenant/patternVersions.ts`. Append only, the source of a revert.
- Links: `post_result` through the posts it learned from (many)
- Erase: none. The brand's own content statistics.
- Export: none. The brand's own work, with no one's personal data.
- Search: none. Vectors and versions for the writer, not text to find.
- Numbers: none. Its numbers are post results.

### Generated image (`image_asset`)

An image made for the brand's content, with its prompt and where it is used.

- Status: built
- Home: the brand's region
- Personal: no
- Stores:
  - `image_assets`, the brand's regional Firestore, in `src/lib/tenant/repository.ts`
  - `{tenantId}/{campaignId}/{file}`, Cloud Storage, in `src/lib/agents/imageStore.ts`. The image files, served through the email asset proxy; residency gap: one EMAIL_ASSET_BUCKET holds every brand's files, whatever the brand's region.
- Links: `content_plan` through where it is used (many)
- Erase:
  - `deleteImageAsset` in `src/lib/admin/brandKit.ts`, on removing the record
- Export: none. The brand's own work, with no one's personal data.
- Search: `image`
- Numbers: none. No numbers an agent reads.

### Brand kit (`brand_kit`)

How the brand looks and sounds: voice, colours and email style on the brand record, plus its logos, fonts, icons, graphics and guideline files.

- Status: built
- Home: the brand's region
- Personal: no
- Stores:
  - `brand_logos`, the brand's regional Firestore, in `src/lib/tenant/repository.ts`
  - `brand_fonts`, the brand's regional Firestore, in `src/lib/tenant/repository.ts`
  - `brand_assets`, the brand's regional Firestore, in `src/lib/tenant/repository.ts`
  - `brand/{tenantId}/logos/{file}`, Cloud Storage, in `src/lib/tenant/brandLogo.ts`. Logo files; residency gap: one EMAIL_ASSET_BUCKET holds every brand's files, whatever the brand's region.
  - `brand/{tenantId}/fonts/{file}`, Cloud Storage, in `src/lib/tenant/brandFontStore.ts`. Font files; residency gap: one EMAIL_ASSET_BUCKET holds every brand's files, whatever the brand's region.
  - `brand/{tenantId}/{category}/{file}`, Cloud Storage, in `src/lib/tenant/brandAssetStore.ts`. Icons and graphics; residency gap: one EMAIL_ASSET_BUCKET holds every brand's files, whatever the brand's region.
  - `brand/{tenantId}/{file}`, Cloud Storage, in `src/lib/tenant/brandAsset.ts`. Brand guideline files, read only on the server; residency gap: one EMAIL_ASSET_BUCKET holds every brand's files, whatever the brand's region.
- Links: `brand` through brandKit and brandVoice on the brand record
- Erase:
  - `deleteLogo` in `src/lib/admin/brandLogos.ts`, on removing the record
  - `deleteBrandFont` in `src/lib/admin/brandFonts.ts`, on removing the record
  - `deleteBrandAsset` in `src/lib/admin/brandAssets.ts`, on removing the record
- Export: none. The brand's own work, with no one's personal data.
- Search: `brand_kit`
- Numbers: none. No numbers an agent reads.

### Author (`brand_author`)

A name the brand's articles are written under, with a role, a short bio and a profile page.

- Status: built
- Home: the brand's region
- Personal: the brand's own team
- Stores:
  - `brand_authors`, the brand's regional Firestore, in `src/lib/tenant/repository.ts`
- Links: `content_plan` through the articles written under the name (many)
- Erase: gap. No path removes an author when the person leaves the team.
- Export: none. Shown publicly on the brand's articles by choice.
- Search: `brand_kit`
- Numbers: none. No numbers an agent reads.

### Brand map (`brand_map`)

The brand's names and subjects, groups and buying situations that every article is written from, with its pages, runs and embeddings.

- Status: built
- Home: the brand's region
- Personal: no
- Stores:
  - `brand_maps`, the brand's regional Firestore, in `src/lib/tenant/repository.ts`
  - `brand_map_pages`, the brand's regional Firestore, in `src/lib/tenant/repository.ts`
  - `brand_map_pages`, the brand's regional Firestore, in `src/lib/tenant/brandMapPages.ts`
  - `brand_map_groups`, the brand's regional Firestore, in `src/lib/tenant/repository.ts`
  - `brand_map_subjects`, the brand's regional Firestore, in `src/lib/tenant/repository.ts`
  - `brand_map_situations`, the brand's regional Firestore, in `src/lib/tenant/repository.ts`
  - `brand_map_runs`, the brand's regional Firestore, in `src/lib/tenant/repository.ts`
  - `brand_map_groups`, the brand's regional Firestore, in `src/lib/tenant/brandMapRecords.ts`. Paged reads of every record kind.
  - `brand_map_vectors`, the brand's regional Firestore, in `src/lib/tenant/brandMapVectors.ts`
- Links: `brand_question` through subject and situation ids (many); `content_plan` through brand_map_pages (many)
- Erase:
  - `removeSubject` in `src/lib/brandMap/records.ts`, on removing the record
  - `removeGroup` in `src/lib/brandMap/records.ts`, on removing the record
  - `removeSituation` in `src/lib/brandMap/situations.ts`, on removing the record
- Export: none. The brand's own work, with no one's personal data.
- Search: `subject`, `situation`
- Numbers: none. No numbers an agent reads.

### Question (`brand_question`)

A question the brand's buyers ask, on the brand map, decided or still open.

- Status: built
- Home: the brand's region
- Personal: no
- Stores:
  - `brand_map_questions`, the brand's regional Firestore, in `src/lib/tenant/repository.ts`
- Links: `brand_map` through subject and situation ids; `data_connection` through fromConnectionId, on a question a rising Google search proposed
- Erase:
  - `removeQuestion` in `src/lib/brandMap/records.ts`, on removing the record
  - `eraseConnectionData` in `src/lib/connectors/erase.ts`, on removing the record (Disconnect and Change property withdraw the undecided questions a connection's rising searches proposed; decided ones stay)
  - `reconcileProposals` in `src/lib/connectors/signals/reconcile.ts`, on retention (a question a rising search proposed that is still undecided after 30 days is withdrawn)
- Export: none. The brand's own work, with no one's personal data.
- Search: `question`
- Numbers: none. Its outside numbers are brand signals.

### Research import (`research_import`)

A research file the brand brought in, read into findings for the brand map.

- Status: built
- Home: the brand's region
- Personal: no
- Stores:
  - `brand_map_imports`, the brand's regional Firestore, in `src/lib/tenant/repository.ts`
- Links: `brand_map` through what it found
- Erase:
  - `removeImport` in `src/lib/brandMap/imports.ts`, on removing the record
- Export: none. The brand's own work, with no one's personal data.
- Search: `research`
- Numbers: none. No numbers an agent reads.

### What we've seen note (`brand_note`)

A first hand note from the brand's team about what they have seen, or an open question asked of the team. A note may name a customer.

- Status: built
- Home: the brand's region
- Personal: yes, the brand's people
- Stores:
  - `brand_notes`, the brand's regional Firestore, in `src/lib/tenant/repository.ts`
- Links: `content_plan` through the articles it informed (many)
- Erase:
  - `removeNote` in `src/lib/brandNotes/store.ts`, on removing the record
  - Gap: a person's erase does not find notes that name them: notes are free text
- Export: gap. A person's export does not include notes that name them.
- Search: `note`, `question`
- Numbers: none. No numbers an agent reads.

### What the autopilot learned (`learned`)

What the brand's team kept, skipped and moved while planning, so the autopilot plans the way they do.

- Status: built
- Home: the brand's region
- Personal: no
- Stores:
  - `autopilot_learned`, the brand's regional Firestore, in `src/lib/tenant/repository.ts`
- Erase:
  - `removeLearned` in `src/lib/autopilot/learned.ts`, on removing the record
- Export: none. The brand's own work, with no one's personal data.
- Search: `learned`
- Numbers: none. No numbers an agent reads.

### Next up (`next_up`)

The brand's three best next articles, one record per brand, worked out again as things change.

- Status: built
- Home: the brand's region
- Personal: no
- Stores:
  - `next_up`, the brand's regional Firestore, in `src/lib/tenant/repository.ts`
- Links: `brand_question` through the questions it picked (many)
- Erase: none. Worked out again each time.
- Export: none. The brand's own work, with no one's personal data.
- Search: none. A short list read by Vizzy through get_next_up.
- Numbers: none. No numbers an agent reads.

### Autopilot run (`autopilot_run`)

One autopilot run: the question it found, how it sorted it and, in Draft mode, what it wrote.

- Status: built
- Home: the brand's region
- Personal: no
- Stores:
  - `autopilot_runs`, the brand's regional Firestore, in `src/lib/tenant/repository.ts`
- Links: `content_plan` through the draft it wrote
- Erase: none. Kept as the record of what the autopilot did.
- Export: none. The brand's own work, with no one's personal data.
- Search: none. A record of runs; what they wrote is searched as content.
- Numbers: none. No numbers an agent reads.

### Live watch (`live_watch`)

Found live's working state: when to look at the brand's site next, which article addresses it checks, and which of the site's pages it already opened.

- Status: built
- Home: the brand's region
- Personal: no
- Stores:
  - `live_watch`, the brand's regional Firestore, in `src/lib/tenant/repository.ts`
  - `live_watch_seen`, the brand's regional Firestore, in `src/lib/tenant/repository.ts`. The brand's pages already opened, as hashes.
- Links: `content_plan` through the articles it checks (many)
- Erase: none. Worked out again each time; what it finds is the article's live mark.
- Export: none. The brand's own work, with no one's personal data.
- Search: none. Working state; what it finds is searched as the article.
- Numbers: none. No numbers an agent reads.

### Freshness watch (`freshness_watch`)

Article freshness's daily record per brand: its live articles' counts by state and by clock, their pages, and the articles due a refresh. Each article's own clock and state live on the article.

- Status: built
- Home: the brand's region
- Personal: no
- Stores:
  - `freshness_watch`, the brand's regional Firestore, in `src/lib/tenant/repository.ts`
- Links: `content_plan` through the live articles it looks at (many)
- Erase: none. Worked out again each day; each article's freshness is on the article.
- Export: none. The brand's own work, with no one's personal data.
- Search: none. Working state; the articles are searched as themselves.
- Numbers: `articlesDue`, `articlesReviewSoon`, `articlesFresh`, `clockDays`, `liveArticles`, through `list_articles_due`

### Article versions (`article_version`)

A blog article's last 10 versions: its copy and meta just before Apply, Regenerate or Restore replaced them, for Restore. One record per article.

- Status: built
- Home: the brand's region
- Personal: no
- Stores:
  - `article_versions`, the brand's regional Firestore, in `src/lib/tenant/repository.ts`
- Links: `content_plan` through planId
- Erase:
  - `deleteContentPlan` in `src/lib/tenant/workspaceContent.ts`, on removing the record
- Export: none. The brand's own work, with no one's personal data.
- Search: none. Earlier copies of an article; the article itself is searched.
- Numbers: none. No numbers an agent reads.

### Article refresh review (`article_review`)

A live blog article's current or last refresh review: what it found (sources, research, the brand map, Search Console's searches for the page) and the changes it proposes for a person to apply. One record per article.

- Status: built
- Home: the brand's region
- Personal: no
- Stores:
  - `article_reviews`, the brand's regional Firestore, in `src/lib/tenant/repository.ts`
- Links: `content_plan` through planId
- Erase:
  - `deleteContentPlan` in `src/lib/tenant/workspaceContent.ts`, on removing the record
- Export: none. The brand's own work, with no one's personal data.
- Search: none. Working state; the article is searched as itself.
- Numbers: `changesProposed`, `reviewsLeftThisMonth`, through `review_article`

### Refresh record (`refresh_record`)

One per refresh review of a live blog article: why it ran (its clock and reasons), what it proposed, what a person decided, what it cost, and 28 days on, Search Console before and after beside articles left alone. What the clock readout (Which clock works) learns from.

- Status: built
- Home: the brand's region
- Personal: no
- Stores:
  - `refresh_records`, the brand's regional Firestore, in `src/lib/tenant/repository.ts`
- Links: `content_plan` through planId
- Erase: none. Counts, dates and the article's address only, no copy and no person; kept for the clock readout.
- Export: none. The brand's own work, with no one's personal data.
- Search: none. Numbers, read through the clock readout.
- Numbers: `refreshes`, `nothingShare`, `proposedAvg`, `acceptedAvg`, `costCentsAvg`, `clickLift`, `resultsNeeded`, `withResults`, `clicksPerDollar`, through `list_articles_due`

## Company

A rail beside the spine: the company itself, on the organisation.

### Business fact (`business_fact`)

Something Vizzy heard about the business and an admin kept: a timeline, channel, starting point, constraint or goal, each with the member's own words. With the four answers on the brand record, it is the brand's profile, which Vizzy reads in every chat.

- Status: built
- Home: the brand's region
- Personal: the brand's own team
- Stores:
  - `business_facts`, the brand's regional Firestore, in `src/lib/tenant/repository.ts`. One record per fact, at most 40 per brand; the quote is the member's own words.
- Links: `onboarding_conversation` through conversationId
- Erase:
  - `removeBusinessFact` in `src/lib/onboarding/store.ts`, on removing the record (an admin removes it on Here's what I learned or in Settings)
  - Gap: no path deletes a whole brand and everything it holds
  - Gap: a person's erase does not find a fact that names them: it is free text
- Export:
  - `listBusinessFacts` in `src/lib/onboarding/store.ts`, on the team member themselves (an admin reads them in Settings, About your business)
- Search: none. A short profile Vizzy reads whole, not searched.
- Numbers: none. No numbers an agent reads.

### Legal entity (`legal_entity`)

A company the founders formed, added whenever it exists, under its registered name. Brands point at it.

- Status: planned, in company rail
- Home: the control plane
- Personal: no
- Links: `organisation` through organisationId
- Erase: none. Planned: the company rail decides it with the store.
- Export: none. Planned: the company rail decides it with the store.
- Search: none. Planned: the company rail decides it with the store.
- Numbers: none. Planned: the company rail decides it with the store.

### Founder profile (`founder_profile`)

A founder's role, country, tax residence, ownership and funding plans, to pick partners and fill in forms. No identity documents. It lives on the organisation, in the control plane: one database for every region, a residency question for founders outside it.

- Status: planned, in company rail
- Home: the control plane
- Personal: the brand's own team
- Links: `organisation` through organisationId; `member` through the founder's user id
- Erase: none. Planned: the company rail decides it with the store.
- Export: none. Planned: the company rail decides it with the store.
- Search: none. Personal to the founder, never searched.
- Numbers: none. Planned: the company rail decides it with the store.

### Gate (`gate`)

A readiness check over metrics, such as LTV to CAC above 3. It guides and never locks; a founder can open it early.

- Status: planned, in company rail
- Home: undecided
- Personal: undecided
- Links: `metric_snapshot` through the metrics it checks (many)
- Erase: none. Decided with its home.
- Export: none. Decided with its home.
- Search: none. Planned: the company rail decides it with the store.
- Numbers: none. Planned: the company rail decides it with the store.

### Data share (`data_share`)

One of four levels of the company's numbers, picked for one recipient until an end date. Totals only, never people.

- Status: planned, in company rail
- Home: undecided
- Personal: undecided
- Links: `metric_snapshot` through the metrics it shows (many)
- Erase: none. Decided with its home.
- Export: none. Decided with its home.
- Search: none. Planned: the company rail decides it with the store.
- Numbers: none. Planned: the company rail decides it with the store.

## Partners and agents

A rail beside the spine: who acts for the brand.

### Vizzy editing memory (`vizzy_memory`)

What Vizzy learned about how each team member edits, kept per brand and member.

- Status: built
- Home: the control plane
- Personal: the brand's own team
- Stores:
  - `edit memories`, Memory Bank, in `src/lib/agents/memoryBank.ts`. Scope {tenant_id, user_id}; residency gap: one agent location (ROOT_AGENT_LOCATION) serves every region.
- Links: `member` through the user id in its scope
- Erase:
  - `forgetAllEditMemories` in `src/lib/agents/memoryBank.ts`, on the team member themselves
  - `forgetEditMemory` in `src/lib/agents/memoryBank.ts`, on the team member themselves
- Export:
  - `listEditMemories` in `src/lib/agents/memoryBank.ts`, on the team member themselves (the member sees them in Edit mode)
- Search: none. Read by Vizzy for the member it belongs to.
- Numbers: none. No numbers an agent reads.

### Vizzy chat (`vizzy_chat`)

A team member's chats with Vizzy, kept by Agent Engine as sessions.

- Status: built
- Home: the control plane
- Personal: the brand's own team
- Stores:
  - `sessions`, Agent Engine sessions, in `src/lib/agents/agentRuntime.ts`. One user id per brand and member; residency gap: one agent location (ROOT_AGENT_LOCATION) serves every region.
- Links: `member` through the composite user id
- Erase: gap. No path deletes a member's chats with Vizzy.
- Export: gap. No path exports a member's chats with Vizzy.
- Search: none. Members' own conversations.
- Numbers: none. No numbers an agent reads.

### Conversation with Vizzy (`onboarding_conversation`)

A team member's conversation with Vizzy about the business, on the welcome page, kept as words only (no audio), with what Vizzy learned from it until an admin confirms it. Read by the brand's admins in Settings, About your business, and by Vizzy.

- Status: built
- Home: the brand's region
- Personal: the brand's own team
- Stores:
  - `onboarding_conversations`, the brand's regional Firestore, in `src/lib/tenant/repository.ts`. One record per conversation, at most 200 turns and 40,000 characters; `by` holds the member's user id only.
- Links: `member` through by; `business_fact` through the facts kept from it (many)
- Erase:
  - `deleteConversation` in `src/lib/onboarding/store.ts`, on removing the record (an admin deletes it; the facts kept from it stay)
  - Gap: no path deletes a whole brand and everything it holds
  - Gap: the member's user id in `by` stays after they leave the team; no path removes it
  - Gap: a person's erase does not find a conversation that names them: it is free text
- Export:
  - `getConversation` in `src/lib/onboarding/store.ts`, on the team member themselves (an admin reads the whole transcript in Settings, About your business)
  - Gap: a person's export does not include a conversation that names them
- Search: none. A team member's own conversation, read whole by admins and by Vizzy, kept out of brand search.
- Numbers: none. No numbers an agent reads.

### MCP client (`mcp_client`)

An outside agent connected to the brand's MCP server, and what it may read and ask to write.

- Status: planned, in K
- Home: the brand's region
- Personal: no
- Links: `api_key` through its key
- Erase: none. Planned: piece K decides it with the store.
- Export: none. Planned: piece K decides it with the store.
- Search: none. Found on its own screen.
- Numbers: none. Planned: piece K decides it with the store.

### Connector manifest (`connector_manifest`)

What a connector says it produces: each stream's shape, its keys, the meaning of every number and the shared keys it joins on. Manifests are pure data kept in code (`src/lib/connectors/manifests`), so this type keeps no store and stays planned.

- Status: planned, in connectors 1
- Home: the brand's region
- Personal: no
- Links: `connector_stream` through its streams (many)
- Erase: none. Manifests live in code, with no store.
- Export: none. Manifests live in code, with no store.
- Search: none. Found on Connections.
- Numbers: none. Its numbers' meanings are claimed by the data connection that reads them.

### Partner (`partner`)

A provider and what it can do, from the manifest it publishes.

- Status: planned, in partner rail
- Home: undecided
- Personal: undecided
- Links: `provision` through what it carries out (many)
- Erase: none. Decided with its home.
- Export: none. Decided with its home.
- Search: none. Planned: the partner rail decides it with the store.
- Numbers: none. Planned: the partner rail decides it with the store.

### Provision (`provision`)

What the brand asked a partner to set up, which fields were sent (names only, values not kept) and how it went.

- Status: planned, in partner rail
- Home: undecided
- Personal: undecided
- Links: `partner` through the partner
- Erase: none. Decided with its home.
- Export: none. Decided with its home.
- Search: none. Planned: the partner rail decides it with the store.
- Numbers: none. Planned: the partner rail decides it with the store.

### Agent action (`agent_action`)

One record per suggestion an agent makes for the brand: what it proposes and on what basis (references with meaning keys, never free text), its state from proposed to acted, undone or declined, who decided and how to undo it. Every open one expires within 90 days, and the lifecycle tick declines it once it has. Its trail is the agent kinds of event in the event history. Vizzy's suggested changes to a person's fields and the New person forms it fills in are recorded here (piece B). Other drafts (canvas saves, brand notes, learning from a repo, autopilot runs and brand map research) and lifecycle AI lines are not recorded here yet: a later piece records them.

- Status: built
- Home: the brand's region
- Personal: yes, the brand's people
- Stores:
  - `agent_actions`, the brand's regional Firestore, in `src/lib/tenant/repository.ts`. One record per suggestion, written only through `src/lib/tenant/agentActions.ts`; its proposal, basis, result and undo may hold personal values.
- Links: `person` through personId, and the target when it is a person; `company` through the target, when it is a company; `idea` through the target, when it is an idea; `data_signal` through the target, when it is a suggestion from collected numbers; `brand_question` through the target, when it is a question proposed from Search Console; `ontology_event` through agentActionId, its agent kinds of event (many)
- Events: `agent.proposed`, `agent.approved`, `agent.acted`, `agent.undone`, `agent.declined`
- States: `proposed`, `approved`, `acted`, `undone`, `declined`
- Person fields: `personId` (written with the row)
- Erase:
  - `processContactEraseJob` in `src/lib/crm/eraseWorker.ts`, on a person's erase or export (by their person id, and the pu: person id of each product user they link, whatever the one view says)
  - `processContactEraseJob` in `src/lib/crm/eraseWorker.ts`, on a person's erase or export (a company's rows, when the company has no contacts left)
  - `eraseProductUserHistory` in `src/lib/connect/erase.ts`, on a product user's erase or export (by the product user, and by their pu: person's id)
  - `forgetGonePersonHistory` in `src/lib/ontology/erase.ts`, on a product user's erase or export (the person goes with their last product user, whether their record goes then or at a later sweep)
  - `forgetLeftBehindPeople` in `src/lib/ontology/erase.ts`, on a product user's erase or export (a person the product user left behind on a move (their pu: person, an earlier address), kept while it held field values, goes with its history when nothing else keeps it)
  - `deleteLaunch` in `src/lib/tenant/launchDeletion.ts`, on deleting a launch (an idea's rows, and the agent actions about it)
  - Gap: team member ids in actor, requestedBy, decidedBy, actedBy and undoneBy stay as ids after the member leaves and show as Former team member, as settings history does
  - Gap: rows about a product-only person whose address changed while ONTOLOGY_PERSON_IDS_ENABLED was off stay under the old person; consumer switches require that switch so this cannot happen
- Export:
  - `exportWholePerson` in `src/lib/audience/personExport.ts`, on a person's erase or export (AUDIENCE_ONE_VIEW_ENABLED is on; each row once, in its product's section when it is there)
  - `exportPerson` in `src/lib/audience/personExport.ts`, on a product user's erase or export (by the product user, their pu: person, and a removed product-only person)
  - Gap: an open new person suggestion for someone not yet in People has no export path; erase finds it by personId once they are added, and its details clear on confirm, dismiss or expiry within 7 days
  - Gap: team member ids stay as ids, with no export by team member
- Search: none. Found on Review; personal data, kept out of brand search until the data processing agreement covers it.
- Numbers: none. No numbers an agent reads.

## Platform

A rail beside the spine: the brand record, members, organisations and their plans, queues, limits, audit, search and outside providers.

### Usage meter (`usage_meter`)

What a brand used of each paid resource this month, such as web searches for research, by the feature that used it.

- Status: built
- Home: the brand's region
- Personal: no
- Stores:
  - `usage_meters`, the brand's regional Firestore, in `src/lib/tenant/repository.ts`. One record per brand per month, counts only.
- Erase: none. Counts only, kept as the record of what the brand used.
- Export: none. The brand's own work, with no one's personal data.
- Search: none. Counts, read on Plan and usage.
- Numbers: `usedThisMonth`, `monthlyLimit`, `leftThisMonth`, through `get_usage`

### Brand (`brand`)

The tenant: the face people see (name, voice, domains, sender) and the data wall (region, consent, keys, connections). Every record carries its id.

- Status: built
- Home: the control plane
- Personal: the brand's own team
- Stores:
  - `tenants`, control plane Firestore, in `src/lib/tenant/control.ts`. `billingTier` is still written for new brands, so a rollback to a build from before plans can list them, but nothing reads it.
  - `tenants`, control plane Firestore, in `src/lib/tenant/registry.ts`. The lookups by id, host and member.
  - `tenants`, control plane Firestore, in `workers/knowledge-scraper/src/gitToken.ts`. The scraper reads the brand's repo connection.
  - `tenants`, control plane Firestore, in `src/lib/tenant/organisations.ts`. The only writer of `organisationId` and `orgPlan`, a copy of the organisation's plan, both written in one transaction with the organisation.
- Links: `member` through tenant_users.tenantId (many); `brand_kit` through brandKit and brandVoice; `organisation` through organisationId, with a copy of its plan in orgPlan
- Erase: gap. No path deletes a whole brand and everything it holds.
- Export: none. The brand's own settings, read on its settings screens.
- Search: none. Its voice and kit are searched as brand_kit.
- Numbers: none. No numbers an agent reads.

### Member (`member`)

A team member's access to a brand, with their role.

- Status: built
- Home: the control plane
- Personal: the brand's own team
- Stores:
  - `tenant_users`, control plane Firestore, in `src/lib/tenant/repository.ts`
  - `tenant_users`, control plane Firestore, in `src/lib/tenant/control.ts`
  - `tenant_users`, control plane Firestore, in `src/lib/tenant/registry.ts`. The brands a user belongs to.
  - `tenant_users`, control plane Firestore, in `src/lib/tenant/organisations.ts`. Counts an organisation's users once across its brands (organisationUserIds).
- Links: `brand` through tenantId
- Erase: gap. No path removes a member or their data when they leave the team.
- Export: none. A member sees their own access on the Team screen.
- Search: none. Found on the Team screen.
- Numbers: none. No numbers an agent reads.

### Organisation (`organisation`)

The account above brands: its plan (self_hosted, free, pro, ultra or enterprise, from `src/lib/plans/catalog.ts`), the brands it lists, its users counted once across them, and the owners who see its totals on Plan and usage. Its id is `org_<tenantId>` for the brand it started with, or `org_<tenantId>_<6 characters>` when a brand split back out finds that id taken. Written only through `src/lib/tenant/organisations.ts`, in one transaction with its brands and its change log. Never deleted, even when a move leaves it empty. Never a brand's people.

- Status: built
- Home: the control plane
- Personal: the brand's own team
- Stores:
  - `organisations`, control plane Firestore, in `src/lib/tenant/organisations.ts`. `ownerIds` and `createdBy` hold Firebase user ids; `createdBy` is instead backfill, selfhost, seed or `script:<label>` when no member made it.
- Links: `brand` through brandIds, each brand pointing back with organisationId and keeping a copy of the plan in orgPlan (many); `member` through ownerIds and createdBy, as user ids; its users are the members of its brands, counted once (many); `organisation_change` through organisation_changes.organisationId (many); `organisation_connection` through organisation_connections.organisationId, in the region each was connected from (many)
- Erase:
  - `setOrganisationOwners` in `src/lib/tenant/organisations.ts`, on the team member themselves (an operator takes their user id out of `ownerIds` with `scripts/set-plan.ts --remove-owner`, on their erase request)
  - Gap: leaving a brand's team does not take a member's user id out of `ownerIds`; it stays until an operator removes it
  - Gap: `createdBy` keeps the user id of the member who made it (the brand's creator, or whoever took up an empty one again), with no path to clear it
  - Gap: no path deletes an organisation, even one a move leaves empty, so the user ids it holds are kept for its life
- Export: gap. Team member ids in `ownerIds` and `createdBy` stay as ids, with no export by team member; owners see the plan, brands and totals on Plan and usage.
- Search: none. A control plane record with no brand content or people, found on Plan and usage.
- Numbers: none. Its allowances and use show on Plan and usage; no agent reads them.

### Organisation change (`organisation_change`)

One row per change to an organisation, written in the same transaction as the change: organisation.created, plan.changed, brand.joined, brand.left, organisation.renamed and owners.changed, with the values before and after and who made it. Append only: a row is only ever added, never changed or deleted, and is kept with no time to live. Its id is `<organisationId>_<tenantId, or org>_<time>_<kind>_<8 random characters>`. Piece O may fold it into the settings history, or the event envelope may carry it later.

- Status: built
- Home: the control plane
- Personal: the brand's own team
- Stores:
  - `organisation_changes`, control plane Firestore, in `src/lib/tenant/organisations.ts`. Append only, written only through this file; `actor` is a Firebase user id or an operator label (`script:<label>`, `backfill:<label>`, seed or selfhost), and an owners.changed row lists owners' user ids in `from` and `to`.
- Links: `organisation` through organisationId; `brand` through tenantId, on brand.joined and brand.left; `member` through actor when it is a user id, and the owners an owners.changed row lists (many)
- Erase: gap. No path removes or rewrites a member's user id in `actor`, or in the `from` and `to` of an owners.changed row; ADR-0009 has an operator rewrite `actor` to "erased" by hand until piece O brings an erase path, which leaves `from` and `to`, including on the row that removing the owner writes.
- Export: gap. Team member ids in `actor`, `from` and `to` stay as ids, with no export by team member.
- Search: none. A control plane change log with no brand content or people.
- Numbers: none. No numbers an agent reads.

### Social account link (`social_connection`)

Which brand a connected social account's engagement goes to: one brand per account.

- Status: built
- Home: the control plane
- Personal: the brand's own team
- Stores:
  - `social_subscriptions`, control plane Firestore, in `src/lib/tenant/control.ts`. The account's id and handle, no tokens.
- Links: `brand` through tenantId
- Erase:
  - `deleteSocialSubscription` in `src/lib/tenant/control.ts`, on removing the record (when the account is disconnected)
- Export: none. The brand's own account, shown on Connections.
- Search: none. A routing record.
- Numbers: none. No numbers an agent reads.

### Domain grant (`domain_grant`)

The record of each domain a brand was allowed or refused, with how and by whom.

- Status: built
- Home: the control plane
- Personal: the brand's own team
- Stores:
  - `domain_grants`, control plane Firestore, in `src/lib/tenant/control.ts`. The acting member's user id, never an address.
- Links: `brand` through tenantId
- Erase: none. Kept on purpose as the audit trail of who allowed a domain.
- Export: none. An audit trail.
- Search: none. An audit trail.
- Numbers: none. No numbers an agent reads.

### Audit record (`audit_record`)

What was deleted, by whom and how much, written before and after a destructive action, also to a bucket that cannot be changed.

- Status: built
- Home: the control plane
- Personal: the brand's own team
- Stores:
  - `audit_events`, control plane Firestore, in `src/lib/tenant/audit.ts`. Counts only, never the erased data.
  - `audit objects`, write once audit bucket, in `src/lib/tenant/auditSink.ts`. AUDIT_LOG_BUCKET, with a locked retention policy.
- Links: `brand` through tenantId
- Erase: none. Kept on purpose: the trail that proves what was deleted.
- Export: none. An audit trail with counts only.
- Search: none. An audit trail.
- Numbers: none. No numbers an agent reads.

### Rate limit counter (`rate_limit`)

Short lived counters that keep each brand and caller within its limits, keyed by a hash.

- Status: built
- Home: the control plane
- Personal: no
- Stores:
  - `rate_limits`, control plane Firestore, in `src/lib/tenant/rateLimit.ts`. A time to live policy removes each counter after two hours.
- Erase: none. Hashed keys, removed after two hours.
- Export: none. Hashed keys with no person.
- Search: none. Counters.
- Numbers: none. No numbers an agent reads.

### Email code (`email_code`)

The 6-digit code emailed to confirm a password account's address: one per account, kept as a hash with its count of tries for 10 minutes. Once an address is locked out of codes, a link emailed in its place, kept as a hash for 30 minutes.

- Status: built
- Home: the control plane
- Personal: the brand's own team
- Stores:
  - `email_codes`, control plane Firestore, in `src/lib/tenant/emailCodes.ts`. Keyed by the account's Firebase user id; the code's SHA-256 and its tries, never the code or the address; deleted when used, on the fifth wrong try or when found expired, and removed by a time to live on ttl.
  - `email_code_guards`, control plane Firestore, in `src/lib/tenant/emailCodes.ts`. Keyed by the SHA-256 of the address, never the address; the times of its sends in the last hour and its wrong tries in the last day, across codes and accounts; removed by a time to live on ttl a day after the last.
  - `email_confirm_links`, control plane Firestore, in `src/lib/tenant/emailCodes.ts`. Keyed by the account's Firebase user id; the SHA-256 of the emailed link sent in place of a code once the address is locked, never the link or the address; deleted when used or found expired, and removed by a time to live on ttl after 30 minutes.
- Erase: none. Hashes with no address, removed by a time to live after 10 minutes (30 for a link), or a day for the per address counts.
- Export: none. Hashes with no address.
- Search: none. Codes.
- Numbers: none. No numbers an agent reads.

### Email job (`email_job`)

The queue behind every email: a send, a step, a contact erase, a sync or a person repoint (a product user's rows following them to another person) waiting to run, with retries.

- Status: built
- Home: the brand's region
- Personal: yes, the brand's people
- Stores:
  - `email_jobs`, the brand's regional Firestore, in `src/lib/tenant/repository.ts`. A job's payload can name a person; a person_repoint job holds a product user id and goes when it is done.
- Links: `idea` through campaignId
- Erase:
  - `deleteLaunch` in `src/lib/tenant/launchDeletion.ts`, on deleting a launch
  - Gap: a person's erase leaves their queued jobs; a queued send for a deleted sign-up drops when it runs
- Export: gap. Queued jobs are not in a person's export; what they sent is in email sends.
- Search: none. People's words wait for the data processing agreement to cover a new store of personal data.
- Numbers: none. No numbers an agent reads.

### Brand search index (`search_index`)

The brand's own index of what it wrote, by words and meaning, in its region's search database.

- Status: built
- Home: the brand's region
- Personal: no
- Stores:
  - `search_docs` at `brands/{tenantId}/search_docs`, the brand's regional search database, in `src/lib/tenant/searchIndex.ts`
  - `search_sources` at `brands/{tenantId}/search_sources`, the brand's regional search database, in `src/lib/tenant/searchIndex.ts`
- Erase:
  - `removeFromIndex` in `src/lib/search/indexer.ts`, on removing the record (when its record is removed; forced, whatever SEARCH_INDEX_ENABLED says, when a connection's collected searches are erased)
  - `sweepBrand` in `src/lib/search/sweep.ts`, on removing the record (the scheduled check drops records that are gone)
- Export: none. Copies of the brand's own writing.
- Search: none. It is the index.
- Numbers: none. No numbers an agent reads.

### Mailchimp audience (`mailchimp_audience`)

A copy of a launch's sign-ups in the brand's own Mailchimp audience, when the brand connects one.

- Status: built
- Home: the brand's region
- Personal: yes, the brand's people
- Stores:
  - `audience members`, an outside provider, in `src/lib/mailchimp/sync.ts`. Held by Mailchimp; residency gap: Mailchimp keeps it where Mailchimp runs.
- Links: `signup` through the address
- Erase:
  - `removeSignupFromAudience` in `src/lib/mailchimp/sync.ts`, on a person's erase or export (the contact erase job calls it)
- Export: gap. A person's export does not include what Mailchimp holds.
- Search: none. People's words wait for the data processing agreement to cover a new store of personal data.
- Numbers: none. No numbers an agent reads.

### Mandrill message log (`mandrill_message`)

Mandrill's own record of each email it sent for the brand, with the address and short metadata.

- Status: built
- Home: the brand's region
- Personal: yes, the brand's people
- Stores:
  - `messages`, an outside provider, in `src/lib/email/index.ts`. Held by Mandrill; residency gap: Mandrill keeps it where Mandrill runs.
- Links: `email_send` through mandrillMessageId
- Erase: gap. No erase reaches Mandrill's message log; it keeps it for its own retention period.
- Export: gap. A person's export does not include Mandrill's message log.
- Search: none. People's words wait for the data processing agreement to cover a new store of personal data.
- Numbers: none. Its events arrive as email events.

### Subscription (`subscription`)

The organisation's paid plan with YouGrow, from checkout, trial and renewals. Card details stay with the payment provider.

- Status: planned, in H
- Home: the control plane
- Personal: no
- Links: `organisation` through organisationId
- Erase: none. Planned: piece H decides it with the store.
- Export: none. Planned: piece H decides it with the store.
- Search: none. Billing records are not searched.
- Numbers: none. Planned: piece H decides it with the store.

### Settings version (`settings_version`)

Every change to how a brand works, with who, what and why: the items that changed and the whole setting after it. A restore makes a new version on top, and a version is never changed, pruned or deleted. Kept per brand in its region, with no organisation id: piece O reads an organisation's history through its brands. Piece B's People and Company field lists are the first settings it records.

- Status: built
- Home: the brand's region
- Personal: the brand's own team
- Stores:
  - `settings_versions`, the brand's regional Firestore, in `src/lib/tenant/repository.ts`. Written only through `src/lib/tenant/settingsLog.ts`, in one transaction with its setting; ids are `ss_<hash of brand and subject>_r<rev>`; `by` holds ids only, never a name or an address.
- Links: `member` through by.id, when a team member saved it
- Erase: gap. No path removes a team member's user id in `by` when they leave the team; it stays an id and shows as Former team member.
- Export: gap. Team member ids in `by` stay as ids, with no export by team member.
- Search: none. Found on a setting's history.
- Numbers: none. No numbers an agent reads.

### Team (`team`)

Roles beyond admin and member, and which objects, fields and lists each role may see.

- Status: planned, in M
- Home: the control plane
- Personal: the brand's own team
- Links: `member` through role (many)
- Erase: none. Planned: piece M decides it with the store.
- Export: none. Planned: piece M decides it with the store.
- Search: none. Found on the Team screen.
- Numbers: none. Planned: piece M decides it with the store.

### SSO identity (`sso_identity`)

How a team member signs in through their company's identity provider.

- Status: planned, in M
- Home: the control plane
- Personal: the brand's own team
- Links: `member` through the user id
- Erase: none. Planned: piece M decides it with the store.
- Export: none. Planned: piece M decides it with the store.
- Search: none. Never searched.
- Numbers: none. Planned: piece M decides it with the store.

### API key (`api_key`)

A key for the records API or the MCP server, one per brand, read only unless a team member allows more.

- Status: planned, in K
- Home: the brand's region
- Personal: no
- Links: `brand` through tenantId
- Erase: none. Planned: piece K decides it with the store.
- Export: none. A secret, never exported.
- Search: none. A secret, never searched.
- Numbers: none. Planned: piece K decides it with the store.

## Gaps

What the registry records as missing, by type. Each is a known gap, not a promise.

- Idea (`idea`):
  - Numbers: people counts per launch and product reach Vizzy through get_counts with no meanings (`src/lib/audience/agentCounts.ts`); the funnel the compare screen shows for each idea has no agent tool
- Sign-up (`signup`):
  - Erase: the BigQuery changelog mirror keeps a row's values after the row is erased in Firestore
  - Numbers: people counts per launch and product reach Vizzy through get_counts with no meanings (`src/lib/audience/agentCounts.ts`)
- Email send (`email_send`):
  - Erase: deleting a launch removes its sign-ups but leaves their rows here
  - Erase: while AUDIENCE_ONE_VIEW_ENABLED is off a person's erase keeps their product users, so a product user's rows keep that person's personId until the product user is erased (src/lib/crm/eraseWorker.ts step 2)
- Email event (`email_event`):
  - Erase: deleting a launch removes its sign-ups but leaves their rows here
  - Erase: the BigQuery changelog mirror keeps a row's values after the row is erased in Firestore
  - Erase: while AUDIENCE_ONE_VIEW_ENABLED is off a person's erase keeps their product users, so a product user's rows keep that person's personId until the product user is erased (src/lib/crm/eraseWorker.ts step 2)
- Form view (`widget_view`):
  - Numbers: form view counts have no meanings yet (semantic layer)
- Product event count (`product_event_day`):
  - Numbers: product event counts have no meanings yet (semantic layer)
- Social engagement (`social_event`):
  - Erase: a person's erase does not reach social engagement rows (`social_events`)
  - Export: a person's export does not include social engagement rows (`social_events`)
- Product (`product`):
  - Numbers: people counts per launch and product reach Vizzy through get_counts with no meanings (`src/lib/audience/agentCounts.ts`)
- Catalog (`catalog`):
  - Erase: no path removes a team member's user id in `savedBy` when they leave the team; it stays an id and shows as Former team member
  - Export: team member ids in `savedBy` stay as ids, with no export by team member
- Product user (`product_user`):
  - Numbers: people counts per launch and product reach Vizzy through get_counts with no meanings (`src/lib/audience/agentCounts.ts`)
- Product event (`product_event`):
  - Erase: while AUDIENCE_ONE_VIEW_ENABLED is off a person's erase keeps their product users, so a product user's rows keep that person's personId until the product user is erased (src/lib/crm/eraseWorker.ts step 2)
  - Numbers: product event counts have no meanings yet (semantic layer)
- Product webhook (`product_webhook`):
  - Erase: a product user's erase leaves webhooks still waiting to go; each expires after its retries
  - Export: not in a person's export: a webhook only carries a change on its way to the product
- Person (`person`):
  - Erase: a record that only came from products is kept when it holds field values its person can't take: its product was revoked, or, after a new address or a join to an address, the new record had its own value for that field or no room for it, or moving them failed on every one of the job's tries; it stays out of Everyone until the team erases it or the product user's erase takes it
  - Erase: a person left behind on an address change while ONTOLOGY_PERSON_IDS_ENABLED was off has no move for the product user's erase to find; fields need that switch, so values are only left behind while it is on
  - Numbers: people counts per launch and product reach Vizzy through get_counts with no meanings (`src/lib/audience/agentCounts.ts`)
- Company (`company`):
  - Erase: erasing one person keeps their company's field values while others still work there
  - Export: a person's export leaves out their company's own field values
- Engaged social profile (`social_profile`):
  - Erase: a person's erase does not reach engaged social profiles (`social_engaged`)
  - Export: a person's export does not include engaged social profiles (`social_engaged`)
- Journey enrolment (`enrolment`):
  - Erase: while AUDIENCE_ONE_VIEW_ENABLED is off a person's erase keeps their product users, so a product user's rows keep that person's personId until the product user is erased (src/lib/crm/eraseWorker.ts step 2)
- Person plan (`person_plan`):
  - Erase: while AUDIENCE_ONE_VIEW_ENABLED is off a person's erase keeps their product users, so a product user's rows keep that person's personId until the product user is erased (src/lib/crm/eraseWorker.ts step 2)
- Event history (`ontology_event`):
  - Erase: team member ids in actor, requestedBy, decidedBy, actedBy and undoneBy stay as ids after the member leaves and show as Former team member, as settings history does
  - Erase: rows about a product-only person whose address changed while ONTOLOGY_PERSON_IDS_ENABLED was off stay under the old person; consumer switches require that switch so this cannot happen
  - Export: an open new person suggestion for someone not yet in People has no export path; erase finds it by personId once they are added, and its details clear on confirm, dismiss or expiry within 7 days
  - Export: team member ids stay as ids, with no export by team member
- Knowledge (`knowledge`):
  - Erase: deleting a launch leaves its knowledge under `campaigns/{campaignId}`
- Programme (`workspace`):
  - Erase: deleting a programme leaves its plans, clippings and templates in their subcollections
- Author (`brand_author`):
  - Erase: no path removes an author when the person leaves the team
- What we've seen note (`brand_note`):
  - Erase: a person's erase does not find notes that name them: notes are free text
  - Export: a person's export does not include notes that name them
- Vizzy chat (`vizzy_chat`):
  - Erase: no path deletes a member's chats with Vizzy
  - Export: no path exports a member's chats with Vizzy
- Conversation with Vizzy (`onboarding_conversation`):
  - Erase: no path deletes a whole brand and everything it holds
  - Erase: the member's user id in `by` stays after they leave the team; no path removes it
  - Erase: a person's erase does not find a conversation that names them: it is free text
  - Export: a person's export does not include a conversation that names them
- Business fact (`business_fact`):
  - Erase: no path deletes a whole brand and everything it holds
  - Erase: a person's erase does not find a fact that names them: it is free text
- Brand (`brand`):
  - Erase: no path deletes a whole brand and everything it holds
- Member (`member`):
  - Erase: no path removes a member or their data when they leave the team
- Organisation (`organisation`):
  - Erase: leaving a brand's team does not take a member's user id out of `ownerIds`; it stays until an operator removes it
  - Erase: `createdBy` keeps the user id of the member who made it (the brand's creator, or whoever took up an empty one again), with no path to clear it
  - Erase: no path deletes an organisation, even one a move leaves empty, so the user ids it holds are kept for its life
  - Export: team member ids in `ownerIds` and `createdBy` stay as ids, with no export by team member; owners see the plan, brands and totals on Plan and usage
- Organisation change (`organisation_change`):
  - Erase: no path removes or rewrites a member's user id in `actor`, or in the `from` and `to` of an owners.changed row; ADR-0009 has an operator rewrite `actor` to "erased" by hand until piece O brings an erase path, which leaves `from` and `to`, including on the row that removing the owner writes
  - Export: team member ids in `actor`, `from` and `to` stay as ids, with no export by team member
- Email job (`email_job`):
  - Erase: a person's erase leaves their queued jobs; a queued send for a deleted sign-up drops when it runs
  - Export: queued jobs are not in a person's export; what they sent is in email sends
- Mailchimp audience (`mailchimp_audience`):
  - Export: a person's export does not include what Mailchimp holds
- Mandrill message log (`mandrill_message`):
  - Erase: no erase reaches Mandrill's message log; it keeps it for its own retention period
  - Export: a person's export does not include Mandrill's message log
- Settings version (`settings_version`):
  - Erase: no path removes a team member's user id in `by` when they leave the team; it stays an id and shows as Former team member
  - Export: team member ids in `by` stay as ids, with no export by team member
- Field (`custom_field`):
  - Erase: a field is archived, never deleted, and a team member's user id in createdBy or archivedBy stays an id when they leave; erasing archived values comes with piece O part 2
  - Export: team member ids stay as ids, with no export by team member; a person's export names each field of theirs with its label
- Consent record (`consent_record`):
  - Erase: planned: piece F erases and exports it with the person
  - Export: planned: piece F erases and exports it with the person
- List (`list`):
  - Erase: planned: piece E erases and exports list entries with the person
  - Export: planned: piece E erases and exports list entries with the person
- Group (`group`):
  - Erase: planned: piece G erases and exports a person's memberships with them
  - Export: planned: piece G erases and exports a person's memberships with them
- Own object (`own_object`):
  - Erase: planned: piece I erases and exports records that point at a person
  - Export: planned: piece I erases and exports records that point at a person
- Import (`import`):
  - Erase: planned: piece J decides how an import's rows are erased with the person
  - Export: planned: piece J decides how an import's rows are exported with the person
- Data connection (`data_connection`):
  - Erase: a team member's user id in ownerUid and in by stays after they leave the brand, as settings history does
- Organisation connection (`organisation_connection`):
  - Erase: an owner's user id in createdBy, signerUid, givenBy and by stays after they stop being an owner, as settings history does
- Agent action (`agent_action`):
  - Erase: team member ids in actor, requestedBy, decidedBy, actedBy and undoneBy stay as ids after the member leaves and show as Former team member, as settings history does
  - Erase: rows about a product-only person whose address changed while ONTOLOGY_PERSON_IDS_ENABLED was off stay under the old person; consumer switches require that switch so this cannot happen
  - Export: an open new person suggestion for someone not yet in People has no export path; erase finds it by personId once they are added, and its details clear on confirm, dismiss or expiry within 7 days
  - Export: team member ids stay as ids, with no export by team member
- Support conversation (`support_conversation`):
  - Erase: planned: support erases and exports conversations with the person, after the data processing agreement
  - Export: planned: support erases and exports conversations with the person, after the data processing agreement

## Residency gaps

Stores that don't keep to the brand's region.

- Scrapbook clipping: `workspace/{tenantId}/{workspaceId}/{file}` in `src/lib/workspace/assetStore.ts`. One EMAIL_ASSET_BUCKET holds every brand's files, whatever the brand's region.
- Generated image: `{tenantId}/{campaignId}/{file}` in `src/lib/agents/imageStore.ts`. One EMAIL_ASSET_BUCKET holds every brand's files, whatever the brand's region.
- Brand kit: `brand/{tenantId}/logos/{file}` in `src/lib/tenant/brandLogo.ts`. One EMAIL_ASSET_BUCKET holds every brand's files, whatever the brand's region.
- Brand kit: `brand/{tenantId}/fonts/{file}` in `src/lib/tenant/brandFontStore.ts`. One EMAIL_ASSET_BUCKET holds every brand's files, whatever the brand's region.
- Brand kit: `brand/{tenantId}/{category}/{file}` in `src/lib/tenant/brandAssetStore.ts`. One EMAIL_ASSET_BUCKET holds every brand's files, whatever the brand's region.
- Brand kit: `brand/{tenantId}/{file}` in `src/lib/tenant/brandAsset.ts`. One EMAIL_ASSET_BUCKET holds every brand's files, whatever the brand's region.
- Vizzy editing memory: `edit memories` in `src/lib/agents/memoryBank.ts`. One agent location (ROOT_AGENT_LOCATION) serves every region.
- Vizzy chat: `sessions` in `src/lib/agents/agentRuntime.ts`. One agent location (ROOT_AGENT_LOCATION) serves every region.
- Mailchimp audience: `audience members` in `src/lib/mailchimp/sync.ts`. Mailchimp keeps it where Mailchimp runs.
- Mandrill message log: `messages` in `src/lib/email/index.ts`. Mandrill keeps it where Mandrill runs.
- Organisation connection: `organisation_connections` in `src/lib/tenant/organisationConnections.ts`. Kept in the region of the brand it was connected from, which may not be the region of every brand it serves: only the sign in (its token, read into server memory) and each part's brand id, region and name cross; collected numbers stay in each brand's region.
