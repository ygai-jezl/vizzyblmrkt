import { H1, H2, H3, Lead, P, UL } from "@/components/developers/Doc";
import { BeforeAndUnlocks, Checks, Messages, Meta, NextPage, Open, Steps } from "@/components/help/blocks";
import { isIdeaWordsEnabled } from "@/lib/ideas/flags";
import { ideaWord } from "@/lib/nav/terms";
import { isWorkVizzyEnabled } from "@/lib/work/flags";
import { DRAFT_COPY } from "@/lib/work/draft";
import { IMPORT_COLUMNS, MEASURE_KIND_HINT, WORK_COPY } from "@/lib/work/screenWords";
import { COMPANY_STAGES } from "@/lib/work/stages";
import { DECLINE_WHY_CHOICES } from "@/lib/work/suggestion";
import { countedLine, WORK_MESSAGES } from "@/lib/work/words";
import type { HelpBodyProps } from "@/lib/help/pages";

/**
 * /help/work (WORK_ENABLED, ADR-0018): Work's Tasks and Log, a task's links, decisions and How we'll
 * know it worked, checks, import, and Work in Review. The lines about Vizzy suggesting tasks and
 * drafting Log notes and decisions show while Vizzy's Work tools are on (WORK_VIZZY_ENABLED, a server
 * switch: the How to drawer passes the shell's answer). "Make it an idea" is in the words people
 * read (ideaWords). Every business named is made up, and the words it quotes are the app's own.
 */

const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

/** The ten stages, as the list and the add page name them: "1 Idea, 2 Test, ... and 10 Improve". */
const STAGES = (() => {
  const all = COMPANY_STAGES.map((s) => `${s.n} ${s.label}`);
  return `${all.slice(0, -1).join(", ")} and ${all[all.length - 1]}`;
})();

/** What a measure's check says Work counted, in the check's own words, for a made-up note app. */
const COUNTED = countedLine({
  part: { kind: "used", counts: { productEvent: { connectionId: "pc_example", event: "note_from_template" } }, look: { days: 14 } },
  counted: { n: 212, from: "2026-11-11T08:00:00.000Z", to: "2026-11-25T08:00:00.000Z", at: "2026-11-25T08:00:00.000Z" },
  brandName: "Lumen Notes",
  timeZone: "Europe/London",
});

/** What it says when Work can't count the number, for a made-up plant shop. */
const CANT_COUNT = countedLine({
  part: { kind: "moves", meaning: "conversions", direction: "up", word: "Orders", look: { days: 30 } },
  counted: null,
  brandName: "Fernhill Plants",
  timeZone: "Europe/London",
});

