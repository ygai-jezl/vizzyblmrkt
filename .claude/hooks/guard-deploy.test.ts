import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { hookResponse, reasonFor, splitCommands } from "./guard-deploy.mjs";

// The PreToolUse hook asks before deploys, cloud changes, pushes and secret reads, naming the
// target; everything else gets no opinion. It must never fail a tool call.

const HOOK = fileURLToPath(new URL("./guard-deploy.mjs", import.meta.url));

/** [command, the text the reason must contain] */
const ASKS: Array<[string, string]> = [
  ["firebase deploy --only apphosting --project my-proj", "project my-proj"],
  ["firebase deploy --only firestore", "the active Firebase project"],
  ["firebase --project=my-proj apphosting:rollouts:create my-backend --git-branch main", "project my-proj"],
  ["firebase apphosting:secrets:set mandrill-api-key -P my-proj", "project my-proj"],
  ["firebase apphosting:secrets:access email-worker-secret --project my-proj", "Prints a secret value"],
  ["npx -y firebase-tools@15.27.0 deploy --only firestore --project my-proj", "project my-proj"],
  ["/usr/local/bin/firebase deploy --project my-proj", "project my-proj"],
  ["gcloud run deploy knowledge-scraper --project my-proj --region us-central1", "project my-proj"],
  ["gcloud --project my-proj services enable firestore.googleapis.com", "project my-proj"],
  ["gcloud scheduler jobs create http tick --project=my-proj --schedule='*/2 * * * *'", "project my-proj"],
  ["gcloud scheduler jobs run lifecycle-tick --location us-central1 --project my-proj", "project my-proj"],
  ["gcloud secrets versions add social-token-enc-key --data-file=- --project my-proj", "project my-proj"],
  ["gcloud secrets versions access latest --secret=email-worker-secret --project my-proj", "Prints a secret value"],
  ["gcloud projects add-iam-policy-binding my-proj --member=user:a@example.com --role=roles/viewer", "project my-proj"],
  ["gcloud storage buckets delete gs://my-proj-yougrow-assets", "the active gcloud project"],
  ["CLOUDSDK_CORE_PROJECT=my-proj gcloud firestore databases create --location=nam5", "project my-proj"],
  ["gcloud config set project my-proj", "later gcloud commands"],
  ["PROJECT=my-proj CANVAS_CALLBACK_URL=https://app.example.com bash agents/root_agent/deploy.sh", "project my-proj"],
  ["set -a; . ./agent.env; set +a; bash agents/root_agent/deploy.sh", "the project in PROJECT"],
  ["export PROJECT=my-proj && bash workers/knowledge-scraper/deploy.sh", "project my-proj"],
  ["bash infra/lifecycle/setup.sh scheduler my-proj", "project my-proj"],
  ["APP_URL=https://app.example.com ./infra/email-worker/setup.sh scheduler my-proj", "project my-proj"],
  ["bash infra/x-oauth/setup.sh secret my-proj", "social-token-enc-key"],
  ["cd infra/x-oauth && ./setup.sh secret my-proj", "social-token-enc-key"],
  ["bash infra/audit-log/setup.sh lock my-proj", "can't be undone"],
  ["node infra/github-app/create-app.mjs --project my-proj --origin https://app.example.com", "project my-proj"],
  ["npm run selfhost -- --project my-proj --apply core --yes", "project my-proj"],
  ["node scripts/selfhost.mjs --project=my-proj --apply=firestore", "project my-proj"],
  ["npx tsx scripts/selfhost/create-workspace.ts --project my-proj --name Acme", "project my-proj"],
  ["GOOGLE_CLOUD_PROJECT=my-proj npx tsx scripts/backfill-audience.ts", "project my-proj"],
  ["terraform apply -auto-approve", "Terraform"],
  ["agents/.venv/bin/adk deploy agent_engine --project=my-proj --region=us-central1 agents/root_agent", "project my-proj"],
  ["gsutil rm -r gs://my-bucket/old", "the active gcloud project"],
  ["bq mk --dataset my-proj:waitlist_us", "the active gcloud project"],
  ["git push origin dev", "remote origin (dev)"],
  ["git push", "the default remote"],
  ["git push --force origin main", "force push"],
  ["git -C sdk/node push -f origin main", "force push"],
  ["git push origin +main", "force push"],
  ["npm publish --access public", "npm registry"],
  ["npm test && firebase deploy --project my-proj", "project my-proj"],
  ["sudo -E timeout 60 firebase deploy --project my-proj", "project my-proj"],
  ["bash -c 'firebase deploy --project my-proj'", "project my-proj"],
  ["sh -c \"cd infra/x-oauth && ./setup.sh secret my-proj\"", "social-token-enc-key"],
  ["echo $(gcloud secrets versions access latest --secret=x --project my-proj)", "Prints a secret value"],
];

