import { describe, it, expect } from "vitest";
import { redactSecrets } from "./redact";
import { RepoReader } from "./reader";
import { evidenceKind, verifyEvidence, verifyProductMap } from "./verify";
import { analyseRepo, ANALYSIS_PASSES, GENERAL_PASS, runTool, trimHistory, TOOLS, type Content, type ModelClient, type Part } from "./analyst";
import { parseProductMapLenient } from "./schema";
import { runProductMap } from "./run";
import { scrubCredentials } from "../sources/git";

/**
 * Fake credentials are assembled at runtime so no key-shaped literal is
 * committed to this public repo (secret scanners would flag them).
 */
const fake = {
  stripe: ["sk", "live", "abcdefghijklmnop1234"].join("_"),
  google: "AI" + "za" + "SyA1234567890abcdefghijklmnopqrstuv",
  github: "gh" + "p_" + "abcdefghijklmnopqrstuvwxyz0123456789ab",
  pem: ["-----BEGIN", "PRIVATE KEY-----\nabc\n-----END", "PRIVATE KEY-----"].join(" "),
};

const APP = `export async function onUserCreated(user) {
  await db.collection("users").doc(user.uid).set({ email: user.email, tier: "free", firstSignupDate: now() });
}
export function auditDone(a) {
  return a.status === "completed";
}
`;

function reader(): RepoReader {
  return new RepoReader([
    { repo: "web", path: "src/auth/onUserCreated.ts", text: APP },
    { repo: "web", path: "src/config.ts", text: `const apiKey = "${fake.stripe}";\nconst url = process.env.API_URL;\n` },
    { repo: "web", path: "README.md", text: "# Acme\nShare of voice is how often AI mentions you.\n" },
  ]);
}

describe("redaction", () => {
  it("hides keys, tokens and secret assignments but keeps env lookups readable", () => {
    const out = redactSecrets(
      [
        `const k = "${fake.google}";`,
        `token: '${fake.github}'`,
        'password = "hunter2hunter2"',
        "apiKey: process.env.KEY",
        fake.pem,
      ].join("\n"),
    );
    for (const secret of [fake.google, fake.github, "hunter2", "BEGIN PRIVATE"]) expect(out).not.toContain(secret);
    expect(out).toContain("process.env.KEY");
  });

  it("scrubs credentials out of git error messages", () => {
    expect(scrubCredentials("Command failed: git clone -- https://x-access-token:ghs_secret@github.com/acme/web.git /tmp/x")).toBe(
      "Command failed: git clone -- https://«redacted»@github.com/acme/web.git /tmp/x",
    );
  });
});

describe("repo reader", () => {
  it("lists, searches and reads — always redacted", () => {
    const r = reader();
    expect(r.list("src/**").paths).toEqual(["src/auth/onUserCreated.ts", "src/config.ts"]);
    expect(r.grep("tier").matches[0]).toMatchObject({ path: "src/auth/onUserCreated.ts", line: 2 });
    expect(JSON.stringify(r.grep("apiKey"))).not.toContain(fake.stripe);
    const read = r.read("src/auth/onUserCreated.ts", 4, 6);
    expect("text" in read && read.text).toContain('4: export function auditDone(a) {');
    expect(r.read("nope.ts")).toEqual({ error: "file_not_found" });
  });

  it("refuses catastrophic regexes instead of hanging", () => {
    expect(reader().grep("(a+)+$").error).toBe("invalid_or_unsafe_pattern");
  });
});

