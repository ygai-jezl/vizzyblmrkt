// What a self-hosted copy of YouGrow needs in a Google Cloud project: the APIs, the core
// secrets, the scheduled jobs and the feature switches an add-on turns on. Shared by
// `npm run selfhost` and `npm run doctor -- --cloud`. Node built-ins only.

export const DEFAULT_REGION = "us-central1";
export const DEFAULT_ENV = "live";
export const DEFAULT_BRANCH = "main";
/** Firestore's US multi-region; App Hosting's default region (us-central1) reads and writes in it. */
export const DEFAULT_FIRESTORE_LOCATION = "nam5";
export const WEB_APP_NAME = "YouGrow";

/** A Google Cloud project id: 6 to 30 characters, lowercase letter first, letters, digits, hyphens. */
export const PROJECT_ID_RE = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
/** An App Hosting backend id. */
export const BACKEND_ID_RE = /^[a-z][a-z0-9-]{0,29}$/;
/** An environment name: it becomes the file name apphosting.<env>.yaml. */
export const ENV_NAME_RE = /^[a-z][a-z0-9-]{0,29}$/;
export const REGION_RE = /^[a-z]+-[a-z]+[0-9]+$/;

/**
 * The APIs the app and its setup use. From the code (Firestore, Vertex AI, Cloud Storage,
 * Cloud KMS, Secret Manager, Identity Toolkit) and the infra scripts (Cloud Scheduler), plus
 * what App Hosting builds and runs on (Cloud Build, Artifact Registry, Cloud Run, Developer
 * Connect for a GitHub repo).
 */
export const REQUIRED_APIS = [
  { id: "firebase.googleapis.com", why: "Firebase" },
  { id: "firebaseapphosting.googleapis.com", why: "App Hosting" },
  { id: "run.googleapis.com", why: "Cloud Run (App Hosting serves the app on it)" },
  { id: "cloudbuild.googleapis.com", why: "Cloud Build (App Hosting builds the app with it)" },
  { id: "artifactregistry.googleapis.com", why: "Artifact Registry (holds the built app)" },
  { id: "developerconnect.googleapis.com", why: "Developer Connect (links a GitHub repo)" },
  { id: "firestore.googleapis.com", why: "Firestore" },
  { id: "firebaserules.googleapis.com", why: "Firestore rules" },
  { id: "identitytoolkit.googleapis.com", why: "Firebase Authentication (Google sign-in)" },
  { id: "secretmanager.googleapis.com", why: "Secret Manager" },
  { id: "aiplatform.googleapis.com", why: "Vertex AI (Gemini)" },
  { id: "storage.googleapis.com", why: "Cloud Storage (brand files and images)" },
  { id: "cloudkms.googleapis.com", why: "Cloud KMS (signs requests to connected products)" },
  { id: "cloudscheduler.googleapis.com", why: "Cloud Scheduler (scheduled work)" },
  { id: "iam.googleapis.com", why: "IAM (service accounts and roles)" },
  { id: "cloudresourcemanager.googleapis.com", why: "Resource Manager (project roles)" },
  { id: "cloudbilling.googleapis.com", why: "Cloud Billing (the billing check)" },
];

/**
 * The secrets every deployment needs: the same set `npm run local` makes for a laptop
 * (scripts/local-env.template). Worker secrets go in a scheduler header, so they are hex;
 * the keys are base64. Names match the infra scripts.
 */
export const CORE_SECRETS = [
  { name: "lifecycle-worker-secret", env: "LIFECYCLE_WORKER_SECRET", encoding: "hex" },
  { name: "email-worker-secret", env: "EMAIL_WORKER_SECRET", encoding: "hex" },
  { name: "distribute-worker-secret", env: "DISTRIBUTE_WORKER_SECRET", encoding: "hex" },
  { name: "connect-secret-enc-key", env: "CONNECT_SECRET_ENC_KEY", encoding: "base64" },
  { name: "social-token-enc-key", env: "SOCIAL_TOKEN_ENC_KEY", encoding: "base64" },
  { name: "git-token-enc-key", env: "GIT_TOKEN_ENC_KEY", encoding: "base64" },
  { name: "mailchimp-key-enc-key", env: "MAILCHIMP_KEY_ENC_KEY", encoding: "base64" },
  { name: "unsubscribe-signing-key", env: "UNSUBSCRIBE_SIGNING_KEY", encoding: "base64" },
  { name: "invite-link-signing-key", env: "INVITE_LINK_SIGNING_KEY", encoding: "base64" },
  { name: "canvas-context-signing-key", env: "CANVAS_CONTEXT_SIGNING_KEY", encoding: "base64" },
  { name: "connectors-vault-key", env: "CONNECTORS_VAULT_KEY", encoding: "base64" },
];

