import type { ViewRun } from "@/lib/views/backend";
import type { ShownView } from "@/lib/views/savedViews";
import type { ViewRow } from "@/lib/views/source";
import type { ViewDefinition } from "@/lib/views/types";
import type { ViewScope } from "@/lib/types/savedView";
import { api } from "../connect/api";

/** The views screens' calls (CRM_VIEWS_ENABLED). Messages are in src/lib/views/words.ts. */

export type { ShownView, ViewRow };
export type RunAnswer = ViewRun & { rows: ViewRow[] };
export interface ViewLists {
  team: ShownView[];
  archived: ShownView[];
  mine: ShownView[];
  canSaveTeam: boolean;
  /** Product groups the views filter on, by value, with their names. */
  groups?: Array<{ id: string; label: string }>;
}
type Saved = { view: ShownView; message: string; error?: string; filters?: number[] };

const post = (body: unknown) => ({ method: "POST", body: JSON.stringify(body) });

export const runView = (definition: ViewDefinition, q: string) => api<RunAnswer & { error?: string }>("/api/admin/views/run", post({ definition, ...(q ? { q } : {}) }));

export const viewRows = (ids: string[], columns: string[]) => api<{ rows: ViewRow[]; error?: string }>("/api/admin/views/rows", post({ ids, columns }));

export const listViews = () => api<ViewLists>("/api/admin/views");

export const saveView = (scope: ViewScope, name: string, definition: ViewDefinition) => api<Saved>("/api/admin/views", post({ scope, name, definition }));

const one = (id: string) => `/api/admin/views/${encodeURIComponent(id)}`;

export const changeView = (id: string, version: number, change: { name?: string; definition?: ViewDefinition }) =>
  api<Saved>(one(id), { method: "PATCH", body: JSON.stringify({ version, ...change }) });

export const bringBackView = (id: string, version: number) => api<Saved>(one(id), { method: "PATCH", body: JSON.stringify({ version, archived: false }) });

/** Archives a team view, or deletes an Only me view. */
export const removeView = (id: string, version: number) => api<Saved>(one(id), { method: "DELETE", body: JSON.stringify({ version }) });
