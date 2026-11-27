# The YouGrow ontology

Generated from `src/lib/ontology/registry.ts` and `src/lib/loops/registry.ts`. Don't edit this file: change a registry, then run `npm run ontology:doc`.

Every kind of thing YouGrow knows about, built or planned: where it is kept, whether it holds the brand's people, how it is erased and exported, how it is found, and how its numbers reach an agent. The spine runs from an idea to its signals, an optional product, customers and support, with rails beside it. A new collection or file store needs an entry in the registry: `src/lib/ontology/coverage.test.ts` fails until it has one. The Learning section at the end lists every place YouGrow makes a choice for a brand, and how that choice learns or why it doesn't.

106 types: 86 built and 20 planned.

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
- Made by: `waitlist_rank`, `waitlist_voice_chat` (see Learning)

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
- Made by: `canvas.invite_wave`, `email_copy`, `waitlist_rank` (see Learning)

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
- Made by: `canvas.journey`, `journeys`, `edit_mode`, `ab_winner`, `email_copy`, `email_hero` (see Learning)

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
- Made by: `send_time`, `ab_split`, `lifecycle_lines` (see Learning)

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
- Made by: `get_from_google`, `autopilot` (see Learning)

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
- Made by: `content_write`, `pattern_holdout` (see Learning)

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
- Made by: `trending` (see Learning)

### Competitor (`competitor`)

A competitor the brand watches: their sitemap's pages, their news posts, monthly changes, the findings from articles read in full, and the strategy group a person put it in. What they write is worked out from those findings when asked, never stored.

- Status: built
- Home: the brand's region
- Personal: no
- Stores:
  - `competitors`, the brand's regional Firestore, in `src/lib/tenant/repository.ts`
  - `competitor_pages`, the brand's regional Firestore, in `src/lib/tenant/repository.ts`
  - `competitor_posts`, the brand's regional Firestore, in `src/lib/tenant/repository.ts`
  - `competitor_changes`, the brand's regional Firestore, in `src/lib/tenant/repository.ts`
  - `competitor_articles`, the brand's regional Firestore, in `src/lib/tenant/repository.ts`. Findings and short quotes, never the article's text.
- Links: `brand_strategy` through its group, shown under Who you compete with, and its articles, which Propose and Against your competitors read
- Erase:
  - `removeCompetitor` in `src/lib/competitors/store.ts`, on removing the record
  - `removeArticles` in `src/lib/competitors/articles.ts`, on removing the record
- Export: none. Public pages about another business.
- Search: `competitor`
- Numbers: none. No numbers an agent reads.
- Made by: `competitor_site`, `competitor_analysis`, `competitor_articles`, `competitor_profile` (see Learning)

### Data connection (`data_connection`)

A brand's link to an outside source of numbers, such as a Cloudflare zone, a Search Console site, a Google Analytics property or an AI answers tool's brand: which connector, how it signs in, its health, who may read it live, and its secrets (a pasted token or MCP server key, or a Google sign in's access and refresh tokens), sealed with the brand, connection and slot bound in. A shared connection keeps no secret, only the Google address made for it. It may also be a part its organisation gave it (Connectors 3): then `source` names the organisation's connection and the region it is kept in, it keeps no secret and no address, and its token is read through the organisation's. Each change goes into an activity log kept 90 days.

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
- Numbers: `cfRequests`, `cfPageViews`, `cfVisits`, `cfUniqueVisitors`, `searchClicks`, `searchImpressions`, `searchCtr`, `searchPosition`, `merged`, `ga4Sessions`, `ga4ActiveUsers`, `ga4Views`, `ga4KeyEvents`, `aiShareOfVoice`, `aiMentions`, `aiRank`, `aiSentiment`, `promptEngines`, `promptBrandMentions`, `promptCompetitors`, `promptCitations`, `aiCitations`, `aiCitationShare`, through `read_connected_live`

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

Data collected from a connected source once a day, as its manifest's stream and its collect block describe it: Search Console's search numbers, Google Analytics' traffic, Cloudflare's zone totals and an AI answers tool's daily share of voice. Every built stream is about the brand's own site, never a person (a stream marked personal is refused until the data processing agreement covers it).

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
- Numbers: `searchClicks`, `searchImpressions`, `searchCtr`, `searchPosition`, `merged`, `ga4Sessions`, `ga4ActiveUsers`, `ga4Views`, `ga4KeyEvents`, `cfRequests`, `cfPageViews`, `cfVisits`, `cfUniqueVisitors`, `aiShareOfVoice`, `aiMentions`, `aiRank`, `aiSentiment`, `rowsDropped`, `lagDays`, `nearbySearches`, through `get_connected_numbers`

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
- Made by: `rising_search`, `losing_page`, `within_reach` (see Learning)

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
- Made by: `product_map` (see Learning)

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
- Made by: `enrichment` (see Learning)

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
- Made by: `journeys`, `canvas.lifecycle`, `canvas.journey_style`, `edit_mode`, `journey_shape`, `ab_winner` (see Learning)

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
- Made by: `journey_next_step`, `send_time`, `ab_split`, `insight_pick` (see Learning)

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
- Made by: `lifecycle_lines`, `insight_pick` (see Learning)

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
- Made by: `canvas.person_plan` (see Learning)

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
  - `record_field_lists`, the brand's regional Firestore, in `src/lib/tenant/repository.ts`. One document per brand and object (subjects fields:person and fields:company) with its `rev`, written only with its settings version (`src/lib/tenant/settingsLog.ts`); `createdBy`, `archivedBy` and `erasedBy` hold user ids, never an address; under 200 KB.
  - `field_erase_jobs`, the brand's regional Firestore, in `src/lib/tenant/repository.ts`. An owner's count and erase of an archived field's values (SETTINGS_ERASE_ENABLED), one per brand, object and field with a fixed id, written by `src/lib/settings/eraseArchived.ts`: ids, counts, a cursor and times, and who started it as a user id; never a value; no TTL.
- Links: `settings_version` through its subject, one version per change of the list (many); `person` through contacts.fields.<fieldId> (many); `company` through companies.fields.<fieldId> (many); `ontology_event` through fieldId, one row per change of a value (many)
- Erase:
  - `runFieldErase` in `src/lib/settings/eraseArchived.ts`, on an owner erasing an archived field's values (an owner with an admin row erases an archived field's values 30 days after its archive, with SETTINGS_ERASE_ENABLED: values and field tags off each person or company, blanked in the event history and agent actions; the definition stays, archived, with erasedAt)
  - Gap: a field is archived, never deleted, and a team member's user id in createdBy, archivedBy or erasedBy stays an id when they leave
  - Gap: an erased value can still sit in piece C's view rows until C extends the erase, and in Vizzy's chat sessions and the per person Memory Bank where Vizzy read it before
- Export: gap. Team member ids stay as ids, with no export by team member; a person's export names each field of theirs with its label.
- Search: none. A field's values are found with its person.
- Numbers: `pipelinePeople`, `stagePeople`, `passedPeople`, `reasonPasses`, `noReasonPasses`, `quietPeople`, `nextStepPastPeople`, `overduePeople`, `openFollowUps`, `quietAfterDays`, through `get_raise_pipeline`

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