/**
 * The web app's API key. It is public (every browser gets it), but kept in Secret Manager so
 * it isn't committed to your fork, where secret scanners flag Google API keys.
 */
export const WEB_API_KEY_SECRET = { name: "firebase-web-api-key", env: "NEXT_PUBLIC_FIREBASE_API_KEY" };

/** The three Cloud Scheduler jobs, created by the infra scripts. */
export const SCHEDULER_JOBS = [
  { job: "lifecycle-tick", script: "infra/lifecycle/setup.sh", what: "journeys, every 2 minutes" },
  { job: "email-delivery-worker", script: "infra/email-worker/setup.sh", what: "emails, every 2 minutes" },
  { job: "distribute-scheduled-worker", script: "infra/distribute-worker/setup.sh", what: "scheduled posts, every minute" },
];
export const SCHEDULER_LOCATION = "us-central1";

/** Where the connected-product signing key lives (infra/lifecycle/setup.sh signing-key). */
export function signingKeyName(project) {
  return `projects/${project}/locations/us-central1/keyRings/yougrow-connect/cryptoKeys/outbound-signing`;
}

/** The private bucket for brand files and generated images (EMAIL_ASSET_BUCKET). */
export function assetBucketName(project) {
  return `${project}-yougrow-assets`;
}

/** The App Hosting runtime service account (App Hosting creates it with the first backend). */
export function runtimeServiceAccount(project) {
  return `firebase-app-hosting-compute@${project}.iam.gserviceaccount.com`;
}

/** Roles the runtime service account needs beyond what App Hosting gives it. */
export const RUNTIME_ROLES = [{ role: "roles/aiplatform.user", why: "Gemini and embeddings on Vertex AI" }];

/**
 * Switches `npm run selfhost` leaves off when it turns the rest on, each with why and the
 * add-on that turns it on (null: you turn it on by hand). Everything else in apphosting.yaml
 * is turned on.
 */
