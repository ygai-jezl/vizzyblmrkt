/**
 * The switches of the learning loops (src/lib/loops/registry.ts): one per loop that learns for a
 * brand. A `learns(...)` line names one of these keys, so Loop.switch can only be a switch listed
 * here.
 *
 * Each future entry is one exact `=== "true"` read of its own variable, written out in full in this
 * file so the switch scan (scripts/config/feature-switches.mjs) finds it, and the variable is
 * listed with value "false" in apphosting.yaml and left empty in .env.example (the add-a-switch
 * skill). No other file reads it, so each loop turns on and off on its own.
 * src/lib/loops/registry.test.ts checks all three.
 *
 * Empty for now: nothing learns through the loops yet, so LoopSwitch is never and no line in
 * LOOPS can use `learns(...)`. The first entry comes with the image style loop.
 */
export const LOOP_SWITCHES = {} as const satisfies Record<string, () => boolean>;

export type LoopSwitch = keyof typeof LOOP_SWITCHES;
