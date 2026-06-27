/**
 * diagnose-journey.ts — READ-ONLY diagnostic for the email-journey delivery
 * chain. Answers: "why did recipient X get journey email #1 but not #2?".
 *
 * Usage:
 *   npx tsx scripts/diagnose-journey.ts <email> [projectId]
 *
 * With no projectId it scans BOTH 'vizzybl-marketing-dev' and
 * 'vizzybl-marketing-prod'. Authentication is Application Default Credentials
 * (`gcloud auth application-default login`); no key files.
 *
 * SAFETY: this tool is STRICTLY read-only. It only ever calls .get(). It never
 * mutates Firestore (no set/update/delete/add/create/batch/runTransaction). It
 * also DEFENSIVELY clears the emulator env vars so it can never accidentally hit
 * a local emulator and report empty data as "no signup".
 *
 * It is deliberately STANDALONE — it imports nothing from src/ (several src
 * modules read env on import / wire the tenant repository to one project). It
 * inlines the few constants it must mirror from the app's data layer, with the
 * source files noted inline so the two stay in sync:
 *   - region -> databaseId map        (src/lib/tenant/region.ts)
 *   - normalizeEmail (trim+lowercase) (src/lib/waitlist/identifiers.ts)
 *   - resolveNextStep / firstStep     (src/lib/email/delivery.ts)
 *   - dedupeKey + journeyId shapes    (src/lib/email/delivery.ts, jobs.ts)
 *   - collection names + doc shapes   (src/lib/tenant/repository.ts, types/*)
 */

// --- DEFENSIVE: never touch a local emulator (requirement #2) ----------------
// Must happen before firebase-admin is initialised. If either of these is set
// (e.g. inherited from a dev shell) the admin SDK silently routes at the
// emulator, where a deployed backend's data does NOT exist — the tool would
// then falsely report "no signup found".
delete process.env.FIRESTORE_EMULATOR_HOST;
delete process.env.FIREBASE_AUTH_EMULATOR_HOST;

import { Firestore, type DocumentData } from "@google-cloud/firestore";
import { OAuth2Client } from "google-auth-library";
import { execSync } from "node:child_process";

// This org's ADC is RAPT-blocked for non-interactive use (invalid_rapt), but the
// gcloud CLI credential is valid. Build an OAuth client from the CLI access token
// (fetched once) and hand it to @google-cloud/firestore. firebase-admin's Firestore
// rejects a bare-token credential ("must use cert or ADC"); the underlying
// @google-cloud/firestore accepts an explicit authClient. READ-ONLY: only .get().
let _authClient: OAuth2Client | null = null;
function tokenAuthClient(): OAuth2Client {
  if (!_authClient) {
    const token = execSync("gcloud auth print-access-token", {
      encoding: "utf8",
    }).trim();
    _authClient = new OAuth2Client();
    _authClient.setCredentials({ access_token: token });
  }
  return _authClient;
}

// --- Inlined from src/lib/tenant/region.ts -----------------------------------
// The (default) database is BOTH the control plane (tenants registry) and the
// US data plane. Keep this in lockstep with REGION_CONFIGS.
const DEFAULT_DATABASE_ID = "(default)";
const REGION_TO_DB: Record<string, string> = {
  us: DEFAULT_DATABASE_ID,
  eu: "signups-eu",
  asia: "signups-asia",
};

// --- Inlined from src/lib/waitlist/identifiers.ts ----------------------------
// We do NOT strip Gmail dots/plus — matches the app exactly.
function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

// --- Minimal structural mirrors of the journey graph types -------------------
// (src/lib/types/journey.ts). Only the fields the simulator/printer reads.
type NodeType = "trigger" | "email" | "wait" | "condition";
interface GraphNode {
  id: string;
  type: NodeType;
  data?: {
    label?: string;
    subject?: string;
    body?: string;
    waitHours?: number;
    branches?: Array<{ id: string; label?: string; condition?: unknown }>;
  };
}
interface GraphEdge {
  id: string;
  source: string;
  target: string;
  sourceHandle?: string | null;
}
interface JourneyGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

const DEFAULT_PROJECTS = ["vizzybl-marketing-dev", "vizzybl-marketing-prod"];

