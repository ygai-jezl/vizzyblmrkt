import { H1, H2, Lead, P, UL } from "@/components/developers/Doc";
import { BeforeAndUnlocks, Checks, Messages, Meta, NextPage, Open, Steps, Warning } from "@/components/help/blocks";
import { isBlogFreshnessUiEnabled, isBlogLiveWatchEnabled, isBlogRefreshUiEnabled, isBrandMapScaleEnabled, isBrandMapSituationAskUiEnabled } from "@/lib/brandMap/flags";
import { isAiAnswersPlanningEnabled, isConnectorSignalsEnabled } from "@/lib/connectors/flags";
import { SIGNALS_HELP } from "@/lib/connectors/helpText";
import type { HelpBodyProps } from "@/lib/help/pages";
import { isCompetitorsUiEnabled } from "@/lib/competitors/flags";
import { isAutopilotEnabled, isNextUpEnabled, isNextUpRepeatsEnabled } from "@/lib/autopilot/flags";
import { isUsageMeterUiEnabled } from "@/lib/plans/flags";
import { WEB_SEARCH_LIMIT_MESSAGE } from "@/lib/plans/resources";
import { isBrandStrategyUiEnabled } from "@/lib/brandStrategy/flags";
import { HOW_IT_WENT_WORDS, STRATEGY_ERRORS } from "@/components/admin/brand-kit/strategyMessages";
import { REST_TEXT } from "@/lib/brandStrategy/monthRules";
import { OUTCOME_WORDS } from "@/lib/metrics/outcomes";
import { SUGGEST_WORDS } from "@/lib/brandStrategy/suggestRules";
import { NOT_NOW_LABEL, NOT_NOW_REASONS } from "@/lib/types/brandStrategy";
import { isContentStrategyUiEnabled } from "@/lib/contentStrategy/flags";
import { NOT_ARTICLES_LABEL, PLAN_ERRORS } from "@/components/admin/brand-kit/contentPlanMessages";

/** How it went's lines for a kind not measured, as the Strategy tab says them. */
const KEY_ACTIONS_LINE = OUTCOME_WORDS.missing({ kind: "key_actions", state: "not_connected", could: [{ connectorId: "google-analytics", name: "Google Analytics 4", href: "", siteOnly: false }] });
const REST_QUESTIONS = `${HOW_IT_WENT_WORDS.restQuestions.charAt(0).toLowerCase()}${HOW_IT_WENT_WORDS.restQuestions.slice(1)}`;
const SHARE_LINE = OUTCOME_WORDS.missing({ kind: "search", state: "not_shared", connectionId: "", connectorId: "search-console", connector: "Google Search Console", href: "" });
/** Not now's reasons, as the picker says them: "Not a priority, Already doing it, The numbers are wrong or Other". */
const NOT_NOW_WORDS = `${NOT_NOW_REASONS.slice(0, -1).map((r) => NOT_NOW_LABEL[r]).join(", ")} or ${NOT_NOW_LABEL[NOT_NOW_REASONS.at(-1)!]}`;