export default function WorkHelp({ workVizzy = isWorkVizzyEnabled(), ideaWords = isIdeaWordsEnabled() }: HelpBodyProps = {}) {
  const word = ideaWord(ideaWords);
  const reasons = DECLINE_WHY_CHOICES.map((r) => r.label);
  return (
    <article>
      <H1>Work</H1>
      <Lead>
        One list of everything your business has to do, at every stage and across your brands, and a log of what got done each
        day. Each task keeps who added it, every change, the decisions made on it and how you&apos;ll know it worked.
      </Lead>
      <Meta items={["About 5 minutes", "Everyone on the team", "Every day"]} />

      <BeforeAndUnlocks
        before={
          <>
            <li>Work turned on in your copy of YouGrow</li>
            <li>
              For pull request and switch links: a repo connected in <Open href="/help/connected-accounts#github">Connected accounts</Open>
            </li>
            <li>
              For a count of how much something is used: your product connected, sending its events (
              <Open href="/help/connect-your-product">Connect your product</Open>)
            </li>
          </>
        }
        unlocks={
          <>
            <li>One list for the whole business, from registering it to whatever comes next</li>
            <li>A log of each day that carries your workstreams over until they&apos;re done</li>
            <li>Checks in Review on the day they fall due, asking if a task worked</li>
            {workVizzy ? <li>Tasks Vizzy suggests from your log, your numbers and your stage, waiting in Review</li> : null}
          </>
        }
      />

      <H2 id="tasks">Your tasks</H2>
      <P>
        Open <Open href="/admin/work">Work</Open> in the sidebar, under Ask Vizzy. The <strong>Tasks</strong> tab is one list of
        every task you can see, across your organisation&apos;s brands and the regions they keep their data in. A plant shop
        such as Fernhill Plants might list Register the business, Buy the domain and Van insurance; a note app such as Lumen
        Notes, SOC 2 and a new pricing page.
      </P>
      <Steps>
        <li>
          Press <strong>Add task</strong>, type what needs doing, pick a stage if you like, and press <strong>Add</strong>. It
          takes the next number for your organisation, such as #81.
        </li>
        <li>
          For everything else, press <strong>Open the full form</strong> (or go to <Open href="/admin/work/new">New task</Open>):
          a description and notes, the stage, the brand, <strong>Must have</strong>, Connected to and Other links, what it waits
          for, a check and How we&apos;ll know it worked. Press <strong>Add task</strong>.
        </li>
        <li>Open a task from the list to see its own page. All tasks takes you back.</li>
      </Steps>
      <UL>
        <li>
          <strong>Status</strong>: To do, In progress, Waiting, Done or Dropped. &quot;Waiting on #75&quot; and &quot;Now{" "}
          {word.a}&quot; are chips Work works out from what the task waits for and its {word.one}, not statuses.
        </li>
        <li>
          <strong>Must have</strong>: it has to happen before you go live. Must haves sit near the top of the list, and have a
          filter of their own.
        </li>
        <li>
          <strong>Stage</strong>, optional: {STAGES}, the stages of the Path.
        </li>
        <li>
          <strong>Blocked by</strong>: up to 5 tasks it waits for. While one is open, the task shows Waiting on it. Once they are
          all done, a To do task shows in Review under Ready to start.
        </li>
        <li>
          On a task&apos;s page you change the title, description and notes where they are. A command in the description written
          between backticks gets a <strong>Copy</strong> button.
        </li>
        <li>
          The line under the title says where the task came from, such as &quot;Added by you on 18 Nov.&quot; or &quot;Imported
          from Backlog.csv by you on 2 Nov, row 4.&quot; <strong>History</strong> lists every change, newest first, with who made
          it and the value before and after.
        </li>
        <li>
          <strong>Make it {word.a}</strong>, in the side panel under {word.One}, opens New {word.one} with the task&apos;s title
          filled in, and links the task to it once it is made. It is there on tasks for the brand you are in, and on whole
          business tasks.
        </li>
        <li>
          Admins and owners can press <strong>Delete task</strong>. Its history stays in the Log.
        </li>
      </UL>
      <H3>Who sees which tasks</H3>
      <UL>
        <li>In an organisation with one brand, everyone on the team sees every task.</li>
        <li>
          With more than one brand, owners see every task in one list and filter it by brand. Everyone else sees the tasks tagged
          with their own brand. Tasks for the whole business are for owners, unless an owner tags a brand.
        </li>
        <li>
          Anyone on the team adds and edits tasks, writes in the Log, records decisions and answers checks. Admins and owners also
          import and delete.
        </li>
        <li>
          A task tagged with a brand is kept in the region that brand keeps its data in, and a whole business task in the region
          of the brand it was added from. Once it is added, its brand can change only to another brand in the same region.
        </li>
      </UL>

      <H2 id="filters">Filter the list</H2>
      <P>
        The filters sit above the list, and the page&apos;s address keeps them, so a link to the list opens it filtered the same
        way. {WORK_COPY.listOrder}
      </P>
      <UL>
        <li>
          <strong>Brand</strong>, with more than one brand: every brand, one of them, or Whole business.
        </li>
        <li>
          <strong>Stage</strong>: any stage, or one of the ten.
        </li>
        <li>
          <strong>Status</strong>: Open, which is where the list starts, one status, Done or dropped, or Any status.
        </li>
        <li>
          <strong>Kind of win</strong>: Used, Moves a number, Runs better, Done is the win, or No measure yet.
        </li>
        <li>
          <strong>Must have</strong> and <strong>Checks due</strong>, each with how many there are. <strong>Clear filters</strong>{" "}
          takes them all off.
        </li>
      </UL>
      <P>
        If a region your tasks are kept in doesn&apos;t answer, the list says which one, and shows the rest. Try again in a
        minute.
      </P>

      <H2 id="links">Connected to and other links</H2>
      <P>
        <strong>Connected to</strong> holds exact links that agents can follow, the join keys from a task to the work around it.
        Up to 10 on a task:
      </P>
      <UL>
        <li>
          <strong>Plan</strong>: a plan page for the task, with its title, an https link with no user name or password in it,
          and a version if it has one. Any business can add one, and approve it on the task (
          <Open href="/help/work#decisions">Approve the plan</Open>).
        </li>
        <li>
          <strong>Idea</strong>: another {word.one} this task touches, besides the one it was made into.
        </li>
        <li>
          <strong>Pull request</strong>: a repo your brand selected and the pull request&apos;s number. On a whole business
          task, a repo any of your brands selected.
        </li>
        <li>
          <strong>Switch</strong>: the switch&apos;s name as the code reads it, in capitals, digits and underscores. Or{" "}
          <strong>No switch</strong>, and why.
        </li>
      </UL>
      <P>
        Pull request and switch show only once a repo is connected, so a plant shop with no repo sees Idea and Plan. A fifth
        kind, <strong>Loop line</strong>, shows only to the people your copy of YouGrow names as running its own learning loop,
        on a task with a pull request from its own repo. Most teams never see it.
      </P>
      <P>
        <strong>Other links</strong> holds up to 20 more: an AI chat, a page or a doc, each with what it is if you like.
      </P>

      <H2 id="measure">How we&apos;ll know it worked</H2>
      <P>
        Optional on any task, on the add page or in the task&apos;s side panel. Pick one of four kinds of win:
      </P>
      <UL>
        <li>
          <strong>Used</strong>: {lowerFirst(MEASURE_KIND_HINT.used)} Work counts an event from the brand&apos;s connected product, such as
          note_from_template, looking within 90 days because events are kept 90 days. Or pick nothing to count, and your read is
          the record. A whole business task counts no event, unless your organisation has one brand.
        </li>
        <li>
          <strong>Moves a number</strong>: {lowerFirst(MEASURE_KIND_HINT.moves)} Pick one of YouGrow&apos;s numbers, such as open rate,
          click rate or search clicks, or conversions in your own word: sign ups, orders or bookings. It starts on up, or down for
          a number where lower is better, and you can change it. Never one provider&apos;s own number, and never a date.
        </li>
        <li>
          <strong>Runs better</strong>: {lowerFirst(MEASURE_KIND_HINT.runs_better)} Your read is the record.
        </li>
        <li>
          <strong>Done is the win</strong>: {lowerFirst(MEASURE_KIND_HINT.done)} For example registering the business, van insurance or
          SOC 2.
        </li>
      </UL>
      <UL>
        <li>
          <strong>When to look</strong>, for every kind but Done is the win: a number of days after it&apos;s done, from 1 to 365.
          On that day Work sets a check for 08:00 that asks: did it work? Or after 10, 20 or 40 outputs, the things it makes:
          Work can&apos;t count those yet, so that sets no check until it can.
        </li>
        <li>
          <strong>Add a then (optional)</strong> adds a second measure, because use comes first and the result follows: Used 14
          days after it&apos;s done, then Moves a number after 60. A then is never Done is the win, and looks later than the
          first.
        </li>
        <li>
          <strong>Suggested</strong> marks the kind Work suggests, with its reason, and you keep it or pick another. Set up,
          Billing and tax or legal work suggests Done is the win; a bug, crash, error, memory, security, cost or speed task, Runs
          better; a switch, Used; and a task for a brand or {word.a}, Moves a number. On a task from Vizzy it says <strong>Vizzy suggests</strong>.
          The suggested kind is kept beside the one you pick.
        </li>
      </UL>
      <H3>Did it work?</H3>
      <P>
        When a task with a measure moves to Done, Work sets its check that many days on, at 08:00 in the brand&apos;s time
        zone, in place of any check it had. On that day the task, Today and Review ask <strong>{WORK_COPY.measureDueTitle}</strong>,
        with what Work counted, or what it can&apos;t count:
      </P>
      <UL>
        <li>{COUNTED}</li>
        <li>
          When the product sent more than 2,000 events of any kind in that time, Work counts in the newest 2,000 and says
          &quot;at least&quot;, with the day they reach back to.
        </li>
        <li>{CANT_COUNT}</li>
      </UL>
      <Steps>
        <li>
          Press <strong>Better</strong>, <strong>Same</strong>, <strong>Worse</strong> or <strong>Too soon to tell</strong>.
        </li>
        <li>
          Better, Same or Worse is kept as your read. With a then, its check is set, at the then&apos;s days after Done, or today
          if that day has passed.
        </li>
        <li>Too soon to tell asks again 7 days on, at 08:00. Change the date on the task if another day suits better.</li>
      </Steps>
      <P>
        Only a measure&apos;s check takes a read. A check on a date or on another task has Mark checked and Look again tomorrow.
      </P>

      <H2 id="checks">Checks</H2>
      <P>
        A check says when to look at a task again. Set it on the add page, or with <strong>Add a check</strong> in the
        task&apos;s side panel:
      </P>
      <UL>
        <li>
          <strong>On a date</strong>: Tomorrow morning, Next week, In 2 weeks, or Pick a date. It is at 08:00 in the brand&apos;s
          time zone unless you change the time. Set the zone in <Open href="/admin/account/settings">Settings › General</Open>;
          until you do, it is UTC.
        </li>
        <li>
          <strong>When another task is done</strong>: the check falls due the day that task moves to Done.
        </li>
        <li>
          <strong>What to look at</strong>, if you like: a note the check shows when it falls due.
        </li>
        <li>
          A measure sets its own check when the task is done (<Open href="/help/work#measure">Did it work?</Open>).
        </li>
      </UL>
      <P>
        A check that is due shows amber on the list, under Checks due on Today, and in Review under Checks due today. The
        task&apos;s page says <strong>{WORK_COPY.checkDue}</strong> with its note. A done task stays on the Open list while its
        check is due.
      </P>
      <Steps>
        <li>
          On the task or on Today, press <strong>Mark checked</strong>, or <strong>Look again tomorrow</strong> to see it again
          at 08:00.
        </li>
        <li>
          In Review, press <strong>Done</strong>, <strong>Tomorrow</strong>, or <strong>Open</strong> to open the task.
        </li>
      </Steps>

      <H2 id="decisions">Decisions</H2>
      <P>When a task has a choice to make, record it under Decisions on the task&apos;s page.</P>
      <Steps>
        <li>
          Press <strong>Record a decision</strong>.
        </li>
        <li>Type the question, such as Which supplier first?, give 2 to 4 options, and pick the one you chose.</li>
        <li>
          Add why if you like, then press <strong>Save the decision</strong>.
        </li>
      </Steps>
      <UL>
        <li>
          Decisions are kept newest first, with who chose and when. <strong>Change the pick</strong> adds a new decision, and the
          first one stays, marked Changed later.
        </li>
        <li>A decision someone recommended shows the pick and why, and says whether you agreed or overruled it.</li>
        <li>A task keeps up to 50 decisions. Today lists the ones made that day.</li>
      </UL>
      <H3>Approve the plan</H3>
      <Steps>
        <li>
          Under Connected to, find the plan and press <strong>Approve the plan</strong>.
        </li>
        <li>
          Pick <strong>Approve</strong>, <strong>Change it</strong> or <strong>Not now</strong>, with why if you like.
        </li>
      </Steps>
      <UL>
        <li>{WORK_COPY.planNoRecommendation} Vizzy never drafts an approval.</li>
        <li>
          An approval covers that link and version only. Change the link or its version, and the plan shows Not approved yet until
          someone answers again.
        </li>
        <li>Each answer is a decision on the task, so Change it and then Approve keeps both.</li>
      </UL>

      <H2 id="log">The Log</H2>
      <P>
        Open the <Open href="/admin/work/log">Log</Open> tab. It opens on Today: what the team is on, what&apos;s due, what moved
        and what was decided.
      </P>
      <Steps>
        <li>In the box, type what you&apos;re on, such as Pricing page: copy done, check on mobile. One line per workstream.</li>
        <li>Pick its state, In progress, Done, Blocked or Waiting, and the task it is about, if there is one.</li>
        <li>
          Press <strong>Log it</strong>.
        </li>
      </Steps>
      <UL>
        <li>
          <strong>In flight</strong> lists each workstream still going, with its state and Day N. It carries over each day until
          you log it as done, so nobody types it again.
        </li>
        <li>
          <strong>Checks due</strong>, <strong>Tasks that moved</strong> and <strong>Decisions made</strong> fill in from the
          tasks as people work on them.
        </li>
        <li>
          <strong>Days</strong>, on the left, opens a past day. It is read only.
        </li>
        <li>
          A day is the brand&apos;s own day, in its time zone. The team logs up to 500 entries a day, and the Log is kept for as
          long as your organisation is, with no time limit.
        </li>
      </UL>

      <H2 id="import">Import your backlog</H2>
      <P>Admins and owners can bring a backlog in from a sheet, up to 1,000 rows at a time. Nothing is added until you import.</P>
      <Steps>
        <li>
          On Work, press <strong>Import</strong>. On a first visit, press <strong>Choose a CSV</strong> or{" "}
          <strong>Paste rows</strong>.
        </li>
        <li>
          Pick <strong>Upload a CSV</strong> and choose the file, or <strong>Paste from Google Sheets</strong> and paste your
          Backlog tab, header row first.
        </li>
        <li>With more than one brand, pick who the rows are for when the sheet has no Brand column.</li>
        <li>
          Press <strong>Preview</strong>. It shows each column of your sheet and the field it fills: change one that&apos;s
          matched wrong, or pick <strong>Skip this column</strong>. Below are the first 20 rows as they would come in.
        </li>
        <li>
          Press <strong>Import</strong> with the number of tasks, such as Import 12 tasks.
        </li>
      </Steps>
      <UL>
        <li>The columns it knows: {IMPORT_COLUMNS.join(", ")}.</li>
        <li>MVP marks a task Must have when it says yes, y, x or true.</li>
        <li>Ref keeps your numbers, and new tasks start after the highest. A row whose ref is taken is left out, with why.</li>
        <li>A status Work doesn&apos;t know comes in as To do, and the preview says which.</li>
        <li>Check takes a day, written as 2026-12-09, or a task to wait for, such as #75.</li>
        <li>A link in Clippings goes under Other links; other clipping text goes in the notes.</li>
        <li>Each task says where it came from, such as &quot;Imported from Backlog.csv by you on 2 Nov, row 4.&quot;</li>
      </UL>

      <H2 id="vizzy">Work in Review{workVizzy ? ", and Vizzy" : ""}</H2>
      <P>
        While Work is on, <Open href="/admin/approvals">Review</Open> has Work&apos;s sections, for everyone on the team, and its
        count includes them:
      </P>
      <UL>
        <li>
          <strong>Checks due today</strong>: a check on a date or another task has Done, Tomorrow and Open. A measure&apos;s check
          asks if it worked, with Better, Same, Worse, Too soon to tell and Open (<Open href="/help/work#checks">Checks</Open>).
        </li>
        <li>
          <strong>Ready to start</strong>: To do tasks with nothing in their way, Must haves first. <strong>Start</strong> moves
          one to In progress, and Work keeps which one you picked.
        </li>
        {workVizzy ? (
          <li>
            <strong>Tasks Vizzy suggests</strong>: tasks Vizzy suggested in chat. Nothing goes on the list until someone adds it.
          </li>
        ) : null}
      </UL>
      {workVizzy ? (
        <>
          <P>
            Ask Vizzy &quot;Suggest next tasks&quot; or &quot;What should I check today?&quot;. Vizzy reads your tasks, the Log
            and what you dismissed lately, and suggests tasks with where it wrote them from and why. It never sets Must have, and
            it reads what people type in Work and what a sheet brings in as your team&apos;s words, never as instructions.
          </P>
          <Steps>
            <li>
              Under <strong>Tasks Vizzy suggests</strong>, read the task, where Vizzy wrote it from, why, and the kind of win
              Vizzy suggests with its reason.
            </li>
            <li>
              Press <strong>Add to Work</strong> to add it as Vizzy wrote it.
            </li>
            <li>
              Or press <strong>Edit then add</strong>. The add page opens filled with the suggestion, and Vizzy&apos;s kind of win
              is marked Vizzy suggests. Change what you like and press <strong>Add task</strong>, or Cancel to go back to Review.
            </li>
            <li>
              Or press <strong>Dismiss</strong> and pick why: {reasons.join(", ")}, or <strong>No reason</strong>.
            </li>
          </Steps>
          <UL>
            <li>Not now lets Vizzy suggest it again in 30 days. Any other reason, or none, keeps it away.</li>
            <li>
              What Vizzy wrote is kept beside what you added: the task&apos;s page shows <strong>{WORK_COPY.vizzySuggested}</strong>{" "}
              for each field you changed. Ticking Must have doesn&apos;t count as a change.
            </li>
            <li>
              A suggestion is added for the brand it names, another brand that keeps its data in the same region, or the whole
              business.
            </li>
            <li>
              Vizzy also drafts a Log note or a decision in chat. <strong>{DRAFT_COPY.logSave}</strong> opens the Log with the box
              filled in, and <strong>{DRAFT_COPY.cardDecisionCta}</strong> opens the task with the drafted question, options and
              Vizzy&apos;s pick. Nothing is saved until you do, and you can change it first. A draft nobody saves is set aside
              after 7 days.
            </li>
          </UL>
        </>
      ) : null}

      <H2 id="check">Check it worked</H2>
      <Checks>
        <li>The task is on the list with its number, and its page&apos;s History says who added it.</li>
        <li>On Today, Tasks that moved lists what changed, and In flight what you logged.</li>
        <li>On the day a check falls due, the count next to Review in the sidebar goes up.</li>
      </Checks>

      <H2 id="messages">If you see this</H2>
      <Messages
        rows={[
          [
            WORK_MESSAGES.no_organisation,
            <>
              The brand and its organisation don&apos;t list each other. Whoever runs your copy of YouGrow runs{" "}
              <code>npx tsx scripts/backfill-organisations.ts --check</code>, which says what disagrees.
            </>,
          ],
          [WORK_MESSAGES.whole_business_owners, "Pick your own brand for the task, or ask an owner to add it."],
          [WORK_MESSAGES.other_region, "Add a new task with that brand, and drop or delete this one if it isn't needed."],
          [
            WORK_MESSAGES.no_repo,
            <>
              An admin connects GitHub or GitLab first (<Open href="/help/connected-accounts#github">Connect GitHub or GitLab</Open>).
            </>,
          ],
          [WORK_MESSAGES.repo_not_selected, "Pick one of the brand's selected repos, or ask an admin to select this one."],
          [WORK_MESSAGES.product_look, "Set the days to 90 or fewer, or count nothing and let your read be the record."],
          [WORK_MESSAGES.read_not_measure, "Press Mark checked, or Look again tomorrow."],
          [WORK_MESSAGES.plan_link_missing, "Add the plan under Connected to, then press Approve the plan on it."],
          [WORK_MESSAGES.plan_drafted, "Answer Approve the plan yourself, from the plan under Connected to."],
          [WORK_MESSAGES.import_too_many, "Split the sheet and import each part. Refs carry on from the highest."],
          [WORK_MESSAGES.regions_down, "Nothing was imported. Try again in a minute."],
          [WORK_MESSAGES.tasks_full, "Delete done or dropped tasks you no longer need, then add it again."],
          [WORK_MESSAGES.entries_full, "Log the rest tomorrow. Tasks and decisions still save."],
          [WORK_MESSAGES.changed, "Someone else changed the task meanwhile. Refresh the page and make your change again."],
          ...(workVizzy
            ? ([
                [WORK_MESSAGES.suggestion_decided, "Someone on your team added or dismissed it a moment ago. Refresh Review."],
                [DRAFT_COPY.logDraftGone, "Ask Vizzy to draft the note again, or type it in the Log box yourself."],
              ] as Array<[string, string]>)
            : []),
        ]}
      />

      <NextPage slug="work" ideaWords={ideaWords} />
    </article>
  );
}
