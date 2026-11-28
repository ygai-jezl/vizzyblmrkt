/**
 * The switches of the learning loops (src/lib/loops/registry.ts): one per loop that learns for a
 * brand. A `learns(...)` line names one of these keys, so Loop.switch can only be a switch listed
 * here.
 *
 * Each entry is one exact `=== "true"` read of its own variable, written out in full in this file
 * so the switch scan (scripts/config/feature-switches.mjs) finds it, and the variable is listed
 * with value "false" in apphosting.yaml and left empty in .env.example (the add-a-switch skill).
 * It is a new variable, never one of the switches from before the loops
 * (testing/switchesBeforeLoops.ts), and no other file reads it, so each loop turns on and off on
 * its own. src/lib/loops/registry.test.ts checks each of these.
 *
 * A feature reads its loop's switch through its own flags file, which adds the switches the loop
 * needs (isImageStyleVersionsOn in src/lib/content/imageStyle/flags.ts). Pure and client safe.
 */
export const LOOP_SWITCHES = {
  /** Image style versions (learning loops step 4): looks learned from votes kept as versions in the brand's region. */
  IMAGE_STYLE_VERSIONS_ENABLED: () => process.env.IMAGE_STYLE_VERSIONS_ENABLED === "true",
} as const satisfies Record<string, () => boolean>;

export type LoopSwitch = keyof typeof LOOP_SWITCHES;