// =============================================================================
// Journey-graph simulation — replicated from src/lib/email/delivery.ts so the
// expected chain (and each step's dedupeKey) can be derived WITHOUT running the
// worker. resolveNextStep + firstStep + findEntryNode kept byte-for-byte in
// logic; only typed against the local mirror.
// =============================================================================

type NextStepType = "email" | "condition";

/** src/lib/email/delivery.ts:findEntryNode */
function findEntryNode(graph: JourneyGraph): GraphNode | null {
  const trigger = graph.nodes.find((n) => n.type === "trigger");
  if (trigger) return trigger;
  const hasIncoming = new Set(graph.edges.map((e) => e.target));
  return graph.nodes.find((n) => !hasIncoming.has(n.id)) ?? null;
}

/** src/lib/email/delivery.ts:resolveNextStep */
function resolveNextStep(
  graph: JourneyGraph,
  fromNodeId: string,
  branchHandle?: string,
): { nodeId: string; delayHours: number; type: NextStepType } | null {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const pick = (id: string, handle?: string) => {
    const outs = graph.edges.filter((e) => e.source === id);
    return handle
      ? outs.find((e) => (e.sourceHandle ?? null) === handle)
      : outs[0];
  };

  let current = fromNodeId;
  let delayHours = 0;
  let handle = branchHandle;
  const seen = new Set<string>([fromNodeId]);

  for (let i = 0; i <= graph.nodes.length; i += 1) {
    const nextId = pick(current, handle)?.target;
    handle = undefined;
    if (!nextId || seen.has(nextId)) return null;
    seen.add(nextId);
    const node = byId.get(nextId);
    if (!node) return null;
    if (node.type === "email") return { nodeId: nextId, delayHours, type: "email" };
    if (node.type === "condition")
      return { nodeId: nextId, delayHours, type: "condition" };
    if (node.type === "wait") delayHours += node.data?.waitHours ?? 0;
    current = nextId;
  }
  return null;
}

/** src/lib/email/delivery.ts:firstStep */
function firstStep(
  graph: JourneyGraph,
): { nodeId: string; delayHours: number } | null {
  const entry = findEntryNode(graph);
  if (!entry) return null;
  return entry.type === "email" || entry.type === "condition"
    ? { nodeId: entry.id, delayHours: 0 }
    : resolveNextStep(graph, entry.id);
}

/**
 * Walk the WHOLE expected chain from the entry node, the way the worker would
 * if every recipient stays verified_active and the journey stays active. For
 * condition nodes there are multiple possible branches; we follow edges[0]
 * (the default forward edge) and ALSO list the branch handles so the operator
 * can see the fork. This reveals whether a "step #2" email even exists in the
 * graph, and at what cumulative delay it is scheduled.
 *
 * `journeyId` is used only to render the expected dedupeKey for each step.
 */
interface SimStep {
  index: number; // 1-based: #1 is the first send the recipient gets
  nodeId: string;
  type: NextStepType;
  cumulativeDelayHours: number; // hours after enrolment this step fires
  dedupeKey: string;
  note?: string;
}

function simulateChain(
  graph: JourneyGraph,
  journeyId: string,
  signupId: string,
): { steps: SimStep[]; warning?: string } {
  const first = firstStep(graph);
  if (!first) {
    return {
      steps: [],
      warning:
        "firstStep() is null — the graph has no entry node, or the entry leads nowhere (entry_leads_nowhere). NO step would EVER be enqueued, so even email #1 should not have sent from THIS graph.",
    };
  }

  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const steps: SimStep[] = [];
  const seenNodes = new Set<string>();
  let cursor: { nodeId: string; delayHours: number; type: NextStepType } = {
    nodeId: first.nodeId,
    delayHours: first.delayHours,
    type:
      (byId.get(first.nodeId)?.type as NextStepType) ??
      ("email" as NextStepType),
  };
  let cumulative = 0;
  let index = 0;

  // Bound the walk by node count (+slack) — the same cycle protection the
  // engine relies on; a malformed loop can't hang the diagnostic.
  for (let guard = 0; guard <= graph.nodes.length + 1; guard += 1) {
    index += 1;
    cumulative += cursor.delayHours;
    const node = byId.get(cursor.nodeId);
    const dedupeKey = `journey:${journeyId}:${cursor.nodeId}:${signupId}`;
    let note: string | undefined;
    if (cursor.type === "condition") {
      const handles = (node?.data?.branches ?? []).map((b) => b.id);
      note = `CONDITION node — forks. branch handles: [${handles.join(", ") || "(none)"}] + implicit "default". This sim follows edges[0]; real routing depends on live recipient data.`;
    }
    steps.push({
      index,
      nodeId: cursor.nodeId,
      type: cursor.type,
      cumulativeDelayHours: cumulative,
      dedupeKey,
      note,
    });

    if (seenNodes.has(cursor.nodeId)) {
      steps[steps.length - 1]!.note =
        (note ? note + " " : "") + "(cycle — stopping walk)";
      break;
    }
    seenNodes.add(cursor.nodeId);

    const next = resolveNextStep(graph, cursor.nodeId);
    if (!next) {
      // Dead end: last node / unconnected edge. The chain simply ENDS here with
      // no next job and no error (resolveNextStep returned null).
      break;
    }
    cursor = next;
  }

  return { steps };
}