describe("evidence verification", () => {
  const r = reader();
  it("accepts an excerpt that is really in the file (whitespace-insensitive, … allowed)", () => {
    expect(verifyEvidence({ path: "src/auth/onUserCreated.ts", excerpt: 'return a.status   === "completed";', verified: false }, r).verified).toBe(true);
    expect(verifyEvidence({ path: "src/auth/onUserCreated.ts", excerpt: 'db.collection("users") … tier: "free"', verified: false }, r).verified).toBe(true);
  });
  it("flags invented excerpts, wrong files and trivially short ones", () => {
    expect(verifyEvidence({ path: "src/auth/onUserCreated.ts", excerpt: "status === 'archived'", verified: false }, r).verified).toBe(false);
    expect(verifyEvidence({ path: "src/missing.ts", excerpt: 'a.status === "completed"', verified: false }, r).verified).toBe(false);
    expect(verifyEvidence({ path: "src/auth/onUserCreated.ts", excerpt: "tier", verified: false }, r).verified).toBe(false);
  });
  it("labels where evidence came from — only source code proves a step, event or fact is built", () => {
    expect(evidenceKind("src/app/api/tenants/create/route.ts")).toBe("source");
    expect(evidenceKind("docs/plans/agency-partnership-program.md")).toBe("docs");
    expect(evidenceKind("README.md")).toBe("docs");
    expect(evidenceKind("src/__tests__/onboarding/brandCta.test.tsx")).toBe("test");
    expect(evidenceKind("app/models_test.go")).toBe("test");

    const rd = new RepoReader([
      { repo: "web", path: "docs/plans/onboarding.md", text: "Step one: create your brand in the wizard." },
      { repo: "web", path: "README.md", text: "Share of voice is how often AI mentions you." },
    ]);
    const { map } = parseProductMapLenient({
      onboardingSteps: [{ id: "create_brand", label: "Create brand", evidence: [{ path: "docs/plans/onboarding.md", excerpt: "create your brand in the wizard" }] }],
      glossary: [{ term: "Share of voice", evidence: [{ path: "README.md", excerpt: "how often AI mentions you" }] }],
    });
    const checked = verifyProductMap(map, rd);
    expect(checked.map.onboardingSteps[0]!.evidence[0]).toMatchObject({ verified: true, kind: "docs" });
    // The plan-backed step doesn't count as proven; the README-backed glossary term does.
    expect(checked.stats).toMatchObject({ items: 2, verifiedItems: 1 });
  });

  it("a model can't mark its own evidence verified", () => {
    const { map } = parseProductMapLenient({
      traits: [{ key: "tier", type: "string", evidence: [{ path: "x.ts", excerpt: "made up entirely", verified: true }] }],
    });
    expect(map.traits[0]!.evidence[0]!.verified).toBe(false);
    const checked = verifyProductMap(map, r);
    expect(checked.stats).toMatchObject({ items: 1, verifiedItems: 0 });
  });
});

/** A scripted model: returns the given turns in order. */
function scripted(turns: Part[][], synthesis: unknown = null): ModelClient & { calls: number; forced: (string | undefined)[]; synth: number } {
  const m = {
    calls: 0,
    synth: 0,
    forced: [] as (string | undefined)[],
    async generate(req: { forceTool?: string; tools: unknown[] }) {
      if (req.tools.length === 0) {
        m.synth += 1;
        return { parts: [{ text: synthesis === null ? "" : JSON.stringify(synthesis) }], usage: { input: 100, output: 10 } };
      }
      m.forced.push(req.forceTool);
      const parts = turns[Math.min(m.calls, turns.length - 1)]!;
      m.calls += 1;
      return { parts, usage: { input: 1000, output: 100 } };
    },
  };
  return m;
}

const GOOD_MAP = {
  summary: "Acme is a web app.",
  traits: [{ key: "tier", type: "string", label: "Plan", evidence: [{ path: "src/auth/onUserCreated.ts", line: 2, excerpt: 'tier: "free"' }] }],
  onboardingSteps: [
    { id: "run_audit", label: "Run an audit", completion: "An audit's status is completed", detection: "server_event", evidence: [{ path: "src/auth/onUserCreated.ts", excerpt: 'return a.status === "completed";' }] },
  ],
  events: [{ name: "Not A Valid Name", evidence: [] }],
};