export const KEPT_OFF = {
  SITE_HOME_ENABLED: { addon: null, why: "YouGrow's own marketing homepage; off, / is a plain front page with a sign-in button" },
  SITE_SEO_ENABLED: { addon: null, why: "robots, sitemap and schema.org markup for YouGrow's own marketing site" },
  SITE_LOOP_ENABLED: { addon: null, why: "YouGrow's own marketing pages" },
  SITE_LANGUAGES_ENABLED: { addon: null, why: "YouGrow's own marketing pages in other languages" },
  NEXT_PUBLIC_GA_ENABLED: { addon: null, why: "needs your Google Analytics id (NEXT_PUBLIC_GA_MEASUREMENT_ID)" },
  NEXT_PUBLIC_GA_DEBUG_MODE: { addon: null, why: "sends Analytics hits to DebugView, for testing only" },
  PLANS_ENABLED: { addon: null, why: "the hosted service's plans; off, every brand may use every feature its switch turns on (docs/self-host.md, Plans)" },
  NEXT_PUBLIC_PLANS_ENABLED: { addon: null, why: "Settings, Plan and usage for the hosted service's plans; with PLANS_ENABLED off it only says plans are off" },
  ORGANISATION_JOIN_ENABLED: {
    addon: null,
    why: "Bring in and Move out on Settings › Organisation need plans on (PLANS_ENABLED, every organisation on Self-hosted) and owners added with scripts/set-plan.ts (docs/self-host.md, Brands in an organisation)",
  },
  RECAPTCHA_ENABLED: { addon: "recaptcha", why: "needs a reCAPTCHA Enterprise key; on without one, every waitlist sign-up is refused" },
  KNOWLEDGE_RAG_ENABLED: { addon: "knowledge", why: "needs the knowledge worker" },
  GIT_REPO_SELECTION_ENABLED: { addon: "github-app", why: "needs a connected repo (the read-only GitHub App)" },
  CONNECTOR_REVOKE_X_ENABLED: {
    addon: null,
    why: "Disconnect may end another brand's X access when two brands share one X account; turn it on after checking that",
  },
  DISTRIBUTE_SOCIAL_ENABLED: { addon: "x", why: "needs an X or LinkedIn app (addon:x or addon:linkedin)" },
  DISTRIBUTE_CAROUSEL_ENABLED: { addon: "linkedin", why: "posts carousels to LinkedIn" },
  DISTRIBUTE_CLOSED_LOOP_ENABLED: { addon: "x", why: "learns from posted results (needs X or LinkedIn)" },
  HASHTAG_LEADERBOARD_ENABLED: { addon: "x", why: "learns from posted results (needs X or LinkedIn)" },
  POST_PATTERNS_LEARN_ENABLED: { addon: "x", why: "learns from posted results (needs X or LinkedIn)" },
  POST_PATTERNS_INJECT_ENABLED: { addon: "x", why: "uses the learned post patterns (needs X or LinkedIn)" },
  TRENDING_TOPICS_ENABLED: { addon: "x", why: "learns from posted results (needs X or LinkedIn)" },
  LIFECYCLE_CHAT_AUTHORING_ENABLED: { addon: "vizzy", why: "Vizzy drafting journeys needs the agent" },
  CONTENT_CHAT_AUTHORING_ENABLED: { addon: "vizzy", why: "Vizzy drafting content plans needs the agent" },
  BRAND_MAP_CHAT_ENABLED: { addon: "vizzy", why: "Vizzy's brand map suggestions need the agent" },
  BRAND_NOTES_CHAT_ENABLED: { addon: "vizzy", why: "Vizzy adding brand notes needs the agent" },
  COMPETITORS_CHAT_ENABLED: { addon: "vizzy", why: "Vizzy reading your competitors needs the agent" },
  ONBOARDING_CALL_WORDS_IN_CHAT_ENABLED: {
    addon: "vizzy",
    why: "Vizzy reading the words from calls needs the agent, and keeps what it reads with the chat in Agent Runtime after the call is deleted",
  },
  LIFECYCLE_PERSON_BRIEF: { addon: "vizzy", why: "Vizzy reading one person needs the agent" },
  LIFECYCLE_PERSON_PLANS: { addon: "vizzy", why: "a plan per person needs the agent" },
  SEARCH_INDEX_ENABLED: { addon: "search", why: "needs the search databases (Firestore Enterprise)" },
  SEARCH_ENABLED: { addon: "search", why: "needs the search databases (Firestore Enterprise)" },
  SEARCH_RERANK_ENABLED: { addon: null, why: "reorders US brands' results with Google's Ranking API; needs the Discovery Engine API and discoveryengine.rankingConfigs.rank for the runtime service account" },
  NEXT_PUBLIC_SEARCH_ENABLED: { addon: "search", why: "needs the search databases (Firestore Enterprise)" },
  VIZZY_SEARCH_ENABLED: { addon: "search", why: "Vizzy searching the brand needs the search databases and the agent" },
  CONNECTORS_ENABLED: { addon: null, why: "connected data is new: turn it on by hand" },
  NEXT_PUBLIC_CONNECTORS_ENABLED: { addon: null, why: "connected data is new: turn it on by hand" },
  CONNECTOR_CLOUDFLARE_ENABLED: { addon: null, why: "connected data is new: turn it on by hand" },
  CONNECTOR_SEARCH_CONSOLE_ENABLED: { addon: null, why: "needs a Google OAuth client or the identities project (docs/self-host.md, Connect Google data on your own copy)" },
  CONNECTOR_GA4_ENABLED: { addon: null, why: "needs the identities project, or a Google OAuth client with CONNECTOR_GA4_SIGNIN_ENABLED (docs/self-host.md, Google Analytics and share access)" },
  CONNECTOR_GA4_SIGNIN_ENABLED: {
    addon: null,
    why: "Google Analytics by Sign in needs Google's review of your app's sensitive permission first (docs/self-host.md, Google Analytics and share access)",
  },
  CONNECTORS_CHAT_ENABLED: { addon: "vizzy", why: "Vizzy reading connected data needs the agent, redeployed with its connector tools" },
  CONNECTOR_GOOGLE_REVOKE_ENABLED: {
    addon: null,
    why: "Disconnect would end every connection the same Google account made, for every brand; turn it on after checking that",
  },
  CONNECTORS_COLLECT_ENABLED: {
    addon: null,
    why: "collects each connection's numbers once a day; run infra/lifecycle/setup.sh ttl and deploy the index file without --force first (docs/self-host.md, Upgrading to collected numbers)",
  },
  CONNECTORS_SEARCH_TEXT_ENABLED: {
    addon: "search",
    why: "Search Console's searches in brand search need the search databases, and do nothing until CONNECTORS_COLLECT_ENABLED is on",
  },
  CONNECTOR_SIGNALS_ENABLED: {
    addon: null,
    why: "suggestions from collected numbers do nothing until CONNECTORS_COLLECT_ENABLED is on, need the agent action indexes READY and the data_signals time to live, and come only from connections Vizzy may read (docs/self-host.md, Upgrading to collected numbers)",
  },
  CONNECTORS_SHARING_ENABLED: {
    addon: null,
    why: "organisations sharing connections need plans on (PLANS_ENABLED, every organisation on Self-hosted), the organisation_connection_activity time to live and the index file deployed without --force (docs/self-host.md, Shared connections across your brands)",
  },
  ANALYTICS_BQ_ENABLED: { addon: "bigquery", why: "needs the BigQuery datasets and export extensions" },
  NEXT_PUBLIC_ANALYTICS_BQ_ENABLED: { addon: "bigquery", why: "needs the BigQuery datasets and export extensions" },
  PASSWORD_SIGNIN_ENABLED: {
    addon: "password",
    why: "needs Identity Platform's Email/Password provider set up safely first (addon:password), and an email provider for the codes (addon:email)",
  },
  PASSWORD_CLEANUP_DELETE_ENABLED: {
    addon: null,
    why: "deletes password accounts still unconfirmed after 7 days; read the would_delete lines in your logs for a while first (docs/self-host.md, Email and password sign-in)",
  },
  SELF_SERVE_SIGNUP_ENABLED: { addon: null, why: "does nothing yet: it waits for self-serve brand creation" },
  ONBOARDING_VOICE_ENABLED: {
    addon: null,
    why: "talking with Vizzy by voice needs GEMINI_LIVE_API_KEY, a Gemini API key from AI Studio on a project with billing, and sends the audio to the Gemini API outside your Google Cloud project; turn it on by hand once you accept that",
  },
  TRUSTED_CLIENT_IP_ENABLED: {
    addon: null,
    why: "measure the X-Forwarded-For shape your copy receives first (docs/self-host.md, Email and password sign-in)",
  },
  EDIT_MODE_LEARNING_FOLLOWS_VIZZY_ENABLED: {
    addon: null,
    why: "Edit mode learning would come with Vizzy in Edit mode for brands in the agent's region, so a hold on edit_vizzy_learning in GRANTED_ONLY_FEATURES would keep back post edits only; with plans off and no hold it adds nothing (docs/self-host.md, Vizzy in Edit mode)",
  },
};

