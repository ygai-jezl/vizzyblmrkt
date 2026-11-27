import { H1, H2, Lead, P, Pairs, UL } from "@/components/developers/Doc";
import { BeforeAndUnlocks, Checks, Messages, Meta, NextPage, Open, Steps } from "@/components/help/blocks";
import type { HelpBodyProps } from "@/lib/help/pages";
import { QUIET_AFTER_DAYS } from "@/lib/raise/pipeline/due";
import { isRaiseFollowupsEnabled } from "@/lib/raise/pipeline/flags";
import { FIELD_PRESETS, FUNDING_STAGES, RAISING_STAGES } from "@/lib/raise/pipeline/presets";
import { BOARD_WORDS, NOUNS, PASS_WORDS, REVIEW_WORDS, SETUP_WORDS } from "@/lib/raise/pipeline/words";
import { RAISE_AREAS, RAISE_REASONS } from "@/lib/raise/reasons";

/**
 * /help/investors-and-funding (RAISE_PIPELINE_ENABLED): Set up for raising or funding in Settings ›
 * Data model, the board on People, why each one passed, and Vizzy's counts. Follow-ups in Review
 * show while RAISE_FOLLOWUPS_ENABLED is on too (`raiseFollowUps`; the How to drawer passes the
 * shell's answer). Every word it quotes is the app's own (src/lib/raise/pipeline/words.ts), and the
 * reason table comes from src/lib/raise/reasons.ts, so neither can drift. Client safe: the drawer
 * loads it in the browser, so it imports no server code (help.test.ts checks the 14 day expiry and
 * the board's address against the server's).
 */

/** People › Investors (BOARD_HREF in src/lib/raise/pipeline/setup.ts). */
const BOARD_HREF = "/admin/crm?tab=investors";
/** A follow-up nobody decides goes after this many days (FOLLOWUP_EXPIRY_DAYS in followups.ts). */
const EXPIRY_DAYS = 14;

/** "Research, Contacted and Passed". */
const list = (words: readonly string[]) => (words.length > 1 ? `${words.slice(0, -1).join(", ")} and ${words.at(-1)}` : (words[0] ?? ""));
const names = (items: ReadonlyArray<{ label: string }>) => list(items.map((i) => i.label));
const reasonNames = (audience: string) => list(RAISE_REASONS.filter((r) => r.audience === audience).map((r) => r.label));

