---
name: add-a-connector
description: Add a YouGrow data connector the one way every connector is added. Choose how it connects (the vendor's own MCP server first, else an API token, else OAuth), write its data only manifest, give every number a meaning, declare its uses, say what it shares in plain words, add its mark, its learning registry lines, its help words, a check:instance allow entry when its host needs one, and the tests. Use it whenever someone wants to connect a new tool or vendor, add or change a stream, or change what a connector reads.
---

# Add a connector

Connectors are data (ADR-0019 in `docs/DECISIONS.md`). Every connector is one manifest in
`src/lib/connectors/manifests/`, checked by `src/lib/connectors/manifest.ts`, and features read
kinds of data through `readByUse` (`src/lib/connectors/byUse.ts`), never a vendor. Work through
the list in order, behind a switch, as one pull request against `dev`. Read ADR-0011, ADR-0012
and ADR-0019 first if you haven't.

## 1. Choose how it connects

In this order:

1. **MCP**, when the vendor runs a remote MCP server over Streamable HTTP. The connector is data
   only: `connect: [{ method: "mcp", ... }]`, and the one engine in `src/lib/connectors/mcp/` runs
   every stream from the manifest. You write no handler code. A key is pasted as one sealed field
   (`auth.kind: "bearer"`). OAuth to an MCP server isn't built yet: use a key.
2. **API token** (`token_fields`), when there is no MCP server. Its code is hooks in
   `src/lib/connectors/handlers/<connector>.ts`, named `<connector>.<name>` and listed in
   `src/lib/connectors/handlers/index.ts`. Calls go through `connectorFetch` only.
3. **OAuth** (`oauth_pkce`, Google only today) or share access (Google only).

## 2. Read the vendor's tools first

Take tool names, argument names and result shapes from the vendor's own docs or its `tools/list`,
never from a guess. Write down which tools only read. A connector only reads: never call a tool
that writes, sends anything or spends the brand's credits, and say so in a `never` shares line.

## 3. Write the manifest

`src/lib/connectors/manifests/<id>.ts`, added to `MANIFESTS` in
`src/lib/connectors/manifests/index.ts`. Pure data: no functions, no imports beyond types. An MCP
connector, with a made-up vendor:

```ts
connect: [{
  method: "mcp",
  url: "https://mcp.acme.example/v1/mcp",           // its host goes in api.hosts
  auth: { kind: "bearer", field: { key: "apiKey", label: "API key", secret: true, pattern: "^acme_[A-Za-z0-9]+$", minLength: 20, maxLength: 200 } },
  verify: { tool: "who_am_i", account: "site", label: "name" }, // the account the key reads
  permissions: ["read:stats"],                       // each needs a shares line
  steps: ["In Acme, open Settings, then API Keys.", "Make a key that can only read, then paste it here."],
}],
verify: { method: "POST", url: "https://mcp.acme.example/v1/mcp", hook: "mcp.verify" },
hooks: { live: "mcp.live", collect: "mcp.collect" }, // collect only with a collected stream
produces: [{
  stream: "daily", keys: ["day"], measures: ["acmeVisits"], joins: { day: "day" }, liveBy: ["day"], /* ... */
  mcp: {
    tool: "history",
    args: { status: "active" },                        // fixed arguments
    fill: { startDate: "from", endDate: "to", limit: "limit" }, // filled on each read
    rows: "data", more: "pagination.hasMore",          // paths into the result
    keys: { day: "date" }, measures: { acmeVisits: "visits" },
  },
}],
```

- Paths are names joined by dots, or `$` for the value itself. A number's path that names a list
  counts its items. Fills: `from`, `to`, `limit`, `account`, `page` and `pageUrl`; a stream whose
  call takes a page lists `page` in `liveFilters` and is read for one page only.
- An MCP stream is collected by day only, one row of totals a day, and at most one stream is
  collected. A day the tool doesn't list is kept with no numbers, never as zero.
- The schema refuses an MCP connector with hooks of its own, a server off its hosts, a stream with
  no `mcp` block, or a key or number with no place in a row.

## 4. Every number a meaning

Each measure is a key in `src/lib/metrics/meanings.ts`, namespaced by what it is (`cfVisits`,
`aiShareOfVoice`), in its group, with a plain definition, grain, unit and source. A number that
isn't a count (a share, a rank, a score) says so in its unit, so collected totals never add it up.
Each new meaning is claimed by an ontology type in `src/lib/ontology/registry.ts`:
`data_connection` for live reads (`read_connected_live`), `metric_snapshot` too for a collected
one (`get_connected_numbers`).

## 5. Its uses

`uses` names the kinds of data it gives, from `USES` in `src/lib/connectors/manifest.ts`
(`vizzy.read`, `signals.search`, `signals.traffic`, `signals.bots`, `signals.ai_answers`). A
feature asks `readByUse(ctx, use, { measures, by, period })` and gets rows by shared key and
meaning, from connections that feed planning only. Add a use when a new kind of data needs one;
never import a manifest into a feature.

## 6. What it shares, in plain words

Every permission or scope has a shares line naming it in `needs`, and at least one `never` line
says what it never reads or writes. The words follow `src/lib/content/writingRules.ts`: no em
dashes, en dashes or spaced hyphens as punctuation, none of the `AI_TELLS`. The manifest test
checks every string.

## 7. Its switch

Use the `add-a-switch` skill. `CONNECTOR_<NAME>_ENABLED`, read in `src/lib/connectors/flags.ts`
(the core and its own switch), listed in `CONNECTOR_SWITCHES` in
`src/lib/connectors/registry.ts`, off in `apphosting.yaml`'s Connectors group, empty in
`.env.example`, and in `KEPT_OFF` in `scripts/selfhost/spec.mjs`. An MCP connector is offered
only while `CONNECTOR_MCP_ENABLED` is on too: the registry checks it for the method.

## 8. Its mark

A square svg or png in `public/marks/connectors/<id>/`, named by the manifest's `icon` with its
owner, and a row in `public/marks/NOTICE.md` with its owner, source and SHA-256.
`src/lib/connectors/marks.test.ts` checks the file is there, safe, listed and unchanged, and the
owner is one it knows. Without a mark the screens show two letters (`initials`).

## 9. The learning registry

A connector that only reads numbers adds no line. A rule that picks something from its numbers
(a detection rule, a match) gets a `RULE_DECISIONS` entry and its line in
`src/lib/loops/registry.ts` (`gap`, `none` or `own`, with a plain reason, as the
`build-a-feature` skill says), and its key in the `madeBy` of the ontology type that keeps what
it makes.

## 10. Its help words

`src/components/help/pages/connected-data.tsx` renders every manifest's steps, shares, numbers
and Disconnect words through `src/lib/connectors/helpText.ts`, so check they read well there. Add
what the page writes by hand: a Before you start line, and any message of the tool's own in If you
see this. `src/lib/help/help.test.ts` checks quoted messages are the app's.

## 11. check:instance

If the vendor's host is one of the names `scripts/lib/instance-values.mjs` lists, add one entry
for the manifest file to `scripts/instance-values.allow`, with the reason "a vendor connector's
own API host". Tests are allowed already. No other file names the host: read it from the manifest.

## 12. Tests

- A test file beside the manifest: it parses, its server's host is in `api.hosts`, every number
  has a meaning, and it calls no tool that writes or spends.
- The engine against a fake MCP server (`fakeMcpServer` in
  `src/lib/connectors/testing/mcpServer.ts`), answering as the vendor's server does: verify, each
  stream live, the collected stream, a refused key (401) and a bad path.
- Connect through `connect()` in `src/lib/connectors/service.ts` with the fake server, and
  `readByUse` when it declares a `signals.*` use.
- Made-up brands, sites and numbers only (`example.com`, `.example`, `.test`).

## 13. Finish

Run `npm run ontology:doc` as the last commit, then use the `check-my-change` skill.