/**
 * Brand search (addon:search): a Firestore ENTERPRISE database per region, next to the region's
 * own database (text search needs that edition). `location: null` means "where (default) is".
 * Must match SEARCH_DATABASE_IDS in src/lib/tenant/region.ts.
 */
export const SEARCH_DATABASES = [
  { region: "us", database: "search", location: null, needs: "(default)" },
  { region: "eu", database: "search-eu", location: "eur3", needs: "signups-eu" },
  { region: "asia", database: "search-asia", location: "asia-southeast1", needs: "signups-asia" },
];
export const SEARCH_COLLECTION_GROUP = "search_docs";
/** Must match SEARCH_EMBEDDING_DIM in src/lib/agents/embeddings.ts. */
export const SEARCH_VECTOR_DIM = 768;
const TEXT_SPEC = '{"text-spec":{"index-specs":[{"index-type":"tokenized","match-type":"match-globally"}]}}';

/**
 * The gcloud arguments that create a search database and its two indexes. Enterprise turns
 * Firestore access off and MongoDB access on unless told otherwise, and `update` can't change
 * either, so both are set here. Text indexes are `gcloud beta` only; a text index and a vector
 * index can't share one definition.
 */
export function searchDatabaseArgs(project, database, location) {
  return {
    create: ["firestore", "databases", "create", `--database=${database}`, `--location=${location}`, "--edition=enterprise", "--enable-firestore-data-access", "--no-enable-mongodb-compatible-data-access", `--project=${project}`],
    textIndex: [
      "beta", "firestore", "indexes", "composite", "create", `--database=${database}`, `--collection-group=${SEARCH_COLLECTION_GROUP}`, "--query-scope=COLLECTION",
      `--field-config=field-path=title,search-config=${TEXT_SPEC}`,
      `--field-config=field-path=text,search-config=${TEXT_SPEC}`,
      "--search-index-options=text-language=en,text-language-override-field-path=lang",
      `--project=${project}`, "--async",
    ],
    vectorIndex: [
      "firestore", "indexes", "composite", "create", `--database=${database}`, `--collection-group=${SEARCH_COLLECTION_GROUP}`, "--query-scope=COLLECTION",
      `--field-config=field-path=embedding,vector-config={"dimension":"${SEARCH_VECTOR_DIM}","flat":"{}"}`,
      `--project=${project}`, "--async",
    ],
  };
}

