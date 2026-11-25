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