// =============================================================================
// Firestore access — one app per project, named-DB selection mirroring
// src/lib/tenant/firestore.ts getDb(). READ-ONLY.
// =============================================================================

const dbCache = new Map<string, Firestore>();

function dbFor(projectId: string, databaseId: string): Firestore {
  const key = `${projectId}::${databaseId}`;
  const cached = dbCache.get(key);
  if (cached) return cached;
  // @google-cloud/firestore takes databaseId directly ('(default)' is valid).
  // authClient isn't in the public Settings type but is honoured by gax.
  const opts = {
    projectId,
    databaseId,
    authClient: tokenAuthClient(),
  } as unknown as ConstructorParameters<typeof Firestore>[0];
  const db = new Firestore(opts);
  dbCache.set(key, db);
  return db;
}

// --- small formatting helpers ------------------------------------------------
const NOW = new Date();
const NOW_ISO = NOW.toISOString();

function s(v: unknown): string {
  if (v === undefined) return "(unset)";
  if (v === null) return "null";
  if (typeof v === "string") return v;
  return JSON.stringify(v);
}

/** Human-friendly relative time for an ISO string, e.g. "3.2h ago" / "in 12h". */
function rel(iso: unknown): string {
  if (typeof iso !== "string" || !iso) return "";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const diffMs = t - NOW.getTime();
  const h = diffMs / 3_600_000;
  const ah = Math.abs(h);
  const mag = ah >= 48 ? `${(ah / 24).toFixed(1)}d` : `${ah.toFixed(1)}h`;
  return diffMs < 0 ? `${mag} ago` : `in ${mag}`;
}

function hr(title: string): void {
  console.log("\n" + "=".repeat(78));
  console.log(title);
  console.log("=".repeat(78));
}
function sub(title: string): void {
  console.log("\n--- " + title + " " + "-".repeat(Math.max(0, 70 - title.length)));
}

interface EnvHealth {
  projectId: string;
  databaseId: string;
  overduePending: number;
  failed: number;
}

// =============================================================================
// Per-project scan
// =============================================================================