/** The switches an add-on turns on. LinkedIn also turns on the posting switches marked "x". */
export function switchesForAddon(addon) {
  const social = addon === "x" || addon === "linkedin";
  return Object.entries(KEPT_OFF)
    .filter(([, k]) => k.addon === addon || (social && k.addon === "x"))
    .map(([name]) => name);
}

// ---------------------------------------------------------------------------
// Email and password sign-in (addon:password)
// ---------------------------------------------------------------------------

/**
 * The shortest password Identity Platform accepts, enforced by its password policy (it allows
 * 6 to 30). Must match PASSWORD_MIN_LENGTH in src/lib/auth/messages.ts, which the screens say.
 */
export const PASSWORD_MIN_LENGTH = 12;

/** Where Firebase's email links (password reset) land in the app: <app url>/auth/reset. */
export const RESET_PATH = "/auth/reset";

/** The APIs addon:password needs beyond the core ones: bot protection and the sign-in alerts. */
export const PASSWORD_APIS = [
  { id: "recaptchaenterprise.googleapis.com", why: "reCAPTCHA Enterprise, for bot protection" },
  { id: "logging.googleapis.com", why: "Cloud Logging, for the log metrics" },
  { id: "monitoring.googleapis.com", why: "Cloud Monitoring, for the alerts" },
];

/**
 * One way a project's Identity Toolkit config differs from what password sign-in needs: what
 * is wrong, what the add-on sets instead, and the PATCH (updateMask and body) that sets it.
 * @typedef {{
 *   id: string,
 *   what: string,
 *   fix: string,
 *   level: "fail" | "warn" | "info",
 *   batch: "accounts" | "policy" | "bots" | "logging" | "reset" | "provider",
 *   mask: string,
 *   body: Record<string, unknown>,
 * }} PasswordDiff
 */

const PASSWORD_POLICY_KINDS = ["containsLowercaseCharacter", "containsUppercaseCharacter", "containsNumericCharacter", "containsNonAlphanumericCharacter"];

/**
 * The config's `subtype` on a project still on plain Firebase Authentication. Upgraded projects
 * ("Firebase Authentication with Identity Platform") say "IDENTITY_PLATFORM". Plain projects
 * refuse request logging (OPERATION_NOT_ALLOWED, "activity logging can only be enabled in
 * GCIP"), so the sign-up alert that counts its log lines can't work there either.
 */
export const PLAIN_FIREBASE_AUTH = "FIREBASE_AUTH";

/**
 * True when the project's Identity Toolkit config says plain Firebase Authentication. Only that
 * exact subtype counts: an upgraded project, or a subtype this code doesn't know, is treated as
 * able to log requests, as before.
 * @param {any} config
 */
export function isPlainFirebaseAuth(config) {
  return Boolean(config && typeof config === "object" && config.subtype === PLAIN_FIREBASE_AUTH);
}

/** What the upgrade is, in one line, for the plan and the notes. */
export const IDENTITY_PLATFORM_UPGRADE =
  "Upgrade to Firebase Authentication with Identity Platform: free up to 50,000 monthly active users, can't be undone";

/** What a plain project goes without, for the notes. */
export const NEEDS_UPGRADE_NOTE = "request logging and the many password sign-ups alert need the Identity Platform upgrade";

/**
 * How a project's Identity Toolkit config (admin v2 `projects/<id>/config`) differs from what
 * password sign-in needs. Empty means it is ready. `level` says how much it matters: "fail"
 * leaves an account unsafe or the provider off, "warn" leaves protection or an alert off, and
 * "info" is advice only (the reset link's address: some projects refuse template changes).
 * The reset link is checked only when the app's address is known. Request logging is left out
 * on plain Firebase Authentication (isPlainFirebaseAuth), which refuses it.
 * @param {any} config
 * @param {string} [appUrl] the app's https origin, no path
 * @returns {PasswordDiff[]}
 */
