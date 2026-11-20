import { dirname } from "path";
import { fileURLToPath } from "url";
import { FlatCompat } from "@eslint/eslintrc";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const compat = new FlatCompat({ baseDirectory: __dirname });

/**
 * Tenant-isolation guardrails.
 *
 * The #1 security control of this platform is that EVERY Firestore access is
 * tenant-scoped (see docs/ARCHITECTURE-AND-DELIVERY.md §4). Firestore Security
 * Rules do NOT protect server-side access, so isolation must be enforced in
 * application code. To make that impossible to bypass by accident, raw
 * Firestore access (`.collection()` / `.collectionGroup()` and importing the
 * admin SDK) is BANNED everywhere except the sanctioned `src/lib/tenant/**`
 * data-access layer.
 */
const ISOLATION_MESSAGE =
  "Direct Firestore access is forbidden outside src/lib/tenant/**. Use the tenant-scoped repository (forTenant(ctx)) so every query is partitioned by tenantId. See docs/ARCHITECTURE-AND-DELIVERY.md §4.";

/**
 * The Enterprise boundary.
 *
 * Enterprise code lives in src/ee under its own licence, and the app must build and run without
 * that folder. So only src/lib/enterprise/registry.ts may import from it; everything else asks
 * the registry whether a feature is licensed (ADR-0007 in docs/DECISIONS.md).
 *
 * import/no-restricted-paths (eslint-plugin-import, registered with the node and TypeScript
 * resolvers by eslint-config-next) sees import, export from, import() and require() in every
 * file in the repo. It is not in no-restricted-imports: the blocks below turn that rule off for
 * src/lib/tenant/** and scripts/diagnose-journey.ts, and it misses import() and require().
 * The rule skips a specifier it can't resolve (a file that doesn't exist yet), and the ignores
 * at the end leave out infra, agents and workers, so src/lib/enterprise/boundary.test.ts scans
 * the source for both.
 */
const ENTERPRISE_MESSAGE =
  "Only src/lib/enterprise/registry.ts may import from src/ee, so the app builds and runs without it. Ask the registry whether a feature is licensed. See ADR-0007 in docs/DECISIONS.md.";

const eslintConfig = [
  ...compat.extends("next/core-web-vitals", "next/typescript"),
  {
    rules: {
      // Allow underscore-prefixed discards and rest-sibling omissions
      // (used in the repository to strip caller-supplied tenantId/id).
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          ignoreRestSiblings: true,
        },
      ],
      "no-restricted-syntax": [
        "error",
        {
          // Dotted member Firestore APIs: db.collection(), .doc(), .batch(),
          // .runTransaction(), .getAll(), .collectionGroup().
          selector:
            "CallExpression[callee.type='MemberExpression'][callee.computed=false][callee.property.name=/^(collection|collectionGroup|doc|runTransaction|batch|getAll)$/]",
          message: ISOLATION_MESSAGE,
        },
        {
          // Computed member access: db['collection']('signups').
          selector:
            "CallExpression[callee.type='MemberExpression'][callee.computed=true][callee.property.value=/^(collection|collectionGroup|doc|runTransaction|batch|getAll)$/]",
          message: ISOLATION_MESSAGE,
        },
        {
          // Bare client-SDK functions: collection(db, path), getFirestore(), etc.
          selector:
            "CallExpression[callee.type='Identifier'][callee.name=/^(getFirestore|collection|collectionGroup|doc|getDoc|getDocs|setDoc|updateDoc|deleteDoc|addDoc|writeBatch|runTransaction)$/]",
          message: ISOLATION_MESSAGE,
        },
      ],
      "no-restricted-imports": [
        "error",
        {
          // The ban targets FIRESTORE access specifically. firebase-admin/auth
          // and firebase-admin/app (session cookies, token verification, claims)
          // are legitimately needed outside the tenant layer.
          paths: [
            { name: "firebase-admin", message: ISOLATION_MESSAGE },
            { name: "firebase-admin/firestore", message: ISOLATION_MESSAGE },
            { name: "firebase/firestore", message: ISOLATION_MESSAGE },
            { name: "@google-cloud/firestore", message: ISOLATION_MESSAGE },
          ],
          patterns: [
            { group: ["@google-cloud/firestore/*"], message: ISOLATION_MESSAGE },
          ],
        },
      ],
    },
  },
  {
    // The sanctioned data-access layer is the ONE place allowed to touch
    // Firestore directly. Everything it exposes is already tenant-scoped.
    files: ["src/lib/tenant/**/*.ts"],
    rules: {
      "no-restricted-syntax": "off",
      "no-restricted-imports": "off",
    },
  },
  {
    // A standalone, READ-ONLY ops diagnostic run by hand with the operator's own
    // credentials (`npx tsx scripts/diagnose-journey.ts <email>`). It deliberately
    // imports nothing from src/ and reads across tenants and projects to trace
    // one recipient, so it can't go through forTenant(ctx). Scoped to this one
    // file: every other script still goes through the tenant layer.
    files: ["scripts/diagnose-journey.ts"],
    rules: {
      "no-restricted-syntax": "off",
      "no-restricted-imports": "off",
    },
  },
  {
    // The Enterprise boundary (ENTERPRISE_MESSAGE above), over every code file in the repo.
    files: ["**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}"],
    ignores: ["src/ee/**", "src/lib/enterprise/registry.ts"],
    rules: {
      "import/no-restricted-paths": [
        "error",
        {
          basePath: __dirname,
          zones: [{ target: "./", from: "./src/ee", message: ENTERPRISE_MESSAGE }],
        },
      ],
    },
  },
  {
    // infra/** holds standalone Cloud Functions (CommonJS, own runtime); agents/**
    // is the Python ADK agent + its .venv (bundled JS); workers/** is the isolated
    // knowledge-scraper Cloud Run Job package (own build + node_modules, and the
    // ONE place outside the app that legitimately uses firebase-admin directly —
    // it has no TenantContext, so it stamps tenantId on every write itself). None
    // is part of the Next app's lint scope.
    ignores: [
      ".next/**",
      "node_modules/**",
      "next-env.d.ts",
      "infra/**",
      "agents/**",
      "workers/**",
      // The SDK's build output (its CommonJS half uses require()); the sources are linted.
      "sdk/node/dist/**",
    ],
  },
];

export default eslintConfig;