A saved filter, sort and set of columns over People (CRM_VIEWS_ENABLED): up to 10 filters joined by all or any, 10 columns and one sort, read in memory up to 5,000 people a view. Team views (Everyone on the team) are the settings subject views:person, saved by admins and kept in the settings log, archived and never removed, and listed in Settings › History, where an admin restores one view at a time; Only me views belong to one team member, are not logged, never in History, and are deleted for real. A saved view never keeps typed words (text and email domain filters work while looking, decision 3), so neither store holds the values of the brand's people; both hold team members' user ids.

- Status: built
- Home: the brand's region
- Personal: the brand's own team
- Stores:
  - `saved_views`, the brand's regional Firestore, in `src/lib/tenant/settingsLog.ts`. The team's views, as the `views:person` setting: one document per brand, id from settingsDocId, one item per view (its id `viw_...`, name, filters, columns and sort, version, and who made, changed or archived it by user id), archived and never removed, written only with its settings version; caps 50 in use, 200 in all, under 200 KB, one view under 2 KB.
  - `member_views`, the brand's regional Firestore, in `src/lib/tenant/memberViews.ts`. One team member's Only me views: one document per brand and member, id `mv_` and a hash of both, with the member's user id and a rev checked in one transaction; not logged, a view is deleted for real; 50 a member.
- Links: `settings_version` through subject views:person, one version per team save (many); `custom_field` through the field ids its filters, columns and sort name (many); `member` through createdBy, changedBy and archivedBy on a team view, and member_views.userId (many)
- Erase: gap. Neither store holds a person's values, so a person's erase has nothing here; a team member's user id stays an id after they leave and shows as Former team member, and their member_views document stays, seen by nobody, as the field lists' user ids do.
- Export: gap. Neither store holds a person's values, so a person's export has nothing here; team member ids stay as ids, with no export by team member.
- Search: none. A saved query, found by name in the Views menu and through get_view_counts.
- Numbers: `viewPeople`, through `get_view_counts`

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
- Made by: `blog_research`, `autopilot_research`, `blog_write`, `fact_check`, `seen_notes`, `architect`, `content_write`, `content_email`, `content_hub`, `content_brief`, `content_angle`, `ebook`, `email_layout`, `edit_mode`, `canvas.content_plan`, `blog_refresh`, `autopilot`, `pattern_holdout`, `freshness_clock`, `refresh_due`, `found_live` (see Learning)

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
- Made by: `templates` (see Learning)

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
- Made by: `email_copy`, `edit_mode`, `email_hero` (see Learning)

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
- Made by: `content_write`, `spintax_variant`, `auto_plug`, `carousel` (see Learning)

### What posts taught (`post_learning`)

What the brand's best posts have in common, for the writer: the top posts, each post's vector for finding near repeats, and the versions of the patterns learned. Where turned on, the same store keeps the workflow emails and hub pieces a person approved, as examples for the email and hub writers.

- Status: built
- Home: the brand's region
- Personal: no
- Stores:
  - `performance_exemplars`, the brand's regional Firestore, in `src/lib/tenant/exemplars.ts`. The best posts, and the approved emails and hub pieces kept as examples.
  - `post_perf_vectors`, the brand's regional Firestore, in `src/lib/tenant/postVectors.ts`
  - `learned_pattern_versions`, the brand's regional Firestore, in `src/lib/tenant/patternVersions.ts`. Append only, the source of a revert.