describe("analysis agent", () => {
  it("has no tool that can change anything", () => {
    expect(TOOLS.map((t) => t.name)).toEqual(["list_files", "search", "read_file", "record_findings", "submit_product_map"]);
    expect(runTool(reader(), "write_file", { path: "x" })).toEqual({ error: "unknown_tool:write_file" });
  });

  it("records findings as it goes, then submits; bad items are dropped, not fatal", async () => {
    const rec = (section: string, items: unknown[]) => ({ functionCall: { name: "record_findings", args: { section, items_json: JSON.stringify(items) } } });
    const model = scripted([
      [{ functionCall: { name: "search", args: { pattern: "tier" } } }],
      [rec("traits", GOOD_MAP.traits), rec("onboardingSteps", GOOD_MAP.onboardingSteps), rec("events", GOOD_MAP.events)],
      [{ functionCall: { name: "submit_product_map", args: { summary: "Acme is a web app.", warnings_json: '["No timezone stored."]' } } }],
    ]);
    const r = await analyseRepo(reader(), model, { repos: ["web"], productName: "Acme", passes: [GENERAL_PASS] });
    expect(r.stats).toMatchObject({ turns: 4, toolCalls: 4, submitted: true }); // + the synthesis turn
    expect(r.map).toMatchObject({ summary: "Acme is a web app.", warnings: ["No timezone stored."] });
    expect(r.map.traits.map((t) => t.key)).toEqual(["tier"]);
    expect(r.map.onboardingSteps[0]).toMatchObject({ id: "run_audit", detection: "server_event" });
    expect(r.dropped).toBe(1); // the invalid event name
  });

  it("never mixes text into a turn of tool results (Gemini rejects it)", async () => {
    let mixed = 0;
    let requests = 0;
    const base = scripted([[{ functionCall: { name: "search", args: { pattern: "tier" }, id: "c" } }]]);
    const model: ModelClient = {
      generate(req) {
        if (req.tools.length) {
          requests += 1;
          for (const c of req.contents) {
            if (c.role === "user" && c.parts.some((p) => p.functionResponse) && c.parts.some((p) => p.text !== undefined)) mixed += 1;
          }
        }
        return base.generate(req);
      },
    };
    // Long enough to trigger a reminder, which must ride INSIDE the tool results.
    await analyseRepo(reader(), model, { repos: ["web"], productName: "Acme", maxTurns: 9, passes: [GENERAL_PASS] });
    expect(requests).toBeGreaterThan(5);
    expect(mixed).toBe(0);
  });

  it("synthesises from a fresh request that quotes what the pass read", async () => {
    let synthesisPrompt = "";
    const base = scripted([[{ functionCall: { name: "search", args: { pattern: "tier" } } }]]);
    const model: ModelClient = {
      generate(req) {
        if (req.tools.length === 0) synthesisPrompt = req.contents.map((c) => c.parts.map((p) => p.text ?? "").join("")).join("");
        return base.generate(req);
      },
    };
    await analyseRepo(reader(), model, { repos: ["web"], productName: "Acme", maxTurns: 3, passes: [GENERAL_PASS] });
    expect(synthesisPrompt).toContain("### search");
    expect(synthesisPrompt).toContain('tier: \\"free\\"'); // the matched line, quoted for exact excerpts
  });

  it("gives the agent a folder overview instead of making it page through files", () => {
    expect(reader().overview()).toBe("./ (1)\nsrc/ (1)\nsrc/auth/ (1)");
  });

  it("runs focused passes in parallel; each may only record its own sections", async () => {
    // Each pass records a trait AND its own section; only the events pass may keep the trait.
    const model: ModelClient = {
      async generate(req) {
        const pass = ANALYSIS_PASSES.find((p) => req.system.includes(p.focus.slice(0, 40)))!;
        const turn = req.contents.filter((c) => c.role === "model").length;
        if (turn === 0) {
          return {
            parts: [
              { functionCall: { name: "record_findings", args: { section: "traits", items_json: JSON.stringify(GOOD_MAP.traits) } } },
              ...(pass.id === "onboarding" ? [{ functionCall: { name: "record_findings", args: { section: "onboardingSteps", items_json: JSON.stringify(GOOD_MAP.onboardingSteps) } } }] : []),
            ],
            usage: { input: 10, output: 1 },
          };
        }
        return { parts: [{ functionCall: { name: "submit_product_map", args: { summary: `from ${pass.id}`, warnings_json: `["${pass.id} warning"]` } } }], usage: { input: 10, output: 1 } };
      },
    };
    const r = await analyseRepo(reader(), model, { repos: ["web"], productName: "Acme" });
    expect(r.map.traits).toHaveLength(1);
    expect(r.map.onboardingSteps.map((x) => x.id)).toEqual(["run_audit"]);
    expect(r.map.summary).toBe("from context"); // only the summary pass sets it
    expect(r.map.warnings).toEqual(["onboarding warning", "events warning", "facts warning", "context warning"]);
    expect(r.stats).toMatchObject({ turns: 12, submitted: true, inputTokens: 120 }); // 2 turns + synthesis, ×4 passes
  });

  it("keeps the other passes' findings when one pass fails", async () => {
    const model: ModelClient = {
      async generate(req) {
        if (req.system.includes(ANALYSIS_PASSES[2]!.focus.slice(0, 40))) throw new Error("model_call_failed:500");
        if (!req.contents.some((c) => c.role === "model")) {
          return { parts: [{ functionCall: { name: "record_findings", args: { section: "traits", items_json: JSON.stringify(GOOD_MAP.traits) } } }], usage: { input: 1, output: 1 } };
        }
        return { parts: [{ functionCall: { name: "submit_product_map", args: { summary: "" } } }], usage: { input: 1, output: 1 } };
      },
    };
    const r = await analyseRepo(reader(), model, { repos: ["web"], productName: "Acme" });
    expect(r.map.traits).toHaveLength(1);
    expect(r.map.warnings).toContain("Part of the analysis failed — try again to fill in the rest.");
    expect(r.stats.submitted).toBe(false);
  });

  it("ends every pass with a tool-free synthesis whose items are recorded", async () => {
    const model = scripted(
      [[{ functionCall: { name: "list_files", args: {} } }], [{ functionCall: { name: "list_files", args: {} } }]],
      { onboardingSteps: GOOD_MAP.onboardingSteps, traits: GOOD_MAP.traits, summary: "From synthesis.", warnings: ["w1"] },
    );
    const r = await analyseRepo(reader(), model, { repos: ["web"], productName: "Acme", maxToolCalls: 2, passes: [GENERAL_PASS] });
    expect(model.synth).toBe(1);
    expect(model.forced).toEqual([undefined, undefined]); // tools are never forced
    expect(r.map.onboardingSteps.map((x) => x.id)).toEqual(["run_audit"]);
    expect(r.map).toMatchObject({ summary: "From synthesis.", warnings: ["w1"] });
    expect(r.stats.submitted).toBe(true);
  });

  it("reminds (never forces) the model to record after several turns of only exploring", async () => {
    const seen: string[] = [];
    const base = scripted([[{ functionCall: { name: "search", args: { pattern: "tier" } } }]]);
    const model: ModelClient = {
      generate(req) {
        const last = req.contents[req.contents.length - 1]!;
        const note = last.parts.find((p) => p.functionResponse?.response.note)?.functionResponse?.response.note;
        if (typeof note === "string") seen.push(note);
        return base.generate(req);
      },
    };
    await analyseRepo(reader(), model, { repos: ["web"], productName: "Acme", maxTurns: 9, passes: [GENERAL_PASS] });
    expect(seen.some((n) => n.startsWith("Reminder: record"))).toBe(true);
    expect(base.forced.every((f) => f === undefined)).toBe(true);
  });

  it("keeps what was recorded even if the model never submits", async () => {
    const model = scripted([
      [{ functionCall: { name: "record_findings", args: { section: "traits", items_json: JSON.stringify(GOOD_MAP.traits) } } }],
      [{ text: "thinking…" }],
    ]);
    const r = await analyseRepo(reader(), model, { repos: ["web"], productName: "Acme", maxTurns: 3, passes: [GENERAL_PASS] });
    expect(r.stats.submitted).toBe(false);
    expect(r.map.traits.map((t) => t.key)).toEqual(["tier"]);
  });

  it("tells the model exactly why an item was rejected, so it can fix it", async () => {
    const model = scripted([
      [{ functionCall: { name: "record_findings", args: { section: "events", items_json: '[{"name":"Bad Name"}]' }, id: "c1" } }],
      [{ functionCall: { name: "submit_product_map", args: { summary: "" } } }],
    ]);
    const seen: Content[][] = [];
    const spy: ModelClient = { generate: (req) => (seen.push(structuredClone(req.contents)), model.generate(req)) };
    await analyseRepo(reader(), spy, { repos: ["web"], productName: "Acme", passes: [GENERAL_PASS] });
    const resp = seen[1]!.at(-1)!.parts[0]!.functionResponse!;
    expect(resp).toMatchObject({ name: "record_findings", id: "c1", response: { recorded: 0, rejected: [{ index: 0 }] } });
  });

  it("trims old tool results but keeps recent ones and every record_findings reply", () => {
    const turn = (name: string): Content[] => [
      { role: "model", parts: [{ functionCall: { name } }] },
      { role: "user", parts: [{ functionResponse: { name, response: { big: "x".repeat(50) } } }] },
    ];
    const contents: Content[] = [{ role: "user", parts: [{ text: "start" }] }, ...turn("search"), ...turn("record_findings"), ...turn("read_file"), ...turn("search")];
    trimHistory(contents, 2);
    const resp = (i: number) => contents[i]!.parts[0]!.functionResponse!.response;
    expect(resp(2)).toMatchObject({ trimmed: true });
    expect(resp(4)).toEqual({ big: "x".repeat(50) }); // record_findings is never trimmed
    expect(resp(8)).toEqual({ big: "x".repeat(50) });
  });
});

