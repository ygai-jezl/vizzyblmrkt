import { stageById } from "./stages";
import { isClosedStatus, type WorkStatus, type WorkTask } from "./types";

/**
 * Work's service (ADR-0018). The rules here are the two choices Work makes for a team, each with
 * its line in src/lib/loops/registry.ts:
 * - work_check_due: a check shows once it is due. A person sets the date, the task to wait for or
 *   the measure; the rule only decides that the time has come.
 * - work_ready: which To do tasks are ready to start, and in what order Review shows them. People
 *   pick which to start; the pick is a change row, so a later learner can read it.
 */

/** What the rules know about another task: its status, "gone" when it no longer exists, or undefined when it couldn't be read. */
export type TaskLookup = (taskId: string) => WorkStatus | "gone" | undefined;

const finished = (s: WorkStatus | "gone" | undefined): boolean => s === "gone" || (s !== undefined && isClosedStatus(s));

/**
 * A task's check is due (work_check_due): a date check once its time has come; an after_task
 * check once the task it waits for is Done, Dropped or gone. A task that couldn't be read keeps
 * the check waiting, so a region that didn't answer never makes one due.
 */
export function isCheckDue(task: Pick<WorkTask, "check">, now: Date, lookup: TaskLookup = () => undefined): boolean {
  const c = task.check;
  if (!c) return false;
  if (c.kind === "date") return c.at !== null && Date.parse(c.at) <= now.getTime();
  return c.taskId !== null && finished(lookup(c.taskId));
}

/**
 * A task is ready to start (work_ready): To do, every task blocking it Done, Dropped or gone,
 * waiting on nothing, and no check still to come (a check not due yet parks the task until then).
 */
export function isReadyToStart(task: Pick<WorkTask, "status" | "blockedBy" | "waitingOn" | "check">, now: Date, lookup: TaskLookup = () => undefined): boolean {
  if (task.status !== "todo" || task.waitingOn) return false;
  if (!task.blockedBy.every((id) => finished(lookup(id)))) return false;
  return !task.check || isCheckDue(task, now, lookup);
}

/** The order Review shows ready tasks in: Must have first, then the earlier stage (none last), then the lower ref. */
export function readyOrder(a: Pick<WorkTask, "mustHave" | "stage" | "ref">, b: Pick<WorkTask, "mustHave" | "stage" | "ref">): number {
  if (a.mustHave !== b.mustHave) return a.mustHave ? -1 : 1;
  const sa = a.stage ? stageById(a.stage)!.n : 99;
  const sb = b.stage ? stageById(b.stage)!.n : 99;
  return sa - sb || a.ref - b.ref;
}