async function scanProject(
  projectId: string,
  targetEmailRaw: string,
  health: EnvHealth[],
): Promise<{ signupsFound: number }> {
  hr(`PROJECT: ${projectId}`);
  const targetEmail = normalizeEmail(targetEmailRaw);
  let signupsFound = 0;

  // 1) Read the tenants registry from the (default) DB.
  let tenants: Array<{ id: string; region: string }> = [];
  try {
    const defaultDb = dbFor(projectId, DEFAULT_DATABASE_ID);
    const snap = await defaultDb.collection("tenants").get();
    tenants = snap.docs.map((d) => {
      const data = d.data() as DocumentData;
      return { id: d.id, region: String(data.region ?? "us") };
    });
    console.log(
      `tenants registry ((default) DB): ${tenants.length} tenant(s) — ` +
        tenants.map((t) => `${t.id}[${t.region}]`).join(", "),
    );
  } catch (err) {
    console.error(
      `  ! FAILED to read tenants registry from ${projectId} (default) DB: ${errMsg(err)}`,
    );
    console.error(
      "    (auth/ADC, project access, or RAPT reauth? cannot enumerate tenants — skipping project)",
    );
    return { signupsFound: 0 };
  }

  if (tenants.length === 0) {
    console.log("  (no tenants registered in this project)");
    return { signupsFound: 0 };
  }

  // Every regional DB that ANY tenant in this project uses. We env-health ALL of
  // them (not just the ones a matching signup was found in): if the recipient is
  // not found, the "is the cron draining this env?" signal is exactly what we
  // still need, so it must never go silent just because the signup lookup missed.
  const allRegionalDbs = new Set<string>();
  for (const t of tenants) {
    const dbId = REGION_TO_DB[t.region];
    if (dbId) allRegionalDbs.add(dbId);
  }

  for (const tenant of tenants) {
    const databaseId = REGION_TO_DB[tenant.region];
    if (!databaseId) {
      console.error(
        `  ! tenant ${tenant.id}: unknown region '${tenant.region}' — no DB mapping, skipping`,
      );
      continue;
    }

    let db: Firestore;
    try {
      db = dbFor(projectId, databaseId);
    } catch (err) {
      console.error(
        `  ! tenant ${tenant.id}: cannot open DB '${databaseId}': ${errMsg(err)}`,
      );
      continue;
    }

    // 3) signups where email == normalized, then keep only THIS tenant's docs.
    let signups: Array<{ id: string; data: DocumentData }> = [];
    try {
      const snap = await db
        .collection("signups")
        .where("email", "==", targetEmail)
        .get();
      signups = snap.docs
        .map((d) => ({ id: d.id, data: d.data() as DocumentData }))
        // Defence in depth: a regional DB is shared by all tenants in that
        // region, so filter to this tenant exactly like TenantCollection does.
        .filter((row) => row.data.tenantId === tenant.id);
    } catch (err) {
      console.error(
        `  ! tenant ${tenant.id} (db ${databaseId}): signup query failed: ${errMsg(err)}`,
      );
      // continue — a missing collection/index for one tenant must not abort.
      continue;
    }

    if (signups.length === 0) continue; // nothing for this tenant; stay quiet

    for (const su of signups) {
      signupsFound += 1;
      await reportSignup(db, projectId, tenant, databaseId, su).catch((err) => {
        console.error(`  ! error while reporting signup ${su.id}: ${errMsg(err)}`);
      });
    }
  }

  // 5) ENV-HEALTH for EVERY regional DB this project's tenants use.
  for (const databaseId of allRegionalDbs) {
    try {
      const db = dbFor(projectId, databaseId);
      const [overdue, failed] = await Promise.all([
        // pending AND scheduledAt < now == overdue (the cron should have run it).
        countOverduePending(db),
        countByStatus(db, "failed"),
      ]);
      health.push({ projectId, databaseId, overduePending: overdue, failed });
    } catch (err) {
      console.error(
        `  ! env-health count failed for ${projectId}/${databaseId}: ${errMsg(err)}`,
      );
    }
  }

  return { signupsFound };
}

/**
 * Count overdue pending jobs WITHOUT a composite index. The two-field
 * (status, scheduledAt) aggregation would need an index that may not be
 * deployed; instead we read just the single-field `status == pending` set
 * (single-field indexes always exist) and compare scheduledAt in code. Bounded
 * and read-only. Returns -1 if even the single-field read fails.
 */
async function countOverduePending(db: Firestore): Promise<number> {
  try {
    const snap = await db
      .collection("email_jobs")
      .where("status", "==", "pending")
      .get();
    return snap.docs.filter((d) => {
      const sa = (d.data() as DocumentData).scheduledAt;
      return typeof sa === "string" && sa < NOW_ISO;
    }).length;
  } catch {
    return -1; // signal "could not determine"
  }
}

/** Count jobs in a status via the always-present single-field index. */
async function countByStatus(db: Firestore, status: string): Promise<number> {
  try {
    const snap = await db
      .collection("email_jobs")
      .where("status", "==", status)
      .count()
      .get();
    return snap.data().count;
  } catch {
    // count() aggregation can be disabled / quota'd; fall back to a doc read.
    try {
      const docs = await db
        .collection("email_jobs")
        .where("status", "==", status)
        .get();
      return docs.size;
    } catch {
      return -1;
    }
  }
}