export default function BrandMapHelp({ connectorSignals = isConnectorSignalsEnabled(), brandMapScale = isBrandMapScaleEnabled(), aiAnswers = isAiAnswersPlanningEnabled() }: HelpBodyProps = {}) {
  // Linked from Review and Connected data whenever signals are on; at any size the questions wait here.
  // The How to drawer passes the server's switches: it can't read them itself.
  const fromSearches = connectorSignals;
  const atScale = brandMapScale;
  return (
    <article>
      <H1>Brand map</H1>
      <Lead>One set of names and subjects that every blog article is written from, so each one describes you the same way.</Lead>
      <Meta items={["About 15 minutes", "Admins", "Once, then whenever you add subjects"]} />

      <BeforeAndUnlocks
        before={
          <>
            <li>
              Your website as the <strong>Primary domain</strong> in <Open href="/admin/account">Settings › Sending</Open>
            </li>
            <li>
              A programme with your website in its knowledge (
              <Open href="/help/programmes-and-knowledge#knowledge">Add knowledge</Open>)
            </li>
          </>
        }
        unlocks={
          <>
            <li>Blog articles that use your names, subjects and pages</li>
            <li>Buying situations your articles are written for</li>
            <li>
              <strong>Write this next</strong> on every question you haven&apos;t answered yet
            </li>
          </>
        }
      />

      <Warning>
        Blog articles use your brand map only once it&apos;s saved. Research only drafts it: check it, then press{" "}
        <strong>Save brand map</strong>.
      </Warning>

      <H2 id="research">Research your brand</H2>
      <Steps>
        <li>
          Open <Open href="/admin/brand-kit/map">Brand › Brand map</Open>.
        </li>
        <li>
          Press <strong>Research my brand</strong>. It reads your site and your knowledge, searches how people talk about
          your category, and drafts the map. This takes about a minute.
          {isUsageMeterUiEnabled() ? (
            <>
              {" "}
              Its Google searches count toward your brand&apos;s{" "}
              <Open href="/help/plan-and-usage#use">web searches for research</Open> this month, as finding buying
              situations does.
            </>
          ) : null}
        </li>
        <li>
          No research button? Press <strong>Fill it in yourself</strong>. Research isn&apos;t switched on for your YouGrow,
          and whoever runs it can turn it on.
        </li>
      </Steps>

      <H2 id="save">Review and save</H2>
      <Steps>
        <li>
          On <strong>Who you are</strong>, check <strong>What you are</strong>: your category as buyers say it, one sentence,
          what you are not, and names to avoid.
        </li>
        <li>
          Check <strong>Names you use</strong>: your products, alternatives and audiences, each linked to its page on your
          site.
        </li>
        {isCompetitorsUiEnabled() ? (
          <li>
            To watch an alternative&apos;s website, press <strong>Monitor</strong> beside it. See{" "}
            <Open href="/help/your-brand#competitors">Watch your competitors</Open>.
          </li>
        ) : null}
        <li>
          Under <strong>Suggestions</strong>, untick anything wrong. Press <strong>Add ticked</strong>, then{" "}
          <strong>Dismiss the rest</strong>.
        </li>
        <li>
          Press <strong>Save brand map</strong>.
        </li>
        <li>
          Open <strong>Subjects</strong>. New subjects from research wait under <strong>Proposed</strong>. Press{" "}
          <strong>Add</strong> or <strong>Dismiss</strong> on each. Changes on this tab save straight away. When you watch
          competitors and read their articles, a subject they wrote on shows how many articles and what that means, such as{" "}
          <strong>Gap</strong> when they write about it and you don&apos;t yet.
        </li>
      </Steps>

      {fromSearches && !atScale ? (
        <>
          <H2 id="from-searches">Questions from Google searches</H2>
          <P>
            When a search people make on Google is rising and nothing on your map asks it yet, it waits in Review under{" "}
            <strong>What your numbers suggest</strong>, with <strong>Plan an article</strong> and <strong>Dismiss</strong> (
            <Open href="/help/review-and-approvals#numbers">Plan or dismiss them</Open>). {SIGNALS_HELP.planning}
          </P>
        </>
      ) : null}
      {fromSearches && atScale ? (
        <>
          <H2 id="from-searches">Questions from Google searches</H2>
          <P>
            When a search people make on Google is rising and nothing on your map asks it yet, it waits on the{" "}
            <strong>Subjects</strong> tab as a proposed question under its nearest subject, in the search&apos;s own words. It
            shows <strong>From Google searches</strong> and its numbers, such as &quot;410 impressions in the 14 days to 20
            Nov, up from 60&quot;, and counts in Review&apos;s brand map row.
          </P>
          <Steps>
            <li>Open the subject it is proposed for.</li>
            <li>
              Press <strong>Edit</strong> to put the search into your own words, then <strong>Save</strong>. The line then
              names the search it came from.
            </li>
            <li>
              Press <strong>Add</strong> to put it on your map, or <strong>Dismiss</strong>. Once added, it keeps its tag.
            </li>
          </Steps>
          <P>
            {SIGNALS_HELP.planning} When Search Console isn&apos;t shared with your team and Vizzy, its searches aren&apos;t
            proposed here. A proposed question nobody adds within 30 days comes off the map, and so do all of a connection&apos;s
            proposed questions when it is disconnected (
            <Open href="/help/connected-data#suggestions">What your numbers suggest</Open>).
          </P>
        </>
      ) : null}

      <H2 id="situations">Add buying situations</H2>
      <P>A buying situation is the moment that sends someone looking for something like you. Articles open by meeting the reader there.</P>
      <Steps>
        <li>
          Open <strong>Buying situations</strong> and press <strong>Find buying situations</strong>.
        </li>
        <li>
          If you like, say what made your last few customers start looking. Press <strong>Find them</strong>. This takes
          about a minute.
        </li>
        <li>
          Untick any that don&apos;t fit, then press <strong>Add ticked</strong>.
        </li>
        <li>
          To write one yourself, press <strong>Add a situation</strong>.
        </li>
        {isBrandMapSituationAskUiEnabled() ? (
          <li>
            To get what people in a situation ask, open it and press <strong>Find what they ask</strong>. This takes up to a
            minute. Add the questions that fit and dismiss the rest. A question on a subject that isn&apos;t on your map yet
            brings its subject with it.
          </li>
        ) : null}
      </Steps>

      <H2 id="pdf">Import research from a PDF</H2>
      <Steps>
        <li>
          Open <strong>Your research</strong>.
        </li>
        <li>Choose a PDF of 14 MB at most, such as screenshots of Google&apos;s &quot;People also ask&quot;.</li>
        <li>
          Press <strong>Read it</strong>. This takes about a minute.
        </li>
        <li>
          The report shows what&apos;s new, what&apos;s on your map already and what doesn&apos;t fit. New questions arrive
          ticked: press <strong>Add ticked</strong>.
        </li>
      </Steps>
      <P>The PDF isn&apos;t kept. Only what it found is.</P>

      {isBrandStrategyUiEnabled() ? (
        <>
          <H2 id="strategy">Approve your strategy</H2>
          <P>
            The <strong>Strategy</strong> tab holds one strategy for your brand: who it&apos;s for, who you compete with, where
            you win, what you&apos;re not, and this quarter&apos;s goal. Once you approve it, articles, research, Next up and
            Vizzy use it. Members can read it; admins change and approve it.
          </P>
          <Steps>
            <li>
              Open <strong>Strategy</strong> and press <strong>Propose with Vizzy</strong>. It reads your brand map, your buying
              situations, your site, your knowledge, your competitors and what you told Vizzy about your business. This takes
              up to a minute.
            </li>
            <li>
              Under <strong>Who it&apos;s for</strong>, star 3 to 5 focus situations. Vizzy suggests the ones where people ask
              the most and the fewest live articles answer.
            </li>
            <li>
              Under <strong>Who you compete with</strong>, press <strong>Find competitors</strong>. It asks Google who buyers
              weigh instead of you, and keeps only the names Google&apos;s results back. Press <strong>Monitor</strong> on the
              ones to watch on <Open href="/admin/brand-kit/competitors">Brand › Competitors</Open>.
            </li>
            <li>
              Under <strong>Where you win, and where they do</strong>, check each claim. One marked <strong>gap</strong> has no
              proof yet: it is never used as fact until a page on your site or your docs shows it.
            </li>
            <li>
              Press <strong>Add</strong> on a proposed line under <strong>What you&apos;re not</strong> to add it to Who you are,
              or <strong>No</strong> so it isn&apos;t proposed again.
            </li>
            <li>
              Under <strong>The quarter&apos;s goal</strong>, press <strong>Edit</strong> to say the goal and how you&apos;ll
              know. It starts from what you told Vizzy you want first.
            </li>
            <li>
              Press <strong>Approve strategy</strong>. Your focus situations get their star on Buying situations, and Next up
              offers their questions first.
            </li>
          </Steps>
          <P>
            Every brand can run the quick competitor search once. <strong>Full search</strong> asks three times, keeps the
            names that come up most, then runs a search that fits your business: 4 a month by default, on plans that include
            the full competitor finder. Its Google searches count toward your brand&apos;s{" "}
            <Open href="/help/plan-and-usage#use">web searches for research</Open>.
          </P>
          <P>
            When your copy of YouGrow joins the strategy to Competitors, <strong>Who you compete with</strong> lists every
            competitor you watch on <Open href="/admin/brand-kit/competitors">Brand › Competitors</Open> straight away, before you
            propose anything. Each sits in the group an admin chose with <strong>Choose a group</strong>, here or on Brand ›
            Competitors, or under <strong>Not grouped yet</strong>. Below them, <strong>Suggested by the finder</strong> lists what
            the finder found that you don&apos;t watch: <strong>Monitor</strong> starts watching it in the finder&apos;s group, and{" "}
            <strong>Not a competitor</strong> keeps it out of every later search. A competitor you stop watching leaves the list,
            and one you watched from the finder&apos;s suggestions isn&apos;t suggested again.
            Approving keeps the list as it was then, and a competitor you watch, group or find after that doesn&apos;t mark the
            strategy changed.
          </P>
          <P>
            Where this copy of YouGrow reads their articles, each competitor you watch has a line on what it wrote in the last 90
            days: its kinds of article, who they are for, the stats it uses and what it asks readers to do, and the situation it
            writes on most. Stats, asks and how many name you count only the articles read from their own pages, and the line says
            so. <strong>Against your competitors</strong> puts your focus situations beside their articles on each, how many of its
            questions you have answered and how many of their articles are new since you approved. With no focus yet, it shows the
            situations they write on most. A situation with no questions on your map yet reads <strong>You: no questions yet</strong>:
            Next up and the content plan pick from questions, so an admin presses <strong>Find what they ask</strong> beside it,
            which opens it on Buying situations to find them. It also counts the subjects only they write on, and names the alternatives on your brand
            map they mention that you don&apos;t watch, each with <strong>Monitor</strong>. When a month had more articles read
            than the card counts, it says its numbers may be a little low. Propose with Vizzy reads the same, so a claim about a
            competitor can stand on the article that makes it.
          </P>
          <P>
            Where your copy of YouGrow checks the strategy each week, it sets your approved focus situations against what your
            competitors published, and asks for a look in <Open href="/admin/approvals">Review</Open> only when something
            material changed: 3 or more of their articles on one focus situation published after the day you approved, a focus
            situation that is newly a gap, or an alternative on your brand map named in 3 or more of their articles that you
            don&apos;t watch. An article with no publish date never counts as new. <strong>Review the strategy</strong> opens
            this tab, where <strong>Propose with Vizzy</strong> keeps your edits. An admin can <strong>Dismiss</strong> the row
            instead: it stays away 30 days, then counts what they published after the day you dismissed it. Approving again
            starts the check over, and Vizzy reads what it saw.
          </P>
          <P>
            Where your copy of YouGrow adds up how the strategy went, <strong>How it went</strong> shows each month from the 2nd
            of the next, with a month picker: your focus situations beside <strong>{REST_TEXT}</strong>, each with its articles
            live (and how many went live that month), its questions answered, one column for each kind of result it can measure
            and their articles that month. It starts with the first full calendar month after you first approve (approve on 20
            November and December comes first, added up on 2 January), and until then it reads{" "}
            <strong>{HOW_IT_WENT_WORDS.tooEarly}</strong> Each month is added up once and never changed. An arrow shows how a
            number moved against the month before, only when both months had the same focus situations, the same source and
            results for matching days, so connecting a tool or changing your focus never reads as a jump. In{" "}
            <strong>{REST_TEXT}</strong>, {REST_QUESTIONS} Under the table it counts the roadmap entries that were due and how
            many went live, and what your team changed in the strategy that month.
          </P>
          <P>
            It measures from whatever you&apos;ve connected on <Open href="/admin/account/connections">Settings › Connections</Open>{" "}
            and shared with your team and Vizzy: Google Search Console for search, Google Analytics for visits and sign-ups,
            Cloudflare for visits to your whole site (it can&apos;t say which situations bring them), and a tool that tracks how
            often AI engines cite your pages. One connection counts for each kind, so nothing is counted twice. When a connected tool can&apos;t be read, the month
            waits a day and tries again, twice at most, then is kept with that kind marked as not read. <strong>{OUTCOME_WORDS.lead}</strong>{" "}
            says what each missing one would add, such as &quot;{KEY_ACTIONS_LINE}&quot;, or &quot;{SHARE_LINE}&quot; for one
            that is connected but not shared, each with its link. With nothing connected, it shows your articles and answered
            questions only. Vizzy reads the latest month and what to connect.
          </P>
          <P>
            Where your copy of YouGrow suggests one change a month, keeping a month also works out one suggestion, by rules
            and with no AI. The first that applies is used: your content plan is behind (3 or more of its articles were due
            and aren&apos;t live yet, named, with <strong>Write or move these 3</strong>), a focus situation stalled (no new
            article and no search clicks, visits or AI citations for 2 months while the rest of your map moved, with a
            situation to swap it for: the one your competitors wrote most on in the last 90 days, else the one whose
            articles had the most of a result you measure, else the one with the most questions no live article answers),
            a claim has had no proof for 2 months, or a kind of result isn&apos;t connected or shared yet. A rule that needs
            a result your tools don&apos;t measure is skipped, and a tool that couldn&apos;t be read is never suggested.
            Each suggestion says what it was based on and what it couldn&apos;t see, such as &quot;From your articles and
            Google Search Console. Connect Google Analytics 4 to weigh sign-ups too.&quot; When your goal&apos;s measure
            names your own word for them, such as bookings, the suggestion uses it. When your focus situations did better
            than the rest of your map, How it went says so under the month instead.
          </P>
          <P>
            It shows in <Open href="/admin/approvals">Review</Open> as <strong>{SUGGEST_WORDS.title}</strong>, and on this
            tab above Propose as <strong>{SUGGEST_WORDS.onTab}</strong>. <strong>{SUGGEST_WORDS.review}</strong> opens this
            tab, where <strong>Propose with Vizzy</strong> takes it as a note to its draft. Nothing changes until an admin
            approves, and approving that draft counts as acting on it. Approving a strategy that takes the stalled
            situation out of your focus, or drops the claim or gives it proof, clears the suggestion too, and so does
            approving a new content plan for one about the plan before. A suggestion to connect a tool is never a note for
            Propose: its button opens the tool&apos;s Connect page, or <strong>{SUGGEST_WORDS.share}</strong> opens where
            sharing is set, and connecting it settles it. An admin can press <strong>{SUGGEST_WORDS.notNow}</strong> and
            say why ({NOT_NOW_WORDS}), with a note of up to 200 characters if they like. That suggestion then stays away 60
            days, or 90 for connecting a tool. The next suggestion comes when the next month is added up, early next month,
            from whatever applies then. The reason is kept with the strategy, and Vizzy reads the suggestion too.
          </P>
          <P>
            What you star, tick, edit or turn down is kept with the strategy, with the 5 strategies approved before it, so
            YouGrow can learn from it later. Nothing learns from it yet. <strong>Start over</strong> removes all of it; your
            brand map stays as it is.
          </P>
        </>
      ) : null}

      {isBrandStrategyUiEnabled() && isContentStrategyUiEnabled() ? (
        <>
          <H2 id="content-plan">Plan the quarter&apos;s content</H2>
          <P>
            Under the strategy, the <strong>Content plan</strong> turns your brand map into a plan for the next 12 weeks. It
            merges questions that ask the same thing into one article each, called a slot, so you never write two articles for
            one question. Members can read it; admins make, change and approve it.
          </P>
          <Steps>
            <li>
              Approve your strategy first, so the plan knows your focus situations. Then press <strong>Make the plan</strong>.
              It reads your brand map&apos;s questions, your articles, your competitors and, where you have them, Search
              Console and your Google lookups. This takes up to a minute.
            </li>
            <li>
              Check the <strong>Pillars</strong>: the 3 to 6 big themes your slots fall into. They come from your brand
              map&apos;s groups when you have set them; otherwise Vizzy names them. Each shows how many of its slots a live
              article answers and its hub, the page that links the pillar together. Press <strong>Rename</strong> to change a
              name, or press a pillar to see its slots: <strong>Split</strong> takes a question out into a slot of its own,
              and <strong>Join</strong> merges two slots into one article.
            </li>
            <li>
              Check the <strong>Next 3 weeks</strong>. Each entry says what to write, refresh or combine, and why: your
              focus, demand, competitors and the stage it fills. Press <strong>A week later</strong> to move one, or{" "}
              <strong>Skip</strong> to take it off.
            </li>
            <li>
              Press <strong>Approve plan</strong>. The plan approved before it is kept, in short, with the 4 before that.
            </li>
          </Steps>
          <P>
            The roadmap writes each pillar&apos;s hub first, gives each month one or two focus pillars, and keeps a funnel
            mix: half the new articles help buyers learn, almost a third help them consider, and a fifth help them choose.{" "}
            <strong>Funnel</strong> sets that against your questions today. It runs at your autopilot&apos;s articles a week,
            and keeps part of each month for live articles: a <strong>Refresh</strong> for one due a refresh or missing some
            of its slot&apos;s questions, and a <strong>Combine</strong> where two live articles answer one question, so you
            keep one and fold the other in.
          </P>
          <P>
            <strong>{NOT_ARTICLES_LABEL}</strong> lists slots that need a tool page, such as a free checker, or a video.
            They aren&apos;t written for you yet.
          </P>
          <P>
            Once your copy of YouGrow switches it on, Next up takes 3 of every 4 picks from the approved plan and keeps 1
            free for new questions and news. Each pick says which pillar it fills, and an article the autopilot writes for a
            slot covers all its questions. The autopilot never drafts a combine: it waits for you.
          </P>
          <P>
            What you split, join, rename, move or skip is kept with the plan. A pick you skip is left out of the next plan
            for 30 days. <strong>Start over</strong> removes the plan and what was kept with it; your brand map and strategy
            stay as they are.
          </P>
        </>
      ) : null}

      <H2 id="write-next">Write this next</H2>
      <P>
        A question no page answers yet shows as Open, with a <strong>Write this next</strong> button. It starts a blog
        article in your programme&apos;s <strong>Drafts</strong>, with the question filled in. The button only shows once you
        have a programme.
      </P>

      {isNextUpEnabled() ? (
        <>
          <H2 id="next-up">Next up</H2>
          <P>
            At the top of <Open href="/admin/brand-kit/map">Brand › Brand map</Open>, <strong>Next up</strong> shows the
            three articles worth writing next, chosen from your map&apos;s open questions. Each says why now, with the facts
            behind it: how far along its subject is, what you already made, what competitors wrote, and what Google shows.
            Press <strong>Choose again</strong> for a fresh look.
          </P>
          {fromSearches ? (
            <P>
              With Search Console used for planning, a <strong>Search Console</strong> chip gives the numbers for the search
              with the question&apos;s own words, such as &quot;880 impressions, position 11.3&quot;, and another the searches
              near its subject. When Search Console isn&apos;t shared with your team and Vizzy, <strong>Not weighed</strong>{" "}
              says so.
            </P>
          ) : null}
          {aiAnswers ? (
            <P>
              With an AI answers tool connected and shared with your team and Vizzy, an <strong>AI answers</strong> chip gives
              the numbers of a prompt it monitors that is close in wording to the question, such as &quot;best geo tools&quot;
              answered by 6 engines, you named 0 times: how many AI engines answer it, how often their answers named you and
              your competitors, and how many citations they gave. See{" "}
              <Open href="/help/connected-data#vizzybl">Connected data</Open> to connect one.
            </P>
          ) : null}
          <Steps>
            <li>
              <strong>Find what they ask</strong> looks the question up on Google and reads the questions your
              competitors&apos; articles answer. Gemini sorts them into <strong>In this article</strong>,{" "}
              <strong>Another subject</strong> and <strong>Not for us</strong>, each with why.
            </li>
            <li>Move anything to the tray it belongs in. Autopilot learns from it.</li>
            <li>
              <strong>Write it</strong> starts the article with the first tray as What buyers ask.
            </li>
          </Steps>
          {isBlogFreshnessUiEnabled() ? (
            <P>
              Next up can also offer a live article that is{" "}
              <Open href="/help/write-and-schedule#freshness">due a refresh</Open>, as <strong>Refresh a live article</strong>{" "}
              with its reasons. <strong>Open article</strong> takes you to it. By default one of the three picks at most is a
              refresh; an admin changes that under <strong>Refresh clock</strong>.{" "}
              {isBlogRefreshUiEnabled() ? (
                <>
                  In Draft mode the autopilot starts a <Open href="/help/write-and-schedule#refresh">refresh review</Open> for one,
                  and the review waits for you; it never applies a change.
                </>
              ) : (
                "Autopilot writes only new articles for now."
              )}
            </P>
          ) : null}
          {isBlogRefreshUiEnabled() ? (
            <P>
              Under <strong>Refresh clock</strong>, <strong>Which clock works</strong> shows each clock&apos;s refreshes: how
              many changed nothing, how many changes were accepted, what a review cost, and the change in Google clicks 28 days
              after, against your articles left alone. It says too early until a clock has 8 refreshes with results, and then
              gives a range, never one number. Once all three have 8, it suggests the clock that gains the most clicks for what
              reviews cost; an admin can use it, and a tenth of new articles keep testing.
            </P>
          ) : null}
          {isNextUpRepeatsEnabled() ? (
            <>
              <P>
                Before it offers a question, Next up matches it by meaning against every article you have, live or being
                written. A question a live article already answers is marked <strong>Matched by meaning</strong> on your brand
                map and counts as answered; if that article doesn&apos;t really answer it, an admin presses{" "}
                <strong>Unlink</strong> and it is never matched to that article again. A question an article you&apos;re writing
                already covers is left out. A question close to a live article says <strong>Close to your live article</strong>:
                press <strong>Add to that article</strong> to start a refresh review that leads with the question, or{" "}
                <strong>Write it anyway</strong> to write a new one. The autopilot never drafts a close question as a new
                article; in Draft mode it adds it to the live article when it can.
              </P>
              <P>
                When two live articles answer the same question, Next up says so. Keep one, fold the other in, and redirect
                its address on your site. Next up also weighs a subject by its size, so a subject with one question no longer
                goes first.
              </P>
            </>
          ) : null}
          <P>
            <strong>Not now</strong> takes a pick off the list for 30 days; say why and it learns that too. When
            competitors write about something your map doesn&apos;t have, <strong>Add to my map</strong> adds it as a subject. <strong>What autopilot learned</strong> lists what your team skipped, moved and added back; admins
            can remove any of it.
          </P>
        </>
      ) : null}

      {isAutopilotEnabled() ? (
        <>
          <H2 id="autopilot">Autopilot</H2>
          <P>
            <strong>Autopilot</strong> under Next up runs it for you, up to 10 articles a week. Runs start on the day you
            choose and go one at a time; any that don&apos;t fit that day carry on over the rest of the week. Each run is one of two kinds:
          </P>
          <UL>
            <li>
              <strong>Suggest</strong> picks the next article and sorts what buyers ask, then waits. It shows in{" "}
              <Open href="/admin/approvals">Review</Open> as &quot;Next article ready to write&quot;.
            </li>
            <li>
              <strong>Draft</strong> also writes the whole workflow: the article, its teaser, its promo and a post for each
              channel you tick. It waits in Review as one of Vizzy&apos;s drafts. Nothing is ever scheduled or published.
            </li>
          </UL>
          <P>
            Choose the programme drafts go into and add your focus right now, in your own words. The card shows this
            month&apos;s Google lookups and drafts against the brand&apos;s limits. Once the month&apos;s drafts are used up, runs find
            and sort the article for you to write instead. Each question is picked once: a run never takes one another run
            had in the last 30 days. A draft&apos;s notes from What we&apos;ve seen count
            as used only once you approve it, and its questions for your team show in Review until it is approved. When
            everyone has answered and nobody has changed the article, it is rewritten with the answers.
            {isBlogLiveWatchEnabled() ? (
              <>
                {" "}
                Once you publish the article on your site, YouGrow finds it there, approves it and closes its rows in Review (
                <Open href="/help/write-and-schedule#live">Check it&apos;s live</Open>).
              </>
            ) : null}
          </P>
        </>
      ) : null}

      <H2 id="check">Check it worked</H2>
      <Checks>
        <li>The line above the map reads &quot;All changes saved.&quot;</li>
        <li>
          On <Open href="/admin">Home</Open>, &quot;Save your brand map&quot; is ticked.
        </li>
        <li>
          A new blog draft offers your subjects under <strong>Subject (optional)</strong>.
        </li>
      </Checks>

      <H2 id="messages">If you see this</H2>
      <Messages
        rows={[
          [
            "There's nothing to research from yet: add your website in Settings, or a source in a programme's knowledge.",
            "Set your Primary domain in Settings › Sending, or add your website to a programme's Knowledge. Then research again.",
          ],
          ["Not saved yet: articles are written without it until you save.", "Press Save brand map."],
          ...(isNextUpRepeatsEnabled()
            ? ([
                ["Two live articles answer one question. Keep one, fold the other in, and redirect its address.", "Open both, keep the better one, move anything the other says that it lacks, then redirect the other's address on your site."],
                ["Unlinked. That article won't be matched to this question again, and Next up can offer it.", "Nothing to do. The question counts as open again."],
                ["That didn't start. Try again in a moment.", "Press Add to that article again, or open the article and press Review for refresh."],
              ] as Array<[string, string]>)
            : []),
          ...(isUsageMeterUiEnabled()
            ? ([
                [
                  WEB_SEARCH_LIMIT_MESSAGE,
                  "Research starts searching Google again on the 1st, or ask whoever runs your copy of YouGrow for more. Until then, add subjects, questions and buying situations by hand.",
                ],
              ] as Array<[string, string]>)
            : []),
          ...(isNextUpEnabled()
            ? ([
                ["Next up was chosen a moment ago. Try again in a few minutes.", "Wait a few minutes, then press Choose again."],
                ["Every question on your brand map is answered or planned. Add questions to choose from.", "Add questions to a subject, or accept suggested ones."],
              ] as Array<[string, string]>)
            : []),
          ...(isAutopilotEnabled()
            ? ([
                ["Draft isn't part of this brand's plan. Suggest is.", "Choose Suggest, or ask whoever runs your copy of YouGrow about Draft."],
                ["Choose the programme drafts go into.", "Pick a programme under Drafts go into, then Save."],
              ] as Array<[string, string]>)
            : []),
          [
            "None of your programmes has crawled your site yet, so no subject or name has a home page.",
            "Add your website as Website (crawl) in a programme's Knowledge. When it shows done, press Research again.",
          ],
          [
            "The brand map was changed elsewhere since you opened it.",
            "Press Load the latest to see their version, or Save mine anyway to keep yours.",
          ],
          ["That PDF is too large (14 MB at most).", "Split it into smaller PDFs and read each one."],
          ...(isBrandStrategyUiEnabled()
            ? ([
                [STRATEGY_ERRORS.strategy_changed!, "Look at what was saved, then make your change again."],
                [STRATEGY_ERRORS.finder_quick_used!, "Ask whoever runs your copy of YouGrow about the full competitor finder, or add competitors on Brand › Competitors."],
                [STRATEGY_ERRORS.finder_monthly_limit!, "Wait for the 1st, or add competitors on Brand › Competitors by hand."],
                [STRATEGY_ERRORS.nothing_found!, "Check What you are on Who you are says what you do in plain words, then try again."],
                [STRATEGY_ERRORS.map_not_saved!, "Press Save brand map on Who you are, then press Add again."],
                [STRATEGY_ERRORS.too_few_focus!, "Star more situations under Who it's for, then press Approve strategy again."],
                [STRATEGY_ERRORS.no_suggestion!, "Look at the list again: it may be watched now. Press Find competitors to search again."],
                [STRATEGY_ERRORS.competitors_unreadable!, "Wait a moment, then press Approve strategy again."],
              ] as Array<[string, string]>)
            : []),
          ...(isBrandStrategyUiEnabled() && isContentStrategyUiEnabled()
            ? ([
                [PLAN_ERRORS.plan_changed!, "Look at what was saved, then make your change again."],
                [PLAN_ERRORS.nothing_to_plan!, "Add questions on Subjects or Buying situations, then press Make the plan again."],
                [PLAN_ERRORS.slot_full!, "Split a question out of one of the two slots, then join them."],
                [PLAN_ERRORS.plan_too_large!, "Remove questions you don't plan to write about, then press Make the plan again."],
              ] as Array<[string, string]>)
            : []),
          [
            "The AI model isn't set up in this environment, so research can't run.",
            "Whoever runs your YouGrow needs to set up the AI model. Until then, fill the map in yourself.",
          ],
        ]}
      />

      <NextPage slug="brand-map" />
    </article>
  );
}