export function passwordConfigDiff(config, appUrl = "") {
  const c = config && typeof config === "object" ? config : {};
  const signIn = c.signIn ?? {};
  const email = signIn.email ?? {};
  /** @type {PasswordDiff[]} */
  const out = [];
  if (signIn.allowDuplicateEmails === true) {
    out.push({
      id: "duplicates",
      what: "several accounts may share one email address",
      fix: "one account per email address",
      level: "fail",
      batch: "accounts",
      mask: "signIn.allowDuplicateEmails",
      body: { signIn: { allowDuplicateEmails: false } },
    });
  }
  if (email.passwordRequired !== true) {
    out.push({
      id: "password-required",
      what: "email sign-in doesn't ask for a password (email links only)",
      fix: "email sign-in asks for a password",
      level: "fail",
      batch: "accounts",
      mask: "signIn.email.passwordRequired",
      body: { signIn: { email: { passwordRequired: true } } },
    });
  }
  if (c.emailPrivacyConfig?.enableImprovedEmailPrivacy !== true) {
    out.push({
      id: "privacy",
      what: "email enumeration protection is off",
      fix: "email enumeration protection on",
      level: "fail",
      batch: "accounts",
      mask: "emailPrivacyConfig.enableImprovedEmailPrivacy",
      body: { emailPrivacyConfig: { enableImprovedEmailPrivacy: true } },
    });
  }

  const policy = c.passwordPolicyConfig ?? {};
  const options = (Array.isArray(policy.passwordPolicyVersions) ? policy.passwordPolicyVersions[0] : null)?.customStrengthOptions ?? {};
  const policyProblems = [
    ...(policy.passwordPolicyEnforcementState === "ENFORCE" ? [] : ["the password policy isn't enforced"]),
    ...(policy.passwordPolicyEnforcementState === "ENFORCE" && Number(options.minPasswordLength) !== PASSWORD_MIN_LENGTH
      ? [`the password policy asks for ${options.minPasswordLength ?? 6} characters, not ${PASSWORD_MIN_LENGTH}`]
      : []),
    ...(PASSWORD_POLICY_KINDS.some((k) => options[k] === true) ? ["the password policy asks for kinds of character the sign-in screens don't explain"] : []),
    ...(policy.forceUpgradeOnSignin === true ? ["the password policy forces a new password at sign-in"] : []),
  ];
  if (policyProblems.length) {
    const max = Number(options.maxPasswordLength);
    out.push({
      id: "policy",
      what: policyProblems.join("; "),
      fix: `a password policy of ${PASSWORD_MIN_LENGTH} characters or more, enforced, with no forced upgrade at sign-in`,
      level: "fail",
      batch: "policy",
      mask: "passwordPolicyConfig",
      body: {
        passwordPolicyConfig: {
          passwordPolicyEnforcementState: "ENFORCE",
          passwordPolicyVersions: [{ customStrengthOptions: { minPasswordLength: PASSWORD_MIN_LENGTH, ...(max >= PASSWORD_MIN_LENGTH ? { maxPasswordLength: max } : {}) } }],
          forceUpgradeOnSignin: false,
        },
      },
    });
  }

  const bots = c.recaptchaConfig?.emailPasswordEnforcementState;
  if (bots !== "AUDIT" && bots !== "ENFORCE") {
    out.push({
      id: "recaptcha",
      what: "reCAPTCHA bot protection for passwords is off",
      fix: "reCAPTCHA bot protection for passwords in audit mode (it records, blocks nothing)",
      level: "warn",
      batch: "bots",
      mask: "recaptchaConfig.emailPasswordEnforcementState",
      body: { recaptchaConfig: { emailPasswordEnforcementState: "AUDIT" } },
    });
  }
  if (!isPlainFirebaseAuth(c) && c.monitoring?.requestLogging?.enabled !== true) {
    out.push({
      id: "logging",
      what: "Identity Platform's request logging is off (the sign-up alert counts it)",
      fix: "request logging on (the sign-up alert counts it; Cloud Logging bills past its free monthly allowance)",
      level: "warn",
      batch: "logging",
      mask: "monitoring.requestLogging.enabled",
      body: { monitoring: { requestLogging: { enabled: true } } },
    });
  }
  if (appUrl) {
    const want = `${appUrl.replace(/\/+$/, "")}${RESET_PATH}`;
    const now = c.notification?.sendEmail?.callbackUri ?? "";
    if (now !== want) {
      out.push({
        id: "reset-link",
        what: `password reset links open ${now || "Firebase's own page"}, not ${want}`,
        fix: `password reset links open ${want}`,
        level: "info",
        batch: "reset",
        mask: "notification.sendEmail.callbackUri",
        body: { notification: { sendEmail: { callbackUri: want } } },
      });
    }
  }
  if (email.enabled !== true) {
    out.push({
      id: "provider",
      what: "the Email/Password provider is off",
      fix: "the Email/Password provider on",
      level: "fail",
      batch: "provider",
      mask: "signIn.email.enabled",
      body: { signIn: { email: { enabled: true } } },
    });
  }
  return out;
}