async function reportSignup(
  db: Firestore,
  projectId: string,
  tenant: { id: string; region: string },
  databaseId: string,
  su: { id: string; data: DocumentData },
): Promise<void> {
  const d = su.data;
  const campaignId = String(d.campaignId ?? "");
  const journeyId = `journey_${campaignId}`;

  sub(`SIGNUP ${su.id}`);
  console.log(`  project:        ${projectId}`);
  console.log(`  tenantId:       ${tenant.id}`);
  console.log(`  region:         ${tenant.region}  (db '${databaseId}')`);
  console.log(`  email:          ${s(d.email)}`);
  console.log(`  status:         ${s(d.status)}`);
  console.log(`  verified:       ${s(d.verified)}`);
  console.log(`  campaignId:     ${campaignId}`);
  console.log(`  locale:         ${s(d.locale)}`);
  console.log(`  createdAt:      ${s(d.createdAt)}  (${rel(d.createdAt)})`);

  // Sanity flags that bear directly on whether step #2 can ever send.
  if (d.status !== "verified_active") {
    console.log(
      `  >> WARNING: status is '${s(d.status)}', NOT 'verified_active'. A journey_step job for this recipient will resolve to 'drop' (job DELETED, no send, chain ends). This alone can explain a missing email #2.`,
    );
  }
  if (d.verified === false) {
    console.log(
      "  >> WARNING: verified=false — unverified recipients are dropped by the journey worker.",
    );
  }

  // (a) Journey doc + graph.
  let graph: JourneyGraph | null = null;
  let journeyStatus = "(no journey doc)";
  try {
    const jSnap = await db.collection("journeys").doc(journeyId).get();
    if (!jSnap.exists) {
      console.log(`\n  journey '${journeyId}': NOT FOUND in db '${databaseId}'.`);
      console.log(
        "  >> If email #1 sent, the journey must have existed when it was enqueued. A missing journey doc now means it was deleted, or this is the wrong DB/project.",
      );
    } else {
      const jData = jSnap.data() as DocumentData;
      // Tenant defence in depth, same as TenantCollection.getById.
      if (jData.tenantId !== tenant.id) {
        console.log(
          `\n  journey '${journeyId}': belongs to a DIFFERENT tenant (${s(jData.tenantId)}) — ignoring.`,
        );
      } else {
        journeyStatus = String(jData.status ?? "(unset)");
        graph = (jData.graph as JourneyGraph) ?? { nodes: [], edges: [] };
        printJourney(journeyId, journeyStatus, graph);
        if (journeyStatus !== "active") {
          console.log(
            `  >> WARNING: journey.status='${journeyStatus}' (not 'active'). The worker returns 'done' WITHOUT enqueuing the next step when a journey is not active. If it was paused after email #1, step #2 never got scheduled. This is a prime suspect.`,
          );
        }
      }
    }
  } catch (err) {
    console.error(`  ! failed to read journey '${journeyId}': ${errMsg(err)}`);
  }

  // (b) Simulate the expected chain.
  if (graph) {
    sub("EXPECTED CHAIN (simulated from the graph)");
    const { steps, warning } = simulateChain(graph, journeyId, su.id);
    if (warning) console.log(`  ${warning}`);
    if (steps.length === 0 && !warning) {
      console.log("  (no steps — graph yields no sendable node)");
    }
    for (const step of steps) {
      const node = graph.nodes.find((n) => n.id === step.nodeId);
      const subj =
        node?.type === "email" ? ` subject="${s(node.data?.subject)}"` : "";
      console.log(
        `  step #${step.index}: node '${step.nodeId}' [${step.type}]${subj}`,
      );
      console.log(
        `            fires ~+${step.cumulativeDelayHours}h after enrolment`,
      );
      console.log(`            expected dedupeKey: ${step.dedupeKey}`);
      if (step.note) console.log(`            note: ${step.note}`);
    }
    if (steps.length <= 1) {
      console.log(
        "  >> The simulated chain has <=1 sendable step: there may be NO 'step #2' in the graph at all (dead-end after the first email / unconnected edge). If so, the missing email #2 is BY DESIGN, not a stuck queue.",
      );
    }
  }

  // (c) ALL email_jobs for this campaign+signup.
  sub("EMAIL_JOBS for this campaign + signup");
  try {
    const snap = await db
      .collection("email_jobs")
      .where("campaignId", "==", campaignId)
      .get();
    const jobs = snap.docs
      .map((doc) => ({ id: doc.id, data: doc.data() as DocumentData }))
      .filter((j) => {
        if (j.data.tenantId !== tenant.id) return false;
        const payload = (j.data.payload ?? {}) as DocumentData;
        return String(payload.signupId ?? "") === su.id;
      })
      .sort((a, b) =>
        String(a.data.scheduledAt ?? "").localeCompare(
          String(b.data.scheduledAt ?? ""),
        ),
      );

    if (jobs.length === 0) {
      console.log(
        `  (no email_jobs found for signup ${su.id} in campaign ${campaignId})`,
      );
      console.log(
        "  >> If email #1 sent, its job was 'done' then would normally still exist (journey_step 'done' jobs are NOT deleted; only 'drop' deletes). NO jobs at all is suspicious: wrong project/DB, or jobs purged. Cross-check the other project.",
      );
    } else {
      console.log(`  ${jobs.length} job(s):`);
      for (const j of jobs) {
        const data = j.data;
        const status = String(data.status ?? "");
        const scheduledAt = data.scheduledAt;
        const overdue =
          status === "pending" &&
          typeof scheduledAt === "string" &&
          scheduledAt < NOW_ISO;
        console.log(`  • id:          ${j.id}`);
        console.log(`    type:        ${s(data.type)}`);
        console.log(
          `    status:      ${status}${overdue ? "   <<< OVERDUE (pending & scheduledAt in the past — the cron should have drained this)" : ""}`,
        );
        console.log(
          `    scheduledAt: ${s(scheduledAt)}  (${rel(scheduledAt)})`,
        );
        console.log(`    attempts:    ${s(data.attempts)}`);
        console.log(`    claimedAt:   ${s(data.claimedAt)}  (${rel(data.claimedAt)})`);
        console.log(`    emailSentAt: ${s(data.emailSentAt)}  (${rel(data.emailSentAt)})`);
        console.log(`    processedAt: ${s(data.processedAt)}  (${rel(data.processedAt)})`);
        console.log(`    createdAt:   ${s(data.createdAt)}  (${rel(data.createdAt)})`);
        console.log(`    lastError:   ${s(data.lastError)}`);
        const payload = (data.payload ?? {}) as DocumentData;
        console.log(
          `    payload:     journeyId=${s(payload.journeyId)} nodeId=${s(payload.nodeId)} signupId=${s(payload.signupId)}`,
        );
        if (status === "failed") {
          console.log(
            "    >> This job FAILED (>=3 attempts). It will never send and never enqueue the next step — chain stops here.",
          );
        }
        if (overdue) {
          console.log(
            "    >> OVERDUE pending: enqueued correctly but never drained. Classic 'no cron in this env' symptom (dev has no scheduler). Email #2 is waiting on a worker that never runs.",
          );
        }
        if (status === "processing") {
          console.log(
            "    >> Stuck 'processing': a worker claimed it and crashed. Reclaimed only after the 5-min lease — if claimedAt is old and no cron runs, it stays stuck.",
          );
        }
      }
    }
  } catch (err) {
    console.error(
      `  ! failed to list email_jobs for campaign ${campaignId}: ${errMsg(err)}`,
    );
  }
}

