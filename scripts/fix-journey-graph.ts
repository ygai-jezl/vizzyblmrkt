/**
 * fix-journey-graph.ts — repair the condition dead-end bug in the two live prod
 * journeys: rewrite each condition branch to its intended MULTI-FACTOR rule set
 * (valid catalog field keys) and wire a "default" else-edge on every condition
 * node so no recipient can silently dead-end.
 *
 * READ-ONLY by default (prints a diff). Pass --apply to write.
 *
 *   GOOGLE_CLOUD_PROJECT=vizzybl-marketing-prod npx tsx scripts/fix-journey-graph.ts            # dry-run, both
 *   GOOGLE_CLOUD_PROJECT=vizzybl-marketing-prod npx tsx scripts/fix-journey-graph.ts vizzybl-beta-2 --apply
 *
 * Auth = Application Default Credentials (`gcloud auth application-default login`).
 */

// Never touch a local emulator (a dev shell may export these).
delete process.env.FIRESTORE_EMULATOR_HOST;
delete process.env.FIREBASE_AUTH_EMULATOR_HOST;

import { forTenant } from "@/lib/tenant";
import type { TenantContext } from "@/lib/tenant/types";
import type { JourneyCondition } from "@/lib/types/journey";
import { fixJourneyGraph, type BranchRule, type FixOptions } from "@/lib/journey/graphFix";

// --- intended branch semantics (now expressible as multi-factor AND rules) ----
const cond = (
  field: JourneyCondition["field"],
  operator: JourneyCondition["operator"],
  value?: number | string | boolean,
): JourneyCondition => ({ field, operator, ...(value !== undefined ? { value } : {}) });

const VC_NO_REF: BranchRule = { match: "all", conditions: [cond("usedVoiceChat", "is_true"), cond("referralCount", "eq", 0)] };
const REF_NO_VC: BranchRule = { match: "all", conditions: [cond("usedVoiceChat", "is_false"), cond("referralCount", "gte", 1), cond("referralCount", "lte", 2)] };
const VC_AND_REF: BranchRule = { match: "all", conditions: [cond("usedVoiceChat", "is_true"), cond("referralCount", "gte", 1), cond("referralCount", "lte", 2)] };
const VC_AND_REF3: BranchRule = { match: "all", conditions: [cond("usedVoiceChat", "is_true"), cond("referralCount", "gte", 3)] };
const NO_VC_NO_REF: BranchRule = { match: "all", conditions: [cond("usedVoiceChat", "is_false"), cond("referralCount", "eq", 0)] };

interface Target {
  campaignId: string;
  journeyId: string;
  ctx: TenantContext;
  opts: FixOptions;
}

// US — journey_vizzybl-beta-2: 3 condition tiers, branch ids suffixed _1/_2/_3.
const usBranchRules: Record<string, BranchRule> = {};
const usDefaultTargets: Record<string, string> = {};
for (const s of [1, 2, 3] as const) {
  usBranchRules[`vc_no_ref_${s}`] = VC_NO_REF;
  usBranchRules[`ref_no_vc_${s}`] = REF_NO_VC;
  usBranchRules[`vc_and_ref_${s}`] = VC_AND_REF;
  usBranchRules[`vc_and_ref3_${s}`] = VC_AND_REF3;
  usBranchRules[`no_vc_no_ref_${s}`] = NO_VC_NO_REF;
  usDefaultTargets[`condition-${s}`] = `email-none-${s}`;
}

// EU — journey_agentic-growth-loop: 2 condition tiers, suffix "" and "_2".
const euBranchRules: Record<string, BranchRule> = {};
const euDefaultTargets: Record<string, string> = {};
for (const s of ["", "_2"] as const) {
  euBranchRules[`voice_no_ref${s}`] = VC_NO_REF;
  euBranchRules[`ref_no_voice${s}`] = REF_NO_VC;
  euBranchRules[`voice_ref${s}`] = VC_AND_REF;
  euBranchRules[`voice_ref_high${s}`] = VC_AND_REF3;
  euBranchRules[`none${s}`] = NO_VC_NO_REF;
}
euDefaultTargets["condition_1"] = "email_1e";
euDefaultTargets["condition_2"] = "email_2e";

const TARGETS: Target[] = [
  {
    campaignId: "vizzybl-beta-2",
    journeyId: "journey_vizzybl-beta-2",
    ctx: { tenantId: "ten_vzb", region: "us", source: "system" },
    opts: { branchRules: usBranchRules, defaultTargets: usDefaultTargets },
  },
  {
    campaignId: "agentic-growth-loop",
    journeyId: "journey_agentic-growth-loop",
    ctx: { tenantId: "ten_yougrow-ai", region: "eu", source: "system" },
    opts: { branchRules: euBranchRules, defaultTargets: euDefaultTargets },
  },
];

async function main() {
  const project = process.env.GOOGLE_CLOUD_PROJECT;
  if (!project) {
    console.error("Set GOOGLE_CLOUD_PROJECT=vizzybl-marketing-prod");
    process.exit(1);
  }
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const only = args.find((a) => !a.startsWith("--"));
  const targets = only ? TARGETS.filter((t) => t.campaignId === only) : TARGETS;
  if (targets.length === 0) {
    console.error(`No target matches "${only}". Known: ${TARGETS.map((t) => t.campaignId).join(", ")}`);
    process.exit(1);
  }

  console.log(`Project ${project} — ${apply ? "APPLY (writing)" : "DRY-RUN (no writes)"}\n`);

  for (const t of targets) {
    console.log(`=== ${t.campaignId} (${t.ctx.tenantId}/${t.ctx.region}) ===`);
    const journey = await forTenant(t.ctx).journeys.getById(t.journeyId);
    if (!journey) {
      console.log(`  ! journey ${t.journeyId} not found — skipping`);
      continue;
    }
    const { graph, changes } = fixJourneyGraph(journey.graph, t.opts);
    if (changes.length === 0) {
      console.log("  ✓ already fixed — no changes.");
      continue;
    }
    for (const c of changes) {
      if (c.kind === "branch_rewritten") {
        console.log(
          `  • branch ${c.branchId} → match:${c.after.match ?? "all"} ${c.after.conditions
            .map((r) => `${r.field} ${r.operator}${r.value !== undefined ? " " + r.value : ""}`)
            .join(" / ")}`,
        );
      } else if (c.kind === "default_edge_added") {
        console.log(`  • default edge on ${c.nodeId} → ${c.target} (${c.edgeId})`);
      } else {
        console.log(`  ! WARNING ${c.nodeId}${c.branchId ? "/" + c.branchId : ""}: ${c.message}`);
      }
    }
    if (apply) {
      await forTenant(t.ctx).journeys.update(t.journeyId, {
        graph,
        updatedAt: new Date().toISOString(),
      });
      console.log(`  ✓ applied (${changes.length} change(s) written).`);
    } else {
      console.log(`  (dry-run: ${changes.length} change(s) NOT written — pass --apply)`);
    }
    console.log("");
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