/** The PATCH batches, in the order they are sent. The provider goes last and alone. */
const PATCH_ORDER = [
  { batch: "accounts", label: "account rules", soft: false },
  { batch: "policy", label: "password policy", soft: false },
  { batch: "bots", label: "reCAPTCHA bot protection", soft: false },
  { batch: "logging", label: "request logging", soft: false },
  { batch: "reset", label: "reset link address", soft: true },
  { batch: "provider", label: "Email/Password provider", soft: false },
];

function deepMerge(a, b) {
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) {
    out[k] = v && typeof v === "object" && !Array.isArray(v) && out[k] && typeof out[k] === "object" ? deepMerge(out[k], v) : v;
  }
  return out;
}

/**
 * The PATCHes that turn a diff into the wanted config: small batches, each with an explicit
 * updateMask, so every protection is on before the provider is. `soft` means a refusal is a
 * warning, not a failure (the reset link: some projects refuse template changes).
 * @param {PasswordDiff[]} diff
 * @returns {{ label: string, soft: boolean, mask: string, body: Record<string, unknown>, items: PasswordDiff[] }[]}
 */
export function passwordPatchPlan(diff) {
  return PATCH_ORDER.map((p) => {
    const items = diff.filter((d) => d.batch === p.batch);
    return {
      label: p.label,
      soft: p.soft,
      mask: items.map((d) => d.mask).join(","),
      body: items.reduce((acc, d) => deepMerge(acc, d.body), {}),
      items,
    };
  }).filter((p) => p.items.length);
}

/** More password sign-ups than this in an hour raises the sign-up alert. */
export const SIGNUP_ALERT_PER_HOUR = 20;

/**
 * Wrong codes one address can type in a day before the app locks its codes and logs
 * auth_code_locked. Must match EMAIL_CODE_WRONG_PER_DAY in src/lib/tenant/emailCodes.ts.
 */
export const CODE_LOCK_WRONG_PER_DAY = 15;

/**
 * The three log based metrics the sign-in alerts count, in the order of authAlertPolicies().
 * Each filter names its resource type: Cloud Monitoring needs one to alert on a log based metric.
 * `appEvent` is the `event` field of the app's own structured log line. `needsIdentityPlatform`
 * marks a metric that counts Identity Platform's request logs, which plain Firebase
 * Authentication doesn't write.
 */
export const AUTH_LOG_METRICS = [
  {
    name: "yougrow_auth_signups",
    resourceType: "identitytoolkit_project",
    needsIdentityPlatform: true,
    description: "Password sign-ups at Identity Platform (needs its request logging on). Made by npm run selfhost, addon:password.",
    filter:
      'resource.type="identitytoolkit_project" AND (jsonPayload.methodName="google.cloud.identitytoolkit.v1.AuthenticationService.SignUp" OR protoPayload.methodName="google.cloud.identitytoolkit.v1.AuthenticationService.SignUp")',
  },
  {
    name: "yougrow_auth_accounts_removed",
    resourceType: "cloud_run_revision",
    appEvent: "auth_account_removed",
    description: "Accounts the app removed at the sign-in door (a first sign-in it could not trust). Made by npm run selfhost, addon:password.",
    filter: 'resource.type="cloud_run_revision" AND jsonPayload.event="auth_account_removed"',
  },
  {
    name: "yougrow_auth_codes_locked",
    resourceType: "cloud_run_revision",
    appEvent: "auth_code_locked",
    description: `Addresses whose sign-in codes the app locked after ${CODE_LOCK_WRONG_PER_DAY} wrong codes in a day. Made by npm run selfhost, addon:password.`,
    filter: 'resource.type="cloud_run_revision" AND jsonPayload.event="auth_code_locked"',
  },
];

/**
 * The log metrics a project can have: all of them on Identity Platform, those that don't count
 * its request logs on plain Firebase Authentication.
 * @param {boolean} [identityPlatform]
 */
export function authLogMetricsFor(identityPlatform = true) {
  return AUTH_LOG_METRICS.filter((m) => identityPlatform || !m.needsIdentityPlatform);
}

