/**
 * Work (ADR-0020): one list of tasks across the organisation's brands and regions, and a daily
 * log. Off = nothing changes: no Work in the sidebar or ⌘K, no Work sections in Review, and the
 * Work pages and routes answer 404. Server only: the admin layout reads it and passes the answer
 * down, so changing it needs no new build.
 *
 * What Work keeps on its own (a take up of an empty organisation id erasing its leftover Work, and
 * a brand move taking its tasks along) runs whatever this says, as connectors' housekeeping does.
 */
export function isWorkEnabled(): boolean {
  return process.env.WORK_ENABLED === "true";
}

/**
 * Vizzy's Work tools (get_work, suggest_work_task, draft_work_log, draft_work_decision) and the Ask
 * Vizzy starters on Work. Needs WORK_ENABLED, and a Vizzy deploy with the tools. Off, the agent
 * route answers that Work isn't switched on.
 */
export function isWorkVizzyEnabled(): boolean {
  return isWorkEnabled() && process.env.WORK_VIZZY_ENABLED === "true";
}

/**
 * Quick edit on Work's list: click a task's row and it opens in place, under itself, with
 * everything its page has (`?open=<ref>`), and changes save one after another. Needs WORK_ENABLED.
 * Off, the list is today's: the title links to the task's page and `?open` is ignored. Server only.
 */
export function isWorkQuickEditEnabled(): boolean {
  return isWorkEnabled() && process.env.WORK_QUICK_EDIT_ENABLED === "true";
}
