# YouGrow

Open-source growth platform: waitlists, lifecycle journeys, content and social
posts, all run with an AI agent. Self-host it on your own Google Cloud.

## Quick start with an AI coding agent

**Claude Code:**

```bash
git clone https://github.com/ygai-jezl/vizzyblmrkt yougrow
cd yougrow
claude "Get YouGrow running on my laptop. Follow AGENTS.md."
```

**Cursor:** clone the repo, open the folder in Cursor, then paste the same
prompt into the chat:

```
Get YouGrow running on my laptop. Follow AGENTS.md.
```

[Open the setup prompt in Cursor](https://cursor.com/link/prompt?text=Get%20YouGrow%20running%20on%20my%20laptop.%20Follow%20AGENTS.md.)

The repo ships an agent kit for Claude Code and Cursor: [AGENTS.md](AGENTS.md), step by step
skills in `.claude/skills/`, and safe defaults that ask before any deploy or cloud change.

## Without an agent

You need Node 24 and Java 21 (the Firebase emulators run on Java).

```bash
npm install
npm run doctor    # checks your machine and says what to fix
npm run local     # runs the app on the local Firebase emulators
```

Open http://localhost:3002 and sign in on the emulator's test page.

## Host it on your own Google Cloud

[docs/self-host.md](docs/self-host.md) takes you from an empty Google Cloud
project to your own running copy. See the plan first (it only reads):

```bash
npm run selfhost -- --project <your-project-id>
```

Or ask your coding agent: `Host YouGrow on my Google Cloud project <id>. Follow docs/self-host.md.`

## How it's built

Next.js 15, React 18, TypeScript, Tailwind and Zod on Firebase App Hosting, with
Firestore, Firebase Auth, Gemini on Vertex AI, a Python ADK agent (Vizzy) on
Agent Runtime, and Vitest for tests.

### The one rule that matters

Never call Firestore directly. Get a tenant context (`resolveTenantFromOrigin`
for public requests, `tenantContextFromClaims` for the admin portal), then:

```ts
import { forTenant } from "@/lib/tenant";

const repo = forTenant(ctx);
const signups = await repo.signups.find({ orderBy: [["createdAt", "desc"]], limit: 50 });
```

`ctx.tenantId` is always derived on the server, never from a request body.
`forTenant(ctx)` also routes each tenant's data to its region's database (US, EU
or Asia). An ESLint rule bans raw Firestore access everywhere else, and the test
suite includes cross-tenant isolation tests.

More detail:
- [Architecture and delivery](docs/ARCHITECTURE-AND-DELIVERY.md) (see §4 for tenant isolation)
- [Decisions](docs/DECISIONS.md)
- [Regional data residency](docs/REGIONAL-DATA-RESIDENCY.md)

## Contributing

Pull requests are welcome. Start with [CONTRIBUTING.md](CONTRIBUTING.md).
[AGENTS.md](AGENTS.md) is the full guide for people and coding agents.

## Security

Please report vulnerabilities privately, not in public issues. See
[SECURITY.md](SECURITY.md).

## Licence

The app is licensed under [AGPL-3.0](LICENSE). The Node SDK in
[sdk/node](sdk/node) is licensed under [MIT](sdk/node/LICENSE).