/** Minimal Firestore stand-in for one doc. */
function fakeDb(initial: Record<string, unknown>) {
  const doc = { data: { ...initial } as Record<string, unknown> };
  const ref = {
    async get() {
      return { exists: true, data: () => doc.data };
    },
    async update(p: Record<string, unknown>) {
      doc.data = { ...doc.data, ...p };
    },
  };
  return { doc, db: { collection: () => ({ doc: () => ref }) } as never };
}

describe("product-map job", () => {
  const env = { analysisId: "ra_1", tenantId: "ten_A", region: "us" as const, project: "p" };
  const repos = [{ provider: "github", url: "https://github.com/acme/web", ref: "main", label: "web" }];

  it("clones read-only, analyses, verifies and stores the map (never the source)", async () => {
    const { db, doc } = fakeDb({ tenantId: "ten_A", status: "queued", repos, productName: "Acme" });
    const model = scripted([
      [
        { functionCall: { name: "record_findings", args: { section: "traits", items_json: JSON.stringify(GOOD_MAP.traits) } } },
        { functionCall: { name: "record_findings", args: { section: "onboardingSteps", items_json: JSON.stringify(GOOD_MAP.onboardingSteps) } } },
      ],
      [{ functionCall: { name: "submit_product_map", args: { summary: "Acme." } } }],
    ]);
    await runProductMap(env, {
      db,
      model,
      token: async () => "tok",
      collect: async () => ({ files: [{ path: "src/auth/onUserCreated.ts", text: APP, isCode: true, lang: "ts" }], filesProcessed: 1 }),
      now: () => "2026-09-23T00:00:00Z",
      passes: [GENERAL_PASS],
    });
    expect(doc.data).toMatchObject({ status: "done", stats: { files: 1, verifiedItems: 2, submitted: true } });
    expect(JSON.stringify(doc.data)).not.toContain("firstSignupDate: now()"); // only excerpts, not files
  });

  it("refuses another tenant's analysis", async () => {
    const { db } = fakeDb({ tenantId: "ten_B", status: "queued", repos });
    await expect(runProductMap(env, { db })).rejects.toThrow("analysis_tenant_mismatch");
  });

  it("records a scrubbed error when the clone fails", async () => {
    const { db, doc } = fakeDb({ tenantId: "ten_A", status: "queued", repos });
    await expect(
      runProductMap(env, {
        db,
        token: async () => "tok",
        collect: async () => {
          throw new Error("git_failed: fatal: could not read from https://x-access-token:tok@github.com/acme/web");
        },
      }),
    ).rejects.toThrow();
    expect(doc.data.status).toBe("failed");
    expect(String(doc.data.error)).not.toContain("tok@");
  });
});
