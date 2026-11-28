/**
 * The learning loops' platform switch (learning loops step 5): everything YouGrow makes is stamped
 * with what made it and counted, the loops lane widens to every kind, a weekly heartbeat counts
 * organisations across brands (`fleet_cells`, never images, words or people), and Settings › Loops
 * shows those counts to the people LOOPS_OPERATOR_EMAILS names (./operators.ts).
 *
 * It is not one loop's own switch, so it is not in LOOP_SWITCHES (./switches.ts) and no learns
 * line can name it. Image learning has its own, IMAGE_STYLE_VERSIONS_ENABLED, which image kinds
 * follow alone.
 *
 * Off is today exactly (decision 22 of the plan for steps 4 and 5): for any kind that isn't an
 * image kind, learnedFor reads nothing and hands back an empty block with
 * `{ unstamped: "loops_off" }`, countSignal does nothing, and nothing is counted across brands.
 * Server only: it reads process.env, and pages pass the answer down.
 */
export function isLoopsEnabled(): boolean {
  return process.env.LOOPS_ENABLED === "true";
}
