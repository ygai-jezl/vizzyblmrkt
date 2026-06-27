/**
 * recover-journey-deadends.ts — re-enqueue recipients who silently dead-ended at
 * a journey condition node (the invalid-field / missing-default-edge bug). MUST
 * be run AFTER scripts/fix-journey-graph.ts --apply (it routes on the FIXED graph).
 *
 * READ-ONLY by default (prints decisions). --apply enqueues. --drain also kicks
 * the worker once (otherwise the 2-min prod cron drains the new jobs).
 *
 *   GOOGLE_CLOUD_PROJECT=vizzybl-marketing-prod npx tsx scripts/recover-journey-deadends.ts            # dry-run, both
 *   GOOGLE_CLOUD_PROJECT=vizzybl-marketing-prod npx tsx scripts/recover-journey-deadends.ts vizzybl-beta-2 --apply --drain
 *
 * Auth = Application Default Credentials (`gcloud auth application-default login`).
 */

delete process.env.FIRESTORE_EMULATOR_HOST;
delete process.env.FIREBASE_AUTH_EMULATOR_HOST;

import type { TenantContext } from "@/lib/tenant/types";
import { recoverDeadEnds } from "@/lib/journey/recover";
import { processEmailJobs } from "@/lib/email/delivery";

interface Target {
  campaignId: string;
  journeyId: string;
  ctx: TenantContext;
}

const TARGETS: Target[] = [
  { campaignId: "vizzybl-beta-2", journeyId: "journey_vizzybl-beta-2", ctx: { tenantId: "ten_vzb", region: "us", source: "system" } },
  { campaignId: "agentic-growth-loop", journeyId: "journey_agentic-growth-loop", ctx: { tenantId: "ten_yougrow-ai", region: "eu", source: "system" } },
];

async function main() {
  const project = process.env.GOOGLE_CLOUD_PROJECT;
  if (!project) {
    console.error("Set GOOGLE_CLOUD_PROJECT=vizzybl-marketing-prod");
    process.exit(1);
  }
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const drain = args.includes("--drain");
  const only = args.find((a) => !a.startsWith("--"));
  const targets = only ? TARGETS.filter((t) => t.campaignId === only) : TARGETS;
  if (targets.length === 0) {
    console.error(`No target matches "${only}". Known: ${TARGETS.map((t) => t.campaignId).join(", ")}`);
    process.exit(1);
  }

  console.log(`Project ${project} — ${apply ? "APPLY (enqueuing)" : "DRY-RUN (no writes)"}\n`);

  for (const t of targets) {
    console.log(`=== ${t.campaignId} (${t.ctx.tenantId}/${t.ctx.region}) ===`);
    const res = await recoverDeadEnds(t.ctx, t.campaignId, t.journeyId, { apply });
    if (res.status !== "active") {
      console.log(`  journey status: ${res.status} — nothing to do.`);
      console.log("");
      continue;
    }
    console.log(`  stranded condition jobs found: ${res.strandedFound}`);
    const tally: Record<string, number> = {};
    for (const it of res.items) {
      tally[it.decision] = (tally[it.decision] ?? 0) + 1;
      console.log(
        `  • ${it.signupId} @ ${it.nodeId} → ${it.decision}` +
          (it.handle ? ` [handle ${it.handle} → ${it.nextNodeId}]` : ""),
      );
    }
    console.log(`  summary: ${Object.entries(tally).map(([k, v]) => `${k}=${v}`).join(", ") || "none"}`);

    if (apply && drain) {
      const r = await processEmailJobs(t.ctx);
      console.log(`  drained worker: processed=${r.processed} done=${r.done} failed=${r.failed}`);
    }
    console.log("");
  }
  if (!apply) console.log("(dry-run — pass --apply to enqueue, optionally --drain to send immediately)");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