const QUIET: string[] = [
  "npm run doctor",
  "npm run doctor -- --cloud --project my-proj",
  "npm run local",
  "npm test",
  "npm run selfhost -- --project my-proj",
  "node scripts/selfhost.mjs --project my-proj --json",
  "npx tsx scripts/selfhost/create-workspace.ts --project my-proj --list",
  "firebase --version",
  "firebase apphosting:backends:list --project my-proj",
  "firebase apphosting:secrets:describe mandrill-api-key --project my-proj",
  "firebase emulators:exec --project demo-yougrow 'bash scripts/smoke.sh'",
  "firebase use my-proj",
  "gcloud projects describe my-proj",
  "gcloud --project my-proj run services list",
  "gcloud services list --enabled --project my-proj",
  "gcloud secrets list --project my-proj",
  "gcloud secrets get-iam-policy email-worker-secret --project my-proj",
  "gcloud auth application-default login",
  "gcloud firestore databases describe --database='(default)' --project my-proj",
  "gcloud scheduler jobs list --location us-central1 --project my-proj",
  "bash infra/lifecycle/setup.sh verify my-proj",
  "bash infra/bigquery-analytics/setup.sh validate my-proj",
  "bash infra/x-oauth/setup.sh",
  "PROJECT=my-proj bash agents/root_agent/deploy.sh --dry-run",
  "node infra/github-app/create-app.mjs --project my-proj --origin https://app.example.com --dry-run",
  "cd agents/root_agent && ../.venv/bin/python -m pytest tests/ -q",
  "git status",
  "git push --dry-run origin dev",
  "git commit -m 'docs: how firebase deploy works'",
  "echo \"firebase deploy --project my-proj\"",
  "grep -rn 'gcloud run deploy' docs",
  "gsutil ls gs://my-bucket",
  "bq ls --project_id my-proj",
  "terraform plan",
  "ls -la 2>&1 | head",
  "# firebase deploy --project my-proj",
  "",
];

describe("reasonFor", () => {
  it.each(ASKS)("asks before %s", (command, expected) => {
    const reason = reasonFor(command);
    expect(reason, command).not.toBeNull();
    expect(reason!.toLowerCase()).toContain(expected.toLowerCase());
  });

  it.each(QUIET)("has no opinion on %s", (command) => {
    expect(reasonFor(command)).toBeNull();
  });

  it("writes the reason without long dashes", () => {
    for (const [command] of ASKS) expect(reasonFor(command)).not.toMatch(/[\u2013\u2014]/);
  });

  it("keeps a long command short in the reason", () => {
    const reason = reasonFor(`firebase deploy --project my-proj --message ${"x".repeat(500)}`)!;
    expect(reason.length).toBeLessThan(400);
  });
});

describe("splitCommands", () => {
  it("splits on separators and reads quotes and nested commands", () => {
    expect(splitCommands("a 'b c' && d \"e $(f g)\" | h; i 2>&1")).toEqual([["a", "b c"], ["f", "g"], ["d", "e "], ["h"], ["i", "2>&1"]]);
  });

  it("survives unbalanced quotes and deep nesting", () => {
    expect(() => splitCommands(`echo "unclosed $(a 'b`)).not.toThrow();
    expect(() => splitCommands("$(".repeat(5000))).not.toThrow();
  });
});

describe("hookResponse", () => {
  it("answers ask in the PreToolUse shape, naming the project", () => {
    const out = hookResponse({ tool_name: "Bash", tool_input: { command: "firebase deploy --only apphosting --project my-proj" } });
    expect(out?.hookSpecificOutput.hookEventName).toBe("PreToolUse");
    expect(out?.hookSpecificOutput.permissionDecision).toBe("ask");
    expect(out?.hookSpecificOutput.permissionDecisionReason).toContain("my-proj");
  });

  it("reads Cursor's Shell tool and a top-level command too", () => {
    expect(hookResponse({ tool_name: "Shell", tool_input: { command: "git push origin dev" } })).not.toBeNull();
    expect(hookResponse({ command: "git push origin dev" })).not.toBeNull();
  });

  it.each([null, undefined, 42, "text", [], {}, { tool_name: "Read", tool_input: { command: "firebase deploy" } }, { tool_input: { command: 7 } }, { tool_input: null }])(
    "has no opinion on odd input %#",
    (input) => {
      expect(hookResponse(input)).toBeNull();
    },
  );
});

describe("run as a hook", () => {
  const run = (stdin: string) => spawnSync(process.execPath, [HOOK], { input: stdin, encoding: "utf8", timeout: 10000 });

  it("prints the ask decision for a deploy", () => {
    const r = run(JSON.stringify({ tool_name: "Bash", tool_input: { command: "firebase deploy --only apphosting --project my-proj" } }));
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.hookSpecificOutput.permissionDecision).toBe("ask");
    expect(out.hookSpecificOutput.permissionDecisionReason).toContain("my-proj");
  });

  it.each(['{"tool_name":"Bash","tool_input":{"command":"npm test"}}', "not json", "", "{", "null", "[1,2]", '{"tool_input":{"command":{"x":1}}}'])(
    "prints nothing and exits 0 for %j",
    (stdin) => {
      const r = run(stdin);
      expect(r.status).toBe(0);
      expect(r.stdout).toBe("");
    },
  );
});