/**
 * The alert policies a project can have, as authLogMetricsFor picks their metrics.
 * @param {string[]} [channels]
 * @param {boolean} [identityPlatform]
 */
export function authAlertPoliciesFor(channels = [], identityPlatform = true) {
  return authAlertPolicies(channels).filter((_, i) => identityPlatform || !AUTH_LOG_METRICS[i]?.needsIdentityPlatform);
}

/** A log metric's create body: a plain counter. */
export function logMetricBody(metric) {
  return {
    name: metric.name,
    description: metric.description,
    filter: metric.filter,
    metricDescriptor: { metricKind: "DELTA", valueType: "INT64", unit: "1" },
  };
}

/**
 * The three alert policies, by display name. Each counts its log metric over an hour. A condition
 * on a log based metric names the resource type, and evaluationMissingData needs a non-zero
 * duration, so both are set.
 * @param {string[]} channels notification channel names (projects/<id>/notificationChannels/<n>)
 */
export function authAlertPolicies(channels = []) {
  const condition = (metric, displayName, threshold) => ({
    displayName,
    conditionThreshold: {
      filter: `metric.type="logging.googleapis.com/user/${metric.name}" AND resource.type="${metric.resourceType}"`,
      aggregations: [{ alignmentPeriod: "3600s", perSeriesAligner: "ALIGN_SUM", crossSeriesReducer: "REDUCE_SUM" }],
      comparison: "COMPARISON_GT",
      thresholdValue: threshold,
      duration: "60s",
      trigger: { count: 1 },
      evaluationMissingData: "EVALUATION_MISSING_DATA_INACTIVE",
    },
  });
  const [signups, removed, locked] = AUTH_LOG_METRICS;
  return [
    {
      displayName: "YouGrow: many password sign-ups",
      documentation: {
        mimeType: "text/markdown",
        content: [
          `More than ${SIGNUP_ALERT_PER_HOUR} password sign-ups reached Identity Platform in an hour.`,
          "Only addresses on ADMIN_ALLOWED_EMAILS can get in, so a burst usually means someone is scripting sign-ups.",
          "Check Logs Explorer (resource Identity Toolkit Project, method SignUp) for where they come from.",
          "Unconfirmed accounts are removed after 7 days once PASSWORD_CLEANUP_DELETE_ENABLED is on.",
          "If it keeps happening, set reCAPTCHA bot protection for passwords to ENFORCE.",
        ].join(" "),
      },
      userLabels: { app: "yougrow", feature: "password-signin" },
      combiner: "OR",
      conditions: [condition(signups, `More than ${SIGNUP_ALERT_PER_HOUR} password sign-ups in an hour`, SIGNUP_ALERT_PER_HOUR)],
      alertStrategy: { autoClose: "86400s" },
      notificationChannels: channels,
    },
    {
      displayName: "YouGrow: accounts removed at sign-in",
      documentation: {
        mimeType: "text/markdown",
        content: [
          "The app removed at least one account on its first sign-in, because it couldn't trust it:",
          "the address wasn't confirmed by its code, or the account had been changed before it first signed in.",
          "The person sees Please sign in again and loses nothing.",
          "One now and then is normal. Several in an hour can mean someone is creating accounts with other people's addresses:",
          'check Logs Explorer for jsonPayload.event="auth_account_removed", which gives the address\'s domain only.',
        ].join(" "),
      },
      userLabels: { app: "yougrow", feature: "password-signin" },
      combiner: "OR",
      conditions: [condition(removed, "An account removed at sign-in in the last hour", 0)],
      alertStrategy: { autoClose: "86400s" },
      notificationChannels: channels,
    },
    {
      displayName: "YouGrow: sign-in codes locked",
      documentation: {
        mimeType: "text/markdown",
        content: [
          `At least one address had ${CODE_LOCK_WRONG_PER_DAY} wrong sign-in codes in a day, so the app locked its codes: it gets no new code and no check until a day has passed.`,
          "That usually means someone is guessing codes for it, since anyone who creates a password account with an address can ask for its codes.",
          "The person who owns the address can still confirm it: the code screen offers Email me a link instead, and the link needs no code.",
          'Check Logs Explorer for jsonPayload.event="auth_code_locked", which gives the address\'s domain only.',
        ].join(" "),
      },
      userLabels: { app: "yougrow", feature: "password-signin" },
      combiner: "OR",
      conditions: [condition(locked, "Sign-in codes locked for an address in the last hour", 0)],
      alertStrategy: { autoClose: "86400s" },
      notificationChannels: channels,
    },
  ];
}
