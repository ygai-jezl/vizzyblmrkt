import type { ConnectionCatalog } from "./productConnection";

/**
 * One saved version of a connection's catalog (regional `catalog_revisions`),
 * kept so a change can be seen and undone. Every version is kept
 * (src/lib/connect/catalogHistory.ts).
 */
export type CatalogRevisionSource =
  /** Saved on the Catalog tab. */
  | "editor"
  /** Added from Learn from repo. */
  | "learn"
  /** An earlier version, restored. */
  | "restore"
  /** The catalog as it was before history was kept. */
  | "before_history";

export interface CatalogRevision {
  id: string;
  tenantId: string;
  connectionId: string;
  /** The connection's catalogRev once this version was saved. */
  rev: number;
  catalog: ConnectionCatalog;
  savedAt: string;
  /**
   * Who saved it, as a user id; null when unknown. Versions saved before 2026-11 held an address
   * here until scripts/scrub-catalog-savers.ts replaced it with the user id, or null.
   */
  savedBy: string | null;
  source: CatalogRevisionSource;
  /** For a restore: the version it brought back. */
  restoredFrom?: number | null;
  /** What changed from the version before, in plain words ("Added step ‘Invite your team’"). */
  changes: string[];
}