function printJourney(
  journeyId: string,
  status: string,
  graph: JourneyGraph,
): void {
  sub(`JOURNEY ${journeyId}`);
  console.log(`  status: ${status}`);
  console.log(`  nodes (${graph.nodes.length}):`);
  for (const n of graph.nodes) {
    let detail = "";
    if (n.type === "wait") detail = `waitHours=${s(n.data?.waitHours)}`;
    else if (n.type === "email") detail = `subject="${s(n.data?.subject)}"`;
    else if (n.type === "condition") {
      const branches = (n.data?.branches ?? [])
        .map((b) => `${b.id}${b.label ? `(${b.label})` : ""}`)
        .join(", ");
      detail = `branches=[${branches}]`;
    }
    console.log(`    - ${n.id}  [${n.type}]  ${detail}`);
  }
  console.log(`  edges (${graph.edges.length}):`);
  for (const e of graph.edges) {
    const handle = e.sourceHandle ? `  (handle: ${e.sourceHandle})` : "";
    console.log(`    - ${e.source} -> ${e.target}${handle}`);
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// =============================================================================
// main
// =============================================================================

async function main(): Promise<void> {
  const [, , emailArg, projectArg] = process.argv;
  if (!emailArg) {
    console.error(
      "Usage: npx tsx scripts/diagnose-journey.ts <email> [projectId]\n" +
        "  projectId optional; default scans BOTH " +
        DEFAULT_PROJECTS.join(" and "),
    );
    process.exit(2);
  }

  const projects = projectArg ? [projectArg] : DEFAULT_PROJECTS;

  hr("JOURNEY DELIVERY DIAGNOSTIC (READ-ONLY)");
  console.log(`  target email:   ${emailArg}  (normalized: ${normalizeEmail(emailArg)})`);
  console.log(`  projects:       ${projects.join(", ")}`);
  console.log(`  now:            ${NOW_ISO}`);
  console.log(
    `  emulator hosts: FIRESTORE_EMULATOR_HOST=${s(process.env.FIRESTORE_EMULATOR_HOST)} (cleared by this tool) — querying REAL cloud Firestore via ADC.`,
  );

  const health: EnvHealth[] = [];
  let totalFound = 0;

  for (const projectId of projects) {
    try {
      const { signupsFound } = await scanProject(projectId, emailArg, health);
      totalFound += signupsFound;
    } catch (err) {
      console.error(`\n  !! project ${projectId} scan aborted: ${errMsg(err)}`);
      // continue to the next project
    }
  }

  hr("ENV-HEALTH SUMMARY (per regional DB touched)");
  if (health.length === 0) {
    console.log("  (no regional DBs were successfully queried)");
  } else {
    for (const h of health) {
      const overdueStr =
        h.overduePending < 0 ? "unknown" : String(h.overduePending);
      const failedStr = h.failed < 0 ? "unknown" : String(h.failed);
      console.log(
        `  ${h.projectId} / db '${h.databaseId}': overdue pending = ${overdueStr}, failed = ${failedStr}`,
      );
      if (h.overduePending > 0) {
        console.log(
          `      >> ${h.overduePending} OVERDUE pending job(s): a non-trivial backlog means the cron is NOT draining this env. Recall: DEV has NO scheduler job; PROD's 'email-delivery-worker' fires every 2 min.`,
        );
      }
    }
  }

  hr("VERDICT");
  if (totalFound === 0) {
    console.log(
      "  NO SIGNUP FOUND for this email in ANY tenant of ANY scanned project.",
    );
    console.log(
      "  Possible causes: typo/whitespace/case in the email (we normalize trim+lowercase only, NOT Gmail dots/plus); the signup lives in a project not scanned; or it lives in a tenant whose region DB we could not read (see errors above). Email #1 having sent means a deployed backend HAS this signup somewhere — re-check the address and the project list.",
    );
  } else {
    console.log(
      `  Found ${totalFound} matching signup(s). Read the per-signup sections above. Decision guide:`,
    );
    console.log(
      "  1. A step-#2 journey_step job that is PENDING & OVERDUE (esp. in vizzybl-marketing-dev, which has no cron) => enqueued but never drained. PRIMARY hypothesis confirmed.",
    );
    console.log(
      "  2. No step-#2 job exists AND the simulated chain has <=1 step => the graph has no second email (missing email #2 is by design).",
    );
    console.log(
      "  3. A step-#2 job 'failed' => exhausted retries; see lastError; chain stopped.",
    );
    console.log(
      "  4. journey.status != 'active' => paused/draft; worker stops the chain without enqueuing #2.",
    );
    console.log(
      "  5. signup.status != 'verified_active' (or verified=false) => the step would 'drop'; the job may be ABSENT (deleted).",
    );
    console.log(
      "  6. A step-#2 job PENDING but scheduledAt still in the FUTURE (cumulative wait > elapsed ~48h) => not overdue; it simply hasn't come due yet.",
    );
  }
  console.log("");
}

main().catch((err) => {
  console.error("FATAL:", errMsg(err));
  process.exit(1);
});