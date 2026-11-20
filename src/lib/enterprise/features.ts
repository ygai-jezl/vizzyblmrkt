/**
 * The Enterprise features: the parts of YouGrow that run only with an Enterprise licence key.
 * Everything else is open.
 *
 * The ids are written into licence keys, so renaming one means reissuing every key that lists
 * it. Add new ids at the end. The labels are what people read (the public list of what is open
 * and what is Enterprise), so they follow src/lib/content/writingRules.ts.
 *
 * No imports, so pages and client components can use this file.
 */
export const ENTERPRISE_FEATURES = [
  { id: "sso", label: "Single sign-on" },
  { id: "scim", label: "User provisioning (SCIM)" },
  { id: "field_access", label: "Field level access" },
  { id: "record_access", label: "Record level access" },
  { id: "audit_export", label: "Audit log export" },
  { id: "audit_retention", label: "Long audit log retention" },
  { id: "retention_rules", label: "Retention rules" },
  { id: "legal_hold", label: "Legal hold" },
] as const;

export type EnterpriseFeature = (typeof ENTERPRISE_FEATURES)[number]["id"];

/** The ids, in list order. */
export const ENTERPRISE_FEATURE_IDS: readonly EnterpriseFeature[] = ENTERPRISE_FEATURES.map((f) => f.id);

export function isEnterpriseFeature(x: unknown): x is EnterpriseFeature {
  return typeof x === "string" && (ENTERPRISE_FEATURE_IDS as readonly string[]).includes(x);
}

/** The label people read for a feature. */
export function enterpriseFeatureLabel(feature: EnterpriseFeature): string {
  return ENTERPRISE_FEATURES.find((f) => f.id === feature)?.label ?? feature;
}

/**
 * What only the hosted service offers. These are not in the open code and no licence key turns
 * them on, so they have no feature id.
 */
export const HOSTED_ONLY = ["Marketplace", "Partner routing", "Capital network", "Included AI"] as const;
