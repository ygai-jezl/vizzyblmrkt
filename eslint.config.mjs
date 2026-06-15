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
          paths: [
            { name: "firebase-admin", message: ISOLATION_MESSAGE },
            { name: "firebase/firestore", message: ISOLATION_MESSAGE },
            { name: "@google-cloud/firestore", message: ISOLATION_MESSAGE },
          ],
          patterns: [
            { group: ["firebase-admin/*"], message: ISOLATION_MESSAGE },
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
    ignores: [".next/**", "node_modules/**", "next-env.d.ts"],
  },
];

export default eslintConfig;