export default function InvestorsAndFundingHelp({ raiseFollowUps = isRaiseFollowupsEnabled() }: HelpBodyProps = {}) {
  return (
    <article>
      <H1>Investors and funding</H1>
      <Lead>
        {raiseFollowUps
          ? "Keep a raise, or a loan or grant, on People: one press sets up the fields, a board shows who is at which stage, and Review reminds you who has gone quiet."
          : "Keep a raise, or a loan or grant, on People: one press sets up the fields, and a board shows who is at which stage and why each one passed."}
      </Lead>
      <Meta items={["About 5 minutes", "Admins set it up and move people; your whole team reads it", "Once per brand"]} />

      <BeforeAndUnlocks
        before={
          <>
            <li>The board turned on in your copy of YouGrow</li>
            <li>An admin on your brand&apos;s team</li>
          </>
        }
        unlocks={
          <>
            <li>A board of everyone you are raising from or applying to</li>
            <li>Why each one said no, counted</li>
            {raiseFollowUps ? <li>Follow-ups in Review</li> : null}
          </>
        }
      />

      <H2 id="set-up">Set up for raising or funding</H2>
      <Steps>
        <li>
          Open <Open href="/admin/account/data-model">Settings › Data model</Open>. The <strong>{SETUP_WORDS.title}</strong> box is at the
          top, for admins.
        </li>
        <li>
          Pick <strong>{SETUP_WORDS.kits.raising.button}</strong> for investors, or <strong>{SETUP_WORDS.kits.funding.button}</strong> for a
          loan or a grant. The one that fits your business comes first.
        </li>
        <li>
          Pick <strong>{SETUP_WORDS.amountsIn}</strong>: the currency of the Cheque field. It starts from your brand&apos;s time zone.
        </li>
        <li>
          Read what the press adds, which of your own fields it uses, and what it keeps as it is. Nothing changes yet, and the button
          waits until the box shows the kit and currency you picked.
        </li>
        <li>
          Press the button. It says what it added and where the board is, with <strong>{SETUP_WORDS.openBoard}</strong>.
        </li>
      </Steps>
      <P>
        Both add the same {FIELD_PRESETS.length} fields to People: {names(FIELD_PRESETS)}. {SETUP_WORDS.kits.raising.button} gives Stage{" "}
        {names(RAISING_STAGES)}. {SETUP_WORDS.kits.funding.button} gives Stage {names(FUNDING_STAGES)}, and Relationship gains Lender and
        Bank. A brand raising from investors and applying for a loan can press both: one board holds both sets of stages.
      </P>
      <P>
        Fernhill Plants (a made-up plant shop) is applying for a bank loan. An admin presses {SETUP_WORDS.kits.funding.button}: Stage gets
        Plan, Applied, Decision, Funds in and Passed, Relationship gets Lender and Bank, and People gains a Funding tab.
      </P>
      <UL>
        <li>Pressing again adds only what is missing. With nothing missing it says so and saves nothing.</li>
        <li>
          Nothing you have is renamed or removed. A Stage field you already have is used as it is: your own stages keep their names and
          their place, and the missing ones go in beside the nearest ones. Research, Contacted, Meeting, Diligence, Committed and Passed
          become Research, Contacted, Replied, First meeting, Next meeting, Meeting, Diligence, Term sheet, Committed, Money in and Passed.
        </li>
        <li>
          A field of yours with a ready-made name, such as Stage, Tier or Cheque, is used rather than added again, and the box names it
          first: &quot;{SETUP_WORDS.uses(["Stage"])}&quot; With your own Stage it adds &quot;{SETUP_WORDS.usesStage("Stage")}&quot; If your
          Stage means something else, such as a customer&apos;s stage at a plant shop, rename it in Data model before you press.
        </li>
        <li>A field of yours with the same name but another type stays as it is, and the box says so. The board needs Stage to be a select or status field.</li>
        <li>A field or an option you archived stays archived and isn&apos;t added again. Bring it back in Data model if you want it.</li>
        <li>The press is saved as one change to your fields, by you. Renaming a field or a stage later doesn&apos;t move it off the board.</li>
      </UL>

      <H2 id="board">The board</H2>
      <P>
        Open <Open href={BOARD_HREF}>People › {NOUNS.raising.tab}</Open>, or {NOUNS.funding.tab} when you set up for funding
        only. Each stage is a column, in the order your Stage field has them, with a card for each person at that stage. Everyone on your
        team sees it.
      </P>
      <UL>
        <li>A card shows their name (or address), firm and tier, and opens their page.</li>
        <li>
          Their Next step date, such as &quot;{BOARD_WORDS.nextStep("2026-12-03")}&quot;, reads &quot;{BOARD_WORDS.nextStepWas("2026-12-03")}&quot;
          once it has passed.
        </li>
        <li>
          &quot;{BOARD_WORDS.quietFor(16)}&quot; when their Last touch was {QUIET_AFTER_DAYS} or more days ago while they are in a stage in play.
        </li>
        {raiseFollowUps ? (
          <li>
            A <strong>{BOARD_WORDS.followUpChip}</strong> chip while a follow-up for them waits in Review.
          </li>
        ) : null}
      </UL>
      <P>
        The top of the board says &quot;{BOARD_WORDS.guidance}&quot; and counts the people on it, such as &quot;
        {BOARD_WORDS.counts("raising", 31, 5, 2, QUIET_AFTER_DAYS)}&quot;. Quiet means in a stage in play with a Last touch{" "}
        {QUIET_AFTER_DAYS} or more days ago. Past their next step date means not yet in Money in, Funds in or Passed, with a Next step date
        before today. Days are your brand&apos;s own, in its time zone.
      </P>
      <P>
        Admins drag a card onto another column, or pick a stage from the card&apos;s <strong>{BOARD_WORDS.moveTo}</strong> menu, which works
        with a keyboard and on a phone. It changes their Stage, just as changing it on their page does. Members read the board only.
      </P>
      <UL>
        <li>{BOARD_WORDS.capped}</li>
        <li>
          A stage you archived in Data model shows as <strong>{BOARD_WORDS.archivedColumn}</strong> while people are still in it. Move them
          to a stage in use.
        </li>
      </UL>

      <H2 id="passed">When someone passes</H2>
      <P>
        Moving someone onto Passed asks <strong>{PASS_WORDS.title}</strong> &quot;{PASS_WORDS.line}&quot;
      </P>
      <Steps>
        <li>Tap the area: {names(RAISE_AREAS)}.</li>
        <li>
          Tap the reason, then <strong>{PASS_WORDS.save}</strong>.
        </li>
        <li>
          <strong>{PASS_WORDS.blank}</strong> moves them with no reason. <strong>{PASS_WORDS.cancel}</strong> leaves them where they were.
        </li>
      </Steps>
      <Pairs head={["Area", "Reasons"]} rows={RAISE_AREAS.map((a) => [a.label, list(RAISE_REASONS.filter((r) => r.area === a.key).map((r) => r.label))])} />
      <UL>
        <li>
          A lender&apos;s reasons sit under Deal ({reasonNames("lender")}) and a grant&apos;s under Fit ({reasonNames("grant")}). On a
          Funding board they come first.
        </li>
        <li>Reasons you added to Pass reason yourself sit under Other.</li>
        <li>Each reason keeps a fixed key, so you can rename it in Data model and its count carries on.</li>
        <li>Moving someone out of Passed clears their reason. With no Pass reason field, a move onto Passed doesn&apos;t ask.</li>
      </UL>

      {raiseFollowUps ? (
        <>
          <H2 id="follow-ups">Follow-ups in Review</H2>
          <P>
            Review&apos;s <strong>{REVIEW_WORDS.title}</strong> lists people who need a nudge. YouGrow checks each morning, in your
            brand&apos;s time zone, and adds one when:
          </P>
          <UL>
            <li>someone in a stage in play has a Last touch {QUIET_AFTER_DAYS} or more days ago, or</li>
            <li>someone not yet in Money in, Funds in or Passed has a Next step date before today.</li>
          </UL>
          <P>
            Each person gets one at most for each reason in each stage, and the same quiet spell or the same date never brings a second
            while they stay in that stage. A row says how long they have been quiet, or that their next step date passed, and their stage,
            never their name: <strong>{REVIEW_WORDS.open}</strong> goes to their page.
          </P>
          <UL>
            <li>
              <strong>{REVIEW_WORDS.followedUp}</strong>, on a quiet one, sets their Last touch to today and clears it.
            </li>
            <li>
              <strong>{REVIEW_WORDS.dismiss}</strong> clears it.
            </li>
            <li>A new Last touch or Next step date on their page, or a move on the board, clears it at once.</li>
            <li>
              A move doesn&apos;t change their Last touch. Still quiet, or still past their date, in their new stage? One more comes the next
              morning for that stage, so set their Last touch when you were in touch.
            </li>
            <li>Archive the Stage field and the board goes, and so do its follow-ups in Review.</li>
            <li>One nobody decides goes after {EXPIRY_DAYS} days.</li>
            <li>Everyone on the team sees the list. Only admins see the buttons.</li>
          </UL>
        </>
      ) : null}

      <H2 id="vizzy">Ask Vizzy</H2>
      <P>
        Ask &quot;How many investors are overdue?&quot; or &quot;Why are investors passing?&quot;. Vizzy answers with counts by stage and by
        reason, and how many are quiet or past their next step date. It never names anyone: for who, open the board. It only reads:
        moving people and logging reasons happen on the board.
      </P>

      <H2 id="check">Check it worked</H2>
      <Checks>
        <li>People has a {NOUNS.raising.tab} (or {NOUNS.funding.tab}) tab with a column for each stage.</li>
        <li>Pressing the button again says nothing was added.</li>
        {raiseFollowUps ? <li>A Next step date in the past brings one follow-up in Review the next morning, and only one.</li> : null}
      </Checks>

      <H2 id="messages">Messages you might see</H2>
      <Messages
        rows={[
          [SETUP_WORDS.nothing, "Nothing to do: every field and option the board needs is there."],
          [SETUP_WORDS.doneUses, "The press started using fields you already had, such as your own Stage. Nothing new was made."],
          [SETUP_WORDS.errors.field_list_full, "Archive fields you no longer use in Data model, then press again."],
          [SETUP_WORDS.errors.fields_changed, "Someone saved your fields at the same time. Press again."],
          [BOARD_WORDS.errors.not_set_up, "An admin presses one of the two buttons in Settings › Data model."],
          [BOARD_WORDS.errors.stale, "Someone changed them meanwhile. Move them again if you still want to."],
          [BOARD_WORDS.membersOnly, "Ask an admin on your team to move them."],
          ...(raiseFollowUps ? ([[REVIEW_WORDS.errors.stale, "Someone decided it, or changed them, meanwhile. Open their page to check."]] as Array<[string, string]>) : []),
        ]}
      />

      <NextPage slug="investors-and-funding" />
    </article>
  );
}