- Links: `post_result` through the posts it learned from (many); `content_plan` through the approved pieces it keeps as examples (many)
- Erase:
  - `forgetPlanExamples` in `src/lib/content/create/approvedExamples.ts`, on removing the record (an approved example goes with its content plan; the post statistics are the brand's own and stay)
  - `forgetRemovedExamples` in `src/lib/content/create/approvedExamples.ts`, on removing the record (a piece taken off the canvas takes its approved example with it)
  - `forgetWorkspaceExamples` in `src/lib/content/create/approvedExamples.ts`, on removing the record (a deleted programme takes the approved examples of its plans with it)
- Export: none. The brand's own work, with no one's personal data.
- Search: none. Vectors and versions for the writer, not text to find.
- Numbers: none. Its numbers are post results.
- Made by: `post_feedback`, `content_email`, `content_hub` (see Learning)

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
- Made by: `blog_hero`, `post_image`, `email_block_image`, `email_hero`, `ebook_image`, `customize_image`, `image_style_pick` (see Learning)

### Brand kit (`brand_kit`)

How the brand looks and sounds: voice, colours, email style and image style on the brand record, plus its logos, fonts, icons, graphics and guideline files. The image style keeps the look learned from thumbs and ratings for each style, and Vizzy's suggested style waits beside it.

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
- Links: `brand` through brandKit, brandVoice, imageStyle (with its learned looks) and imageStyleSuggestion on the brand record
- Erase:
  - `deleteLogo` in `src/lib/admin/brandLogos.ts`, on removing the record
  - `deleteBrandFont` in `src/lib/admin/brandFonts.ts`, on removing the record
  - `deleteBrandAsset` in `src/lib/admin/brandAssets.ts`, on removing the record
- Export: none. The brand's own work, with no one's personal data.
- Search: `brand_kit`
- Numbers: none. No numbers an agent reads.
- Made by: `brand_voice`, `brand_kit`, `images`, `canvas.email_style`, `canvas.image_style` (see Learning)

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
  - `brand_map_vectors`, the brand's regional Firestore, in `src/lib/tenant/brandMapVectors.ts`. Until retired: subjects and situations move to brand search (search_index), SEARCH_OLD_VECTORS_RETIRED_ENABLED stops its writes and scripts/retire-old-vectors.ts empties it (ADR-0025).
- Links: `brand_question` through subject and situation ids (many); `content_plan` through brand_map_pages (many)
- Erase:
  - `removeSubject` in `src/lib/brandMap/records.ts`, on removing the record
  - `removeGroup` in `src/lib/brandMap/records.ts`, on removing the record
  - `removeSituation` in `src/lib/brandMap/situations.ts`, on removing the record
- Export: none. The brand's own work, with no one's personal data.
- Search: `subject`, `situation`
- Numbers: none. No numbers an agent reads.
- Made by: `brand_map_research`, `situations`, `situation_questions`, `canvas.brand_map`, `blog_research`, `autopilot_research`, `judge`, `competitor_topics` (see Learning)

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
- Made by: `brand_map_research`, `situation_questions`, `canvas.brand_map`, `judge`, `rising_search`, `repeat_match` (see Learning)

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
- Made by: `brand_map_research` (see Learning)

### Brand strategy (`brand_strategy`)

The brand's strategy, one record per brand, approved by a person: who it's for (audiences and 3 to 5 focus buying situations), who it competes with (in groups, found by the competitor finder or watched), where it wins and where they do (claims, each with its proof or shown as a gap), what it is not, and the quarter's goal. Keeps the draft a person edits, the approved one everything reads, the last 5 approved, the names marked Not a competitor, the stars, ticks, groups and edits people made, and the weekly check that sets the approved strategy against what the watched competitors publish.

- Status: built
- Home: the brand's region
- Personal: no
- Stores:
  - `brand_strategy`, the brand's regional Firestore, in `src/lib/tenant/repository.ts`. One document per brand; `by` and decisions hold the admin's email or user id.
- Links: `brand_map` through its audiences and identity, and the focus situations it stars on approval; `competitor` through the competitors a person ticked to monitor, or, joined to Competitors, every one the brand watches, live (many)
- Erase:
  - `deleteBrandStrategy` in `src/lib/brandStrategy/store.ts`, on removing the record (an admin presses Start over on the Strategy tab)
- Export: none. The brand's own work, with no one's personal data.
- Search: none. One short record per brand, read whole by the writer, research, Next up and Vizzy.
- Numbers: `focusQuestions`, `focusLiveArticles`, `foundTimes`, `theirArticles`, `theirNewArticles`, `competitorArticles`, `namingArticles`, through `get_brand_strategy`
- Made by: `brand_strategy`, `competitor_find`, `competitor_claim_match`, `strategy_check` (see Learning)

### Content strategy (`content_strategy`)

The brand's plan for the quarter, one record per brand, approved by a person: its decided questions merged by meaning into slots (one article each, with a stage, a kind of page and the live articles that answer it), 3 to 6 pillars with a hub each, a score for each slot and a 12 week roadmap of what to write, refresh or combine. Keeps the draft, the approved plan Next up reads, the last 5 approved in short, and the splits, joins, skips and moves people made.

- Status: built
- Home: the brand's region
- Personal: no
- Stores:
  - `content_strategy`, the brand's regional Firestore, in `src/lib/tenant/repository.ts`. One document per brand, question and page ids only; `by` and decisions hold the admin's email or user id.
- Links: `brand_strategy` through the approved strategy's focus situations, which its fit scores read; `brand_question` through the question ids each slot merges (many); `content_plan` through the live articles each slot is covered by, and what it refreshes or combines (many)
- Erase:
  - `deleteContentStrategy` in `src/lib/contentStrategy/store.ts`, on removing the record (an admin presses Start over on the Content plan)
- Export: none. The brand's own work, with no one's personal data.
- Search: none. One record per brand, read whole by Next up, the autopilot and Vizzy.
- Numbers: `slotCount`, `liveSlots`, `openSlots`, `questionsInPlan`, `questionsInSlot`, `roadmapSharePercent`, `articlesPerWeek`, `refreshSharePercent`, `targetPercent`, `questionsPercent`, `roadmapPercent`, `fitScore`, `demandScore`, `gapScore`, `depthScore`, `balanceScore`, `slotScore`, through `get_content_strategy`
- Made by: `content_strategy`, `slot_merge`, `roadmap_order` (see Learning)

### What we've seen note (`brand_note`)

A first hand note from the brand's team about what they have seen, or an open question asked of the team. A note may name a customer.

- Status: built
- Home: the brand's region
- Personal: yes, the brand's people
- Stores:
  - `brand_notes`, the brand's regional Firestore, in `src/lib/tenant/repository.ts`
  - `search_docs` at `brands/{tenantId}/search_docs`, the brand's regional search database, in `src/lib/tenant/searchIndex.ts`. Kept notes and the questions asked of the team, with their statuses, never a note that may name a customer (ADR-0025).
  - `brand_map_vectors`, the brand's regional Firestore, in `src/lib/tenant/brandMapVectors.ts`. Each note's and question's embedding, until retired (ADR-0025).
- Links: `content_plan` through the articles it informed (many)
- Erase:
  - `removeNote` in `src/lib/brandNotes/store.ts`, on removing the record
  - `removeFromIndex` in `src/lib/search/indexer.ts`, on removing the record (forced, whatever SEARCH_INDEX_ENABLED says, when a note is removed or ticked as naming a customer)
  - Gap: a person's erase does not find notes that name them: notes are free text
- Export: gap. A person's export does not include notes that name them.
- Search: `note`, `question`
- Numbers: none. No numbers an agent reads.
- Made by: `brand_notes`, `seen_notes`, `notes_rest` (see Learning)

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
- Numbers: `repeatSimilarity`, `questionsLeftOut`, `questionsLinkedByMeaning`, through `get_next_up`
- Made by: `next_up`, `next_up_order`, `refresh_share`, `competitor_topics`, `competitor_coverage`, `search_rerank`, `repeat_match`, `ai_answer_match` (see Learning)

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
- Made by: `autopilot`, `judge`, `autopilot_cadence` (see Learning)

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
- Made by: `refresh_due`, `freshness_clock` (see Learning)

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
- Made by: `blog_write`, `blog_refresh` (see Learning)

### AI original (`ai_original`)

The exact copy a writer made for one piece of a content plan (an article, its teaser, promo, posts or emails), with the prompt, model and sources that made it and any approved pieces it followed as examples, kept beside the copy a person edits; and for its last 3 approvals, the copy a person approved and how it differs. What the learning loops will learn from a team's edits with. One record per piece.

- Status: built
- Home: the brand's region
- Personal: no
- Stores:
  - `ai_originals`, the brand's regional Firestore, in `src/lib/tenant/repository.ts`
- Links: `content_plan` through planId
- Erase:
  - `deleteContentPlan` in `src/lib/tenant/workspaceContent.ts`, on removing the record
- Export: none. The brand's own work, with no one's personal data.
- Search: none. Earlier copies of a piece; the piece itself is searched.
- Numbers: `draftWordsChanged`, `draftWordsChangedShare`, `draftSectionsAdded`, `draftSectionsCut`, `draftFiguresChanged`, `draftLinksChanged`, `draftRegenerations`, `draftMinutesToApprove`, through `get_content_plan`
- Made by: `blog_write`, `content_write`, `content_hub`, `content_email`, `blog_refresh` (see Learning)

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
- Made by: `blog_refresh` (see Learning)

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
- Made by: `blog_refresh`, `freshness_clock` (see Learning)

## Company

A rail beside the spine: the company itself, on the organisation.

### Business fact (`business_fact`)

Something Vizzy heard about the business and an admin kept: a timeline, channel, starting point, constraint or goal, each with the member's own words. It comes from a call on the welcome, or from a later chat, where it waits as an agent action until an admin keeps it. With the four answers on the brand record, it is the brand's profile, which Vizzy reads in every chat.

- Status: built
- Home: the brand's region
- Personal: the brand's own team
- Stores:
  - `business_facts`, the brand's regional Firestore, in `src/lib/tenant/repository.ts`. One record per fact, at most 40 per brand; the quote is the member's own words.
- Links: `onboarding_conversation` through conversationId; `agent_action` through the chat suggestion it was kept from (its result names the fact)
- Erase:
  - `removeBusinessFact` in `src/lib/onboarding/store.ts`, on removing the record (an admin removes it on Here's what I learned or in Settings)
  - Gap: no path deletes a whole brand and everything it holds
  - Gap: a person's erase does not find a fact that names them: it is free text
- Export:
  - `listBusinessFacts` in `src/lib/onboarding/store.ts`, on the team member themselves (an admin reads them in Settings, About your business)
- Search: none. A short profile Vizzy reads whole, not searched.
- Numbers: none. No numbers an agent reads.
- Made by: `onboarding`, `vizzy_chat` (see Learning)

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
- Made by: `edit_memory` (see Learning)

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
- Made by: `vizzy_chat` (see Learning)

### Conversation with Vizzy (`onboarding_conversation`)

A team member's conversation with Vizzy about the business, kept as words only (no audio): a call on the welcome page, with what Vizzy learned from it until an admin confirms it, or the three lines of a later chat whose fact an admin kept. Read by the brand's admins in Settings, About your business, and by Vizzy.

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
- Made by: `onboarding_voice`, `onboarding` (see Learning)

### Your next action (`next_action_card`)

The card Vizzy writes for Home's Your next action: 1 to 3 steps from the brand's four answers, the facts an admin kept and where the brand is, each with a line on why in the founder's own terms, and the newest 30 outcomes of earlier steps (done, answered, dismissed with the reason a person gave, or replaced untouched) with each step's newest dismissal of the last 30 days, which the next card reads. One record per brand. Each step is also an agent action, which holds only ids.

- Status: built
- Home: the brand's region
- Personal: the brand's own team
- Stores:
  - `next_action_cards`, the brand's regional Firestore, in `src/lib/tenant/repository.ts`. One record per brand: the card, the hash of what it was written from, the day's count, and the newest 30 outcomes with each step's newest dismissal of the last 30 days; a dismissal's reason is the member's own words.
- Links: `brand` through one record per brand; `agent_action` through each step's agentActionId (many); `business_fact` through the lines it was written from (many)
- Erase:
  - `forgetNextActionCard` in `src/lib/tenant/nextActionCards.ts`, on removing the record (an admin removes a fact or deletes a conversation in About your business: the card and every title, reason and answer go; only the day's count and which steps were dismissed (ids and times) stay)
  - `trimOutcomes` in `src/lib/tenant/nextActionCards.ts`, on retention (outcomes past the newest 30 (besides each step's newest dismissal of the last 30 days), or older than 90 days, are never read again and leave when the record is next written)
  - Gap: no path deletes a whole brand and everything it holds
  - Gap: a person's erase does not find a reason that names them: it is free text
- Export:
  - `readNextActionCard` in `src/lib/tenant/nextActionCards.ts`, on the team member themselves (an admin reads the card on Home, and Vizzy reads it with its outcomes through get_next_action)
- Search: none. A short card read whole on Home and by Vizzy, not searched.
- Numbers: none. No numbers an agent reads.
- Made by: `next_action` (see Learning)

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

One record per suggestion an agent makes for the brand: what it proposes and on what basis (references with meaning keys, never free text), its state from proposed to acted, undone or declined, who decided and how to undo it. Every open one expires within 90 days, and the lifecycle tick declines it once it has. Its trail is the agent kinds of event in the event history. Vizzy's suggested changes to a person's fields and the New person forms it fills in are recorded here (piece B), and so is what it heard about the business in a chat, until an admin keeps it in About your business, and each step on Home's Your next action, from proposed to acted (done or answered) or declined (dismissed, or superseded when a new card replaced it untouched). So is each follow-up YouGrow's rule raises from an investor or funding board on People, from proposed to acted (followed up) or declined (dismissed, set aside or expired). With the agent record on (AGENT_RECORD_ENABLED, ADR-0026), what Vizzy, research and the autopilot draft is recorded too, one open record per draft from saved to kept (and whether a person edited it first) or dismissed, holding ids, a label and a fingerprint only: journeys in either engine, invite waves, content plans, email and image style suggestions, a journey's own style, brand map suggestions and research runs, notes from chat, learning a product's map from its repo, and the autopilot's drafts; a daily catch-up closes what moved on another way, and Vizzy reads them with get_drafts. Lifecycle AI lines and plans for one person are not recorded (decision 2), nor refresh reviews, Next up picks, the judge's sorting, email assist or Edit mode.

- Status: built
- Home: the brand's region
- Personal: yes, the brand's people
- Stores:
  - `agent_actions`, the brand's regional Firestore, in `src/lib/tenant/repository.ts`. One record per suggestion, written only through `src/lib/tenant/agentActions.ts`; its proposal, basis, result and undo may hold personal values.
- Links: `person` through personId, and the target when it is a person; `company` through the target, when it is a company; `idea` through the target, when it is an idea; `data_signal` through the target, when it is a suggestion from collected numbers; `brand_question` through the target, when it is a question proposed from Search Console; `brand` through the target, when it is something Vizzy heard about the business in a chat, or a step on Your next action; `next_action_card` through the card's step records name it; `launch_journey` through draft, a launch's welcome emails on the original engine (agent record); `lifecycle_journey` through draft, a journey Vizzy drafted or styled (agent record); `invite_wave` through draft, an invite wave Vizzy drafted (agent record); `content_plan` through draft, a plan Vizzy or the autopilot drafted (agent record); `brand_map` through draft, one research run or chat call with hashes of the keys it filed (agent record); `brand_note` through draft, a note Vizzy suggested in a chat (agent record); `repo_map` through draft, learning a product's map from its repo, by product (agent record); `ontology_event` through agentActionId, its agent kinds of event (many)
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
- Made by: `canvas.person_fields`, `canvas.new_person`, `rising_search`, `losing_page`, `within_reach`, `canvas.journey`, `canvas.lifecycle`, `canvas.invite_wave`, `canvas.content_plan`, `canvas.email_style`, `canvas.image_style`, `canvas.journey_style`, `canvas.brand_map`, `vizzy_chat`, `brand_map_research`, `product_map`, `autopilot`, `investor_quiet` (see Learning)

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
- Made by: `sidebar_fit` (see Learning)

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

The brand's own index of what it wrote, by words and meaning, in its region's search database. With SEARCH_FAMILY_INDEX_ENABLED it also keeps the brand map family for every brand, each with its status (subjects and situations decided or proposed, kept notes, questions asked or answered, competitor articles), for the readers that match by meaning; people's search shows no proposal or answered question (ADR-0025).

- Status: built
- Home: the brand's region
- Personal: no
- Stores:
  - `search_docs` at `brands/{tenantId}/search_docs`, the brand's regional search database, in `src/lib/tenant/searchIndex.ts`
  - `search_sources` at `brands/{tenantId}/search_sources`, the brand's regional search database, in `src/lib/tenant/searchIndex.ts`
- Erase:
  - `removeFromIndex` in `src/lib/search/indexer.ts`, on removing the record (when its record is removed; forced, whatever SEARCH_INDEX_ENABLED says, when a connection's collected searches are erased)
  - `sweepBrand` in `src/lib/search/sweep.ts`, on removing the record (the scheduled check drops records that are gone)
  - `removeFamily` in `src/lib/search/familyIndex.ts`, on removing the record (at once and forced, whatever SEARCH_INDEX_ENABLED says, when a subject, situation, note or competitor's articles are removed)
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
- Your next action (`next_action_card`):
  - Erase: no path deletes a whole brand and everything it holds
  - Erase: a person's erase does not find a reason that names them: it is free text
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
  - Erase: a field is archived, never deleted, and a team member's user id in createdBy, archivedBy or erasedBy stays an id when they leave
  - Erase: an erased value can still sit in piece C's view rows until C extends the erase, and in Vizzy's chat sessions and the per person Memory Bank where Vizzy read it before
  - Export: team member ids stay as ids, with no export by team member; a person's export names each field of theirs with its label
- Consent record (`consent_record`):
  - Erase: planned: piece F erases and exports it with the person
  - Export: planned: piece F erases and exports it with the person
- View (`view`):
  - Erase: neither store holds a person's values, so a person's erase has nothing here; a team member's user id stays an id after they leave and shows as Former team member, and their member_views document stays, seen by nobody, as the field lists' user ids do
  - Export: neither store holds a person's values, so a person's export has nothing here; team member ids stay as ids, with no export by team member
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

## Learning

Generated from `src/lib/loops/registry.ts` (ADR-0017 in `docs/DECISIONS.md`). Every place YouGrow makes a choice for a brand has one line there: each AI purpose, each canvas Vizzy fills, each connector rule, each other rule and each model call with no meter. A new one fails `npm run typecheck` until it has its line (a rule once it is listed in `RULE_DECISIONS`, and a model call with no meter once it is listed in `UNMETERED_CALLS`), and the line gives one of five answers:

- Learns: it learns for each brand through the loops, behind its own switch.
- Fleet only: it is counted for every brand, and changes only through a pull request the owner merges.
- Own: it already learns from people, in that store, where the switches for that learning are on.
- Gap: it should learn and doesn't yet, with a date to look again.
- None: it should never learn, and the line says why.

A call site is a file where a kind is made, counted once for each kind: a meter call that names its purpose, a canvas's module, the file that holds a rule, or the file that calls a model with no meter.

99 kinds: 0 learn, 0 fleet only, 26 own, 32 gap and 41 none.

120 call sites: 0 learn, 0 fleet only, 36 own, 38 gap and 46 none.

Not learning: 84 of 120 call sites, under gap and none lines.

### Where own lines keep what they learned

- `learned`: The Learned list keeps what the team kept, skipped and moved while planning, with their reasons.
- `post_learning`: Post patterns and the best posts, worked out from how the brand's LinkedIn and X posts did, and where turned on the workflow emails and hub pieces a person approved, kept as examples.
- `vizzy_memory`: Memory Bank keeps what Vizzy learned about how each team member edits, per brand and member.
- `brand_kit`: Where learning from image votes is turned on, the brand record keeps the image look learned from thumbs and ratings, and with image styles on, one look for each painted style.
- `brand_map`: The brand map keeps the names, subjects, groups, situations and topics a person dismissed, with its list of dismissed suggestions holding the newest 300.
- `brand_question`: Each question a person dismissed stays on the brand map marked dismissed.
- `article_review`: An article's review keeps the fingerprints of the last 50 changes a person dismissed on it.
- `content_plan`: An article's brief keeps up to 50 notes a person took out of it.
- `broadcast`: Each one off launch email keeps its open and click rates once its report is read.
- `refresh_record`: Each refresh record keeps its clock, what a person decided and the clicks 28 days on.
- `next_action_card`: The card's record keeps the newest 30 outcomes of its steps and each step's newest dismissal of the last 30 days, with the reason a person gave for it.
- `brand_strategy`: The brand strategy keeps the newest 50 names a person marked Not a competitor, beside the stars, ticks, groups and edits people made.
- `lifecycle_journey`: A launch's journey on the lifecycle engine keeps each email test winner a person picked, with when and the versions it was picked from.

### Learns

No line says this yet.

### Fleet only

No line says this yet.

### Own

- `brand_map_research` (AI purpose, Brand map research), kept in `brand_map`. A name, subject or group your team dismissed on the brand map is kept there and not proposed again.
  - `src/lib/brandMap/importPlace.ts`
  - `src/lib/brandMap/imports.ts`
  - `src/lib/brandMap/research.ts`
  - `src/lib/brandMap/sortGroups.ts`
- `situations` (AI purpose, Finding buying situations), kept in `brand_map`. A buying situation your team already has or dismissed is never proposed again by research.
  - `src/lib/brandMap/findSituations.ts`
  - `src/lib/brandMap/situationsApi.ts`
  - `src/lib/canvas/kinds/brandMap.ts`
- `situation_questions` (AI purpose, Questions for a buying situation), kept in `brand_question`. A question your team dismissed on the brand map is never proposed or linked to a situation again.
  - `src/lib/brandMap/situationQuestions.ts`
  - `src/lib/brandMap/situationsApi.ts`
  - `src/lib/canvas/kinds/brandMap.ts`
- `competitor_find` (AI purpose, Finding competitors), kept in `brand_strategy`. Where the strategy is joined to Competitors, a name a person marked Not a competitor is kept on the brand strategy and the finder never suggests it again.
  - `src/lib/brandStrategy/finder.ts`
- `blog_refresh` (AI purpose, Article refresh reviews), kept in `article_review`. A change your team dismissed on an article is kept with the last 50 on its review and not proposed for that article again.
  - `src/lib/content/blog/refreshReview.ts`
- `seen_notes` (AI purpose, What we've seen), kept in `content_plan`. A note your team took out of an article is kept with the last 50 on its brief and not matched back into it.
  - `src/lib/content/blog/seen.ts`
- `content_write` (AI purpose, Writing posts), kept in `post_learning`. Where those parts are turned on, LinkedIn and X posts learn from how your past posts did and from how each team member edits them, while posts for other channels learn nothing yet.
  - `src/lib/content/create/generateNode.ts`
- `content_email` (AI purpose, Writing workflow emails), kept in `post_learning`. Where turned on, a workflow email follows the emails your team approved, kept as examples of the brand's own writing, though how your team edited each draft teaches it nothing yet.
  - `src/lib/content/create/generateNode.ts`
- `content_hub` (AI purpose, Writing hub content), kept in `post_learning`. Where turned on, a newsletter or blog hub follows the hub pieces your team approved or put live, kept as examples, though an eBook hub reads none and edits to each draft teach it nothing yet.
  - `src/lib/content/create/generateNode.ts`
- `edit_mode` (AI purpose, Edit mode), kept in `vizzy_memory`. Where learning from edits is turned on for the brand, Vizzy remembers how each team member edits in Edit mode, and each of them can turn it off or make it forget.
  - `src/app/api/admin/editor/vizzy/route.ts`
- `email_copy` (AI purpose, Email copy), kept in `broadcast`. Email assist reads the open and click rates of the launch's last five one off emails with a report before it writes, though invite wave copy reads none.
  - `src/app/api/admin/email/assist/route.ts`
  - `src/lib/canvas/kinds/inviteWave.ts`
- `next_up` (AI purpose, Next up), kept in `learned`. Next up learns from the picks your team skips, kept with their reason on the Learned list.
  - `src/lib/nextUp/pick.ts`
- `judge` (AI purpose, Sorting what buyers ask), kept in `learned`. Where learning from the Learned list is turned on, the sorting learns from the questions your team moves between trays.
  - `src/lib/signals/judge.ts`
- `next_action` (AI purpose, Your next action), kept in `next_action_card`. A step your team dismissed stays off the card for 30 days, and the next card for the brand reads what was done, answered, dismissed with its reason or left untouched.
  - `src/lib/nextAction/service.ts`
- `blog_hero` (AI purpose, Blog hero images), kept in `brand_kit`. Where learning from image votes is turned on, blog heroes made on the article follow the look learned from your thumbs and ratings, but a hero Vizzy makes during a chat skips it.
  - `src/lib/content/blog/hero.ts`
- `post_image` (AI purpose, Post images), kept in `brand_kit`. Where learning from image votes is turned on, painted post images follow the look learned from your thumbs and ratings, but drawn styles, format cards and charts skip it.
  - `src/app/api/admin/workspace/[workspaceId]/content-plans/[planId]/nodes/[nodeId]/post-image/route.ts`
- `email_block_image` (AI purpose, Email images), kept in `brand_kit`. Where learning from image votes is turned on, images inside emails follow the look learned from your thumbs and ratings on brand images.
  - `src/app/api/admin/workspace/[workspaceId]/content-plans/[planId]/nodes/[nodeId]/image/route.ts`
- `ebook_image` (AI purpose, eBook images), kept in `brand_kit`. Where learning from image votes is turned on, eBook images follow the look learned from your thumbs and ratings on brand images.
  - `src/app/api/admin/workspace/[workspaceId]/content-plans/[planId]/ebook/images/route.ts`
- `autopilot` (AI purpose, Autopilot), kept in `learned`. The autopilot drafts only Next up's picks, so a pick your team skipped in the last 30 days is not drafted.
  - `src/lib/autopilot/draftSteps.ts`
  - `src/lib/autopilot/find.ts`
  - `src/lib/signals/collect.ts`
- `canvas.brand_map` (canvas), kept in `brand_map`. A change a person dismissed is kept on the brand map and Vizzy does not file it again, though a buying situation a person asks Vizzy for in chat comes back as a suggestion.
  - `src/lib/canvas/kinds/brandMap.ts`
- `ab_winner` (rule, Email test winner), kept in `lifecycle_journey`. Where turned on, the winner a person picks for an email test after 50 sends reaches the journey the launch sends from on either engine, so everyone who gets that email from then on gets the winner.
  - `src/lib/journey/abTest.ts`
- `next_up_order` (rule, Next up shortlist), kept in `learned`. Questions the team skipped in the last 30 days are left out of the shortlist, read from the Learned list, and where turned on a subject counts by its size as well as its share answered.
  - `src/lib/nextUp/candidates.ts`
- `repeat_match` (rule, Repeat match), kept in `learned`. A question your team wrote anyway, added to an article or unlinked is kept on the Learned list and not matched that way again, though the closeness cut offs never move.
  - `src/lib/nextUp/repeats.ts`
- `roadmap_order` (rule, Content plan roadmap), kept in `learned`. A pick your team skipped, on the roadmap or in Next up, is kept on the Learned list and left out of the next plan's roadmap for 30 days, though the funnel mix and the focus pillars never move by themselves.
  - `src/lib/contentStrategy/roadmap.ts`
- `freshness_clock` (rule, Refresh clock), kept in `refresh_record`. Each article gets a 20, 30 or 45 day clock in turn, and where article refresh is turned on, the refresh records show which clock gains clicks and a person accepts the clock it suggests.
  - `src/lib/content/blog/freshness.ts`
- `competitor_topics` (rule, Competitor topics to add), kept in `brand_map`. A topic a person dismissed from the brand map is marked dismissed and left out of what Next up suggests from competitor articles.
  - `src/lib/competitors/coverage.ts`

### Gap

- `email_hero` (AI purpose, Email hero images), look again by 2027-01-31. Email hero images skip the look learned from your image votes, so a thumbs down never reaches them.
  - `src/app/api/admin/email/image/route.ts`
- `canvas.image_style` (canvas), look again by 2027-01-31. Vizzy suggests an image style without reading the thumbs on the brand's images, and with the agent record on a dismissed suggestion is kept as a record that nothing learns from yet.
  - `src/lib/canvas/kinds/imageStyle.ts`
- `image_style_pick` (rule, Image style used), look again by 2027-01-31. Until a brand picks a style, every image uses a fixed preset for its surface, and thumbs on past images never change which style is used.
  - `src/lib/content/imageStyle/resolve.ts`
- `next_action_order` (rule, Your next action order), look again by 2027-02-26. When Your next action has no card from Vizzy, Home lists the steps of the stage that fits the four answers by a fixed rule, and the outcomes the card now records never change that order.
  - `src/lib/onboarding/homeOrder.ts`
- `spintax_variant` (rule, Recurring post variant), look again by 2027-03-31. A recurring post picks one of its written variants at random each time, and how each variant did is never used to favour the better one.
  - `src/lib/distribute/spintax.ts`
- `brand_strategy` (AI purpose, Proposing the brand strategy), look again by 2027-05-01. The brand strategy keeps each focus star a person kept or removed and each claim they edited, before and after, but nothing learns from them yet.
  - `src/lib/brandStrategy/propose.ts`
- `content_strategy` (AI purpose, Making the content plan), look again by 2027-05-01. The content plan keeps each pillar a person renamed and each slot they split or joined, but naming and grouping the pillars learns nothing from them yet.
  - `src/lib/contentStrategy/make.ts`
  - `src/lib/signals/collect.ts`
- `blog_research` (AI purpose, Blog research), look again by 2027-05-01. Research can read the Learned list through the brand context, but nothing records which facts and sources your team kept or cut.
  - `src/lib/content/blog/research.ts`
- `autopilot_research` (AI purpose, Autopilot research), look again by 2027-05-01. The autopilot's research is never compared with what your team kept in the article, so it cannot learn which sources fit.
  - `src/lib/autopilot/draftSteps.ts`
  - `src/lib/content/blog/research.ts`
- `blog_write` (AI purpose, Writing blog articles), look again by 2027-05-01. Where turned on, an article keeps its AI original and how your team changed it before approving it, but the writer learns nothing from those edits yet.
  - `src/lib/content/create/generateNode.ts`
- `architect` (AI purpose, Laying out workflows), look again by 2027-05-01. Nothing records the pieces your team adds or deletes after a workflow is laid out, so the next layout cannot follow them.
  - `src/lib/content/create/architectRun.ts`
- `content_angle` (AI purpose, Suggesting angles), look again by 2027-05-01. An angle you turn down with Suggest another is passed only to the next try and never kept as a no.
  - `src/lib/content/create/suggestAngle.ts`
- `ebook` (AI purpose, eBooks), look again by 2027-05-01. eBook chapters keep no AI original, so the changes your team makes to them are never compared or learned.
  - `src/app/api/admin/workspace/[workspaceId]/content-plans/[planId]/ebook/chapters/[chapterId]/generate/route.ts`
  - `src/app/api/admin/workspace/[workspaceId]/content-plans/[planId]/ebook/chat/route.ts`
  - `src/app/api/admin/workspace/[workspaceId]/content-plans/[planId]/ebook/toc/route.ts`
- `email_layout` (AI purpose, Email layouts), look again by 2027-05-01. The blocks your team moves, adds or removes after a layout is made are not kept, so the next layout cannot follow them.
  - `src/app/api/admin/workspace/[workspaceId]/content-plans/[planId]/nodes/[nodeId]/layout/route.ts`
- `journeys` (AI purpose, Journeys), look again by 2027-05-01. A journey draft is saved over by your team's edits, so what they changed is never kept or learned.
  - `src/lib/canvas/kinds/journey.ts`
  - `src/lib/canvas/kinds/lifecycle.ts`
  - `src/lib/lifecycle/adminApi.ts`
- `lifecycle_lines` (AI purpose, AI lines in emails), look again by 2027-05-01. Each AI line is approved, swapped for the fallback or skipped, but those decisions never shape the next line.
  - `src/lib/lifecycle/prepare.ts`
- `canvas.journey` (canvas), look again by 2027-05-01. Vizzy's launch email copy gets changed on the canvas before it goes live, and with the agent record on whether a person changed it is kept, but not what they changed, so nothing learns from it yet.
  - `src/lib/canvas/kinds/journey.ts`
- `canvas.lifecycle` (canvas), look again by 2027-05-01. With the agent record on, whether a journey Vizzy drafted gets published, and whether a person changed it first, is kept, but nothing counts it yet, so the next draft cannot get better.
  - `src/lib/canvas/kinds/lifecycle.ts`
- `rising_search` (connector rule), look again by 2027-05-01. A rising search your team plans or dismisses in Review stays away for 30 days, and one proposed as a question on a large brand map never comes back, but neither changes which searches count as rising.
  - `src/lib/connectors/signals/detect.ts`
- `losing_page` (connector rule), look again by 2027-05-01. Pages losing clicks are flagged by fixed cut offs, and what the team did with earlier flags, or whether a refresh won clicks back, never tunes them.
  - `src/lib/connectors/signals/detect.ts`
- `within_reach` (connector rule), look again by 2027-05-01. Questions whose search averages position 5 to 20 on Google are offered by fixed cut offs, and whether an article then moved them up is never looked at.
  - `src/lib/connectors/signals/detect.ts`
- `send_time` (rule, Send time), look again by 2027-05-01. Product journeys send in a weekday morning window unless a person changes it, waitlist journeys send at any time, and opens by hour never move either.
  - `src/lib/lifecycle/sendWindow.ts`
- `journey_shape` (rule, Journey template shape), look again by 2027-05-01. The templates start from default email counts and days between emails that a person or Vizzy can change, and how earlier journeys did never moves those defaults.
  - `src/lib/lifecycle/architect.ts`
- `insight_pick` (rule, Insight an email features), look again by 2027-05-01. Each email features the product's highest weighted insight not used yet, and whether emails with that insight got clicks never changes the pick.
  - `src/lib/lifecycle/recipientContext.ts`
- `notes_rest` (rule, Notes rest), look again by 2027-05-01. A note the team keeps taking out of articles can go straight into the next one, because each removal is kept on that article alone and never makes the note rest.
  - `src/lib/brandNotes/rest.ts`
- `ai_answer_match` (rule, AI answers prompt matched), look again by 2027-05-01. A question is shown the AI answers numbers of the monitored prompt with the same or most of the same words, by a fixed cut off, and the picks your team skips never change which prompt is matched.
  - `src/lib/connectors/signals/aiAnswers.ts`
- `slot_merge` (rule, Questions merged into slots), look again by 2027-05-01. Questions close in meaning are merged into one article at a fixed closeness, and the closeness cut off never moves, though the slots your team splits or joins are kept on the plan.
  - `src/lib/contentStrategy/slots.ts`
- `refresh_share` (rule, Refresh share of Next up), look again by 2027-05-01. At most one of Next up's three picks is a refresh unless the brand sets another number, and whether refreshes or new articles won more clicks never moves it.
  - `src/lib/nextUp/pick.ts`
- `refresh_due` (rule, Refresh due), look again by 2027-05-01. Marking an article checked restarts its clock, but which reasons make articles due early never changes with what your team marks checked.
  - `src/lib/content/blog/freshnessWatch.ts`
- `competitor_claim_match` (rule, Claims competitors now make), look again by 2027-05-01. A claim of yours that a competitor's articles start to make too is never spotted, because checking it honestly needs a meaning check per claim and a cut off that would raise false alarms.
  - `src/lib/competitors/profile.ts`
- `strategy_check` (rule, Weekly strategy check), look again by 2027-05-01. The weekly strategy check keeps each row your team acted on with Propose or dismissed, but how many new articles or names make a row never changes from them yet.
  - `src/lib/brandStrategy/checkRules.ts`
- `investor_quiet` (rule, Investor follow-ups), look again by 2027-05-01. A follow-up comes up after 14 quiet days or a past next step date, and the follow-ups your team dismisses never change that rule.
  - `src/lib/raise/pipeline/due.ts`

### None

- `competitor_site` (AI purpose, Finding a competitor's sitemap). Finding a competitor's sitemap has one right answer, and a person can type the address in when it is wrong.
  - `src/lib/competitors/steps.ts`
- `trending` (AI purpose, Trending topics). It reports what your industry is talking about this week, a fact that changes on its own rather than a taste to learn.
  - `src/lib/agents/trending.ts`
- `enrichment` (AI purpose, Company enrichment). Company details such as size and industry are facts found on the web, and a person corrects a wrong one directly.
  - `src/lib/crm/enrichWorker.ts`
- `fact_check` (AI purpose, Fact checks). A fact check tests each claim against its cited source, and the right answer does not depend on taste.
  - `src/lib/content/blog/hubActions.ts`
- `content_brief` (AI purpose, Writing briefs). A brief is a short instruction a person can rewrite before writing starts, and the piece written from it is what gets judged.
  - `src/lib/content/create/nodeBrief.ts`
- `templates` (AI purpose, Templates). It copies the shape of a piece your team picked into a reusable template, so the choice is already theirs.
  - `src/app/api/admin/workspace/[workspaceId]/idea-items/[ideaId]/templatize/route.ts`
  - `src/app/api/admin/workspace/[workspaceId]/templates/[templateId]/deconstruct/route.ts`
  - `src/app/api/admin/workspace/[workspaceId]/templates/[templateId]/retemplatize/route.ts`
- `brand_voice` (AI purpose, Brand voice). The voice is drafted once from your website and then edited by a person, so no repeated choice exists to learn from.
  - `src/app/api/admin/account/brand/voice/generate/route.ts`
- `brand_kit` (AI purpose, Brand kit). The kit is read from a guidelines PDF, the logo or the site, and colour themes are only offered for a person to pick, so the brand sets it rather than YouGrow choosing again and again.
  - `src/app/api/admin/account/brand/colors/logo/route.ts`
  - `src/app/api/admin/account/brand/colors/theme/route.ts`
  - `src/app/api/admin/account/brand/colors/website/route.ts`
  - `src/app/api/admin/account/brand/extract/palette/route.ts`
  - `src/app/api/admin/account/brand/extract/route.ts`
- `brand_notes` (AI purpose, Brand notes). It splits text a person pasted into separate notes, and that person keeps or drops each one straight away.
  - `src/app/api/admin/brand-kit/notes/extract/route.ts`
- `competitor_analysis` (AI purpose, Competitor analysis). It labels and summarises a competitor's own pages as they are, so there is no taste of yours in it to learn.
  - `src/lib/competitors/steps.ts`
- `competitor_articles` (AI purpose, Competitor articles). It records what each competitor article says and asks, a fact about their page rather than a choice made for you.
  - `src/lib/competitors/articleTick.ts`
- `post_feedback` (AI purpose, Learning from posts). This is the learner that turns post results into writing rules, and it is judged by the posts those rules shape.
  - `src/lib/distribute/feedback/patterns.ts`
- `images` (AI purpose, Images). This is the image style learner itself, and it is judged by the images its learned look shapes.
  - `src/lib/content/create/styleProfile.ts`
- `vizzy_chat` (AI purpose, Vizzy chat). Each chat reply answers what the person just asked, and anything Vizzy saves is judged as the kind of draft it is.
  - `src/app/api/admin/agent/chat/route.ts`
- `product_map` (AI purpose, Learning your product). It reads what your product's code does today, a fact rather than a taste, and a person decides what goes in the catalog.
  - `workers/knowledge-scraper/src/productMap/usage.ts`
- `onboarding` (AI purpose, Getting to know you). It turns what the founder said into the four answers and facts in their own words, and the founder keeps, changes or removes each one before anything is saved.
  - `src/app/api/admin/onboarding/conversations/[id]/end/route.ts`
- `other` (AI purpose, Other). Not a choice: no code spends under this name today, and every new call should name its real purpose.
  - No call site in the code.
- `customize_image` (AI purpose, Customised images). It edits a photo your team supplied the way they asked, and a learned look would restage their real product.
  - `src/app/api/admin/brand-kit/images/[assetId]/customize/route.ts`
- `carousel` (AI purpose, Carousels). Each carousel slide is a picture of the post's own words, so a learned photo look would fight the text it has to show.
  - `src/lib/distribute/carousel/build.ts`
- `get_from_google` (AI purpose, Get from Google). A person asks for this lookup and Google returns its results, so YouGrow makes no choice here to learn.
  - `src/lib/signals/collect.ts`
- `onboarding_voice` (AI purpose, Talk with Vizzy). Vizzy talks with one founder in the moment to cover four questions, and learning from what they said would carry it into calls with other brands.
  - `src/lib/onboarding/voice/calls.ts`
- `canvas.invite_wave` (canvas). A launch sends only a few invite waves, so neither their size nor their copy learns, and a person sets the size and presses Send.
  - `src/lib/canvas/kinds/inviteWave.ts`
- `canvas.content_plan` (canvas). The plan only gathers pieces, and each piece, such as an article or a post, says how it learns under its own kind of writing.
  - `src/lib/canvas/kinds/contentPlan.ts`
- `canvas.email_style` (canvas). A brand sets its email look once and a person saves it, so there is no stream of repeated choices to learn a taste from.
  - `src/lib/canvas/kinds/emailStyle.ts`
- `canvas.journey_style` (canvas). A journey's own email look is a single choice a person saves on that journey, so nothing repeats that could be learned.
  - `src/lib/canvas/kinds/journeyStyle.ts`
- `canvas.person_plan` (canvas). Each plan is about one named person and staff approve it, so learning from it would carry that person's details into plans for others.
  - `src/lib/canvas/kinds/personPlan.ts`
- `canvas.person_fields` (canvas). Each suggestion is a fact about one person that a teammate confirms or dismisses, so it is right or wrong rather than a taste.
  - `src/lib/canvas/kinds/personFields.ts`
- `canvas.new_person` (canvas). Vizzy copies details from the chat into the New person form, and a person checks the facts and records consent, so no taste is involved.
  - `src/lib/canvas/kinds/newPerson.ts`
- `ab_split` (rule, Email test split). The split between versions has to stay a fair, stable coin toss per person, or the test can no longer say which email did better.
  - `src/lib/journey/allocation.ts`
- `journey_next_step` (rule, Journey next step). The next step is the path a person drew on the journey, and the walk follows it rather than picking a branch of its own.
  - `src/lib/lifecycle/planner.ts`
- `autopilot_cadence` (rule, Autopilot cadence). The brand chooses the weekday and how many articles a week, and the autopilot keeps to that pace rather than setting its own.
  - `src/lib/autopilot/tick.ts`
- `found_live` (rule, Approve when found live). An article a person put up on their own site counts as approved by them, which is a fact to record, not a taste to learn.
  - `src/lib/content/blog/foundLive.ts`
- `competitor_coverage` (rule, Competitor coverage flags). The flags compare competitor articles from the last 90 days with the questions the brand has answered, drafted or planned on each subject, plain counts anyone can check, so there is no taste in them.
  - `src/lib/competitors/coverage.ts`
- `competitor_profile` (rule, What competitors write). Each profile counts a watched competitor's articles of the last 90 days by kind, stage, ask and buying situation, which anyone can check against the articles themselves.
  - `src/lib/competitors/profile.ts`
- `pattern_holdout` (rule, Post patterns holdout). A fixed share of posts is written without the learned patterns so their effect can be measured, and that share must not drift with results.
  - `src/lib/distribute/feedback/patterns.ts`
- `waitlist_rank` (rule, Waitlist order). The waitlist order is the rule promised to people who signed up: referrals, any bonus for finishing the voice chat and a teammate's Move up, then sign up time, so it must never shift on its own.
  - `src/lib/waitlist/scoring.ts`
- `auto_plug` (rule, Auto plug comment). The promo comment fires only at the threshold a person set and it posts in public, so it should do exactly what they set.
  - `src/lib/distribute/autoPlug.ts`
- `sidebar_fit` (rule, Sidebar sections that wait). A section waits under Coming up only until the brand puts something in it or opens it early, and from then on it always shows, so the person's own choice is what is kept.
  - `src/lib/onboarding/sidebarFit.ts`
- `waitlist_voice_chat` (model call with no meter, Waitlist voice chat). The voice chat answers one person on a waitlist in the moment, and learning from what they said would carry it into chats with other people.
  - `src/lib/hooks/useLiveConversation.ts`
- `edit_memory` (model call with no meter, Memory Bank memories). This is Memory Bank's own learner, which picks what to remember from each member's edits, and it is judged by the Edit mode changes and the LinkedIn and X drafts those memories shape.
  - `src/lib/agents/memoryBank.ts`
- `search_rerank` (model call with no meter, Search rerank). The ranking model only reorders the same search results by how well each answers the words asked, so it holds no taste of yours to learn.
  - `src/lib/search/rerank.ts`
