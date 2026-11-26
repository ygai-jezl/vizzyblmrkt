import type { TenantContext } from "@/lib/tenant/types";
import type { WorkDeps } from "@/lib/work/scope";
import { workScopeFor } from "@/lib/work/scope";
import { proposeWorkSuggestion } from "@/lib/work/suggestions";
import type { SuggestedTask } from "@/lib/work/suggestion";
import { SEED_TENANT_ID } from "./seedDemo";

/**
 * Three made-up Work suggestions for the demo brand (Acme), as Vizzy would make them in chat, so a
 * local run (which turns every switch on, WORK_ENABLED among them) has Tasks Vizzy suggests in
 * Review to add, edit then add, and dismiss. Vizzy itself isn't deployed locally. Made by the demo
 * admin, through the same service Vizzy's tool uses; idempotent, since a suggestion made again
 * answers open or decided and writes nothing.
 */
export const SEED_WORK_SUGGESTIONS: SuggestedTask[] = [
  {
    title: "Publish a getting started guide",
    description: "One page that takes a new team from sign up to their first project, with the three questions people ask most.",
    stage: "market",
    brandId: SEED_TENANT_ID,
    typedLinks: [],
    measure: { kind: "moves", meaning: "searchClicks", look: { days: 28 } },
    proposed: { kind: "moves", reason: "It answers a question people search for." },
    from: "from your numbers",
    why: "People search for how to start with Acme, and no page of yours answers it yet.",
  },
  {
    title: "Check the welcome email reaches new sign ups",
    description: "Sign up with a test address after tonight's runs, and log whether the welcome email came.",
    stage: "build",
    brandId: SEED_TENANT_ID,
    typedLinks: [],
    measure: { kind: "runs_better", what: "errors", look: { days: 7 } },
    proposed: { kind: "runs_better", reason: "It checks that something runs as it should." },
    from: "from today's log",
    why: "You logged the welcome email as waiting on tonight's runs.",
  },
  {
    title: "Register Acme for VAT",
    description: "",
    stage: "billing_tax",
    brandId: SEED_TENANT_ID,
    typedLinks: [],
    measure: { kind: "done" },
    proposed: { kind: "done", reason: "Billing and tax work is finished once it is done." },
    from: "as the next step for Billing and tax",
    why: "Nothing on your list covers VAT yet.",
  },
];

/** Make the demo suggestions as the demo admin. Answers how many are waiting in Review. */
export async function seedWorkSuggestions(adminUid: string, deps: WorkDeps = {}): Promise<number> {
  const ctx: TenantContext = { tenantId: SEED_TENANT_ID, region: "us", source: "system", userId: adminUid, role: "admin" };
  const scope = await workScopeFor(ctx, deps);
  if (!scope.ok) return 0;
  let open = 0;
  for (const task of SEED_WORK_SUGGESTIONS) {
    const r = await proposeWorkSuggestion(scope.scope, { task, evidence: [] }, deps);
    if (r.ok && (r.value.outcome === "created" || r.value.outcome === "open")) open += 1;
  }
  return open;
}
