import { hasOptions, type RecordField } from "@/lib/types/recordField";
import { reasonOf, type RaiseArea } from "@/lib/raise/reasons";
import { FIELD_PRESET_KEYS, FUNDING_ONLY, RAISING_ONLY, stageRole, type FieldPresetKey, type RaiseKit, type StageRole } from "./presets";

/**
 * The board's fields, found in a brand's People field list by their ready-made markers only
 * (`preset`, set by Set up for raising or funding), never by label: a team can rename "Stage" to
 * "Pipeline" and the board still finds it. Archived fields are ignored, and the first live field
 * with a preset wins. Pure and client safe.
 */

export interface StageOption {
  optionId: string;
  label: string;
  preset: string | null;
  role: StageRole;
  archived: boolean;
}

export interface ReasonOption {
  optionId: string;
  label: string;
  /** The fixed reason key, or null for the team's own reason. */
  key: string | null;
  /** The chip it sits under: a team's own reason sits under Other. */
  area: RaiseArea;
  archived: boolean;
}

export interface RaiseFields {
  /** The live field bound to each preset. */
  byPreset: Partial<Record<FieldPresetKey, RecordField>>;
  /** Stage, when it is bound and picks from options; null means no board. */
  stage: { field: RecordField; options: StageOption[] } | null;
  passReason: { field: RecordField; options: ReasonOption[] } | null;
  /** Which kits the Stage holds: raising when it has a raising stage, funding when it has a funding one. */
  kinds: RaiseKit[];
  /** The board can be drawn: Stage is bound. */
  setUp: boolean;
}

/** The kits a Stage field's live options belong to. */
export function kindsOf(options: readonly Pick<StageOption, "preset" | "archived">[]): RaiseKit[] {
  const live = options.filter((o) => !o.archived && o.preset);
  const out: RaiseKit[] = [];
  if (live.some((o) => RAISING_ONLY.has(o.preset!))) out.push("raising");
  if (live.some((o) => FUNDING_ONLY.has(o.preset!))) out.push("funding");
  return out;
}

/** The fields bound to the board's presets, with Stage's options and roles and Pass reason's keys. */
export function raiseFieldsOf(items: readonly RecordField[]): RaiseFields {
  const byPreset: Partial<Record<FieldPresetKey, RecordField>> = {};
  const known = new Set<string>(FIELD_PRESET_KEYS);
  for (const f of items) {
    const p = (f as { preset?: unknown }).preset;
    if (f.archivedAt || f.object !== "person" || typeof p !== "string" || !known.has(p)) continue;
    if (!byPreset[p as FieldPresetKey]) byPreset[p as FieldPresetKey] = f;
  }
  const stageField = byPreset["raise.stage"];
  const stage =
    stageField && hasOptions(stageField.type) && stageField.type !== "multi_select"
      ? {
          field: stageField,
          options: (stageField.options ?? []).map((o) => {
            const preset = typeof o.preset === "string" ? o.preset : null;
            return { optionId: o.id, label: o.label, preset, role: stageRole(preset), archived: !!o.archivedAt };
          }),
        }
      : null;
  const reasonField = byPreset["raise.pass_reason"];
  const passReason =
    reasonField && hasOptions(reasonField.type)
      ? {
          field: reasonField,
          options: (reasonField.options ?? []).map((o) => {
            const r = reasonOf(typeof o.preset === "string" ? o.preset : null);
            return { optionId: o.id, label: o.label, key: r?.key ?? null, area: r?.area ?? ("other" as const), archived: !!o.archivedAt };
          }),
        }
      : null;
  return { byPreset, stage, passReason, kinds: stage ? kindsOf(stage.options) : [], setUp: !!stage };
}

/** Whether a list is set up for the board: it has a bound Stage. */
export function isSetUp(items: readonly RecordField[]): boolean {
  return raiseFieldsOf(items).setUp;
}

/** The board's name: Funding when only the funding kit is there, else Investors. */
export function boardKind(kinds: readonly RaiseKit[]): RaiseKit {
  return kinds.includes("funding") && !kinds.includes("raising") ? "funding" : "raising";
}
