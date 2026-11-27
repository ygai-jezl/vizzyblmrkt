import { H1, H2, Lead, P, UL } from "@/components/developers/Doc";
import { isAutopilotEnabled } from "@/lib/autopilot/flags";
import { isBlogLiveWatchEnabled } from "@/lib/brandMap/flags";
import { isVizzyAddPersonEnabled, isVizzyFieldsEnabled } from "@/lib/audience/peopleFlags";
import { isConnectorsCollectEnabled, isConnectorSignalsEnabled, isConnectorsSharingEnabled } from "@/lib/connectors/flags";
import { isOnboardingEnabled } from "@/lib/onboarding/flags";
import { isAgentRecordEnabled } from "@/lib/agentRecord/flags";
import { isRaiseFollowupsEnabled } from "@/lib/raise/pipeline/flags";
import { REVIEW_WORDS as FOLLOW_UP_WORDS } from "@/lib/raise/pipeline/words";
import { SIGNALS_HELP } from "@/lib/connectors/helpText";
import { BeforeAndUnlocks, Checks, Messages, Meta, NextPage, Open, Steps, Warning } from "@/components/help/blocks";
import type { HelpBodyProps } from "@/lib/help/pages";

/**
 * Vizzy's suggestions about people show while AUDIENCE_VIZZY_FIELDS_ENABLED or
 * AUDIENCE_VIZZY_ADD_PERSON_ENABLED is on, data sources that need someone while
 * CONNECTORS_COLLECT_ENABLED is, and what your numbers suggest while CONNECTOR_SIGNALS_ENABLED is
 * too (the How to drawer passes the shell's answers). While organisations share connections
 * (CONNECTORS_SHARING_ENABLED, a server switch), a data source your organisation gives your brand
 * names the organisation and who can fix it. While getting to know a brand is on (ONBOARDING_ENABLED),
 * admins also see what Vizzy heard about the business in a chat. While the agent record is on
 * (AGENT_RECORD_ENABLED), Drafts from Vizzy also lists, for admins, the email and image style and the
 * notes Vizzy suggested, and Vizzy can say what happened to the drafts it made.
 * While the investor and funding board's follow-ups are on (RAISE_FOLLOWUPS_ENABLED), the team
 * sees Follow-ups from your board.
 */
export default function ReviewAndApprovalsHelp({
  vizzyFields = isVizzyFieldsEnabled(),
  vizzyAddPerson = isVizzyAddPersonEnabled(),
  connectorsCollect = isConnectorsCollectEnabled(),
  connectorSignals = isConnectorSignalsEnabled(),
  sharing = isConnectorsSharingEnabled(),
  onboarding = isOnboardingEnabled(),
  agentRecord = isAgentRecordEnabled(),
  raiseFollowUps = isRaiseFollowupsEnabled(),
}: HelpBodyProps = {}) {
  const numbers = connectorsCollect && connectorSignals;
  return (
    <article>
      <H1>Review and approvals</H1>
      <Lead>One place for every decision waiting on you. Vizzy drafts. You decide what goes out.</Lead>
      <Meta items={["A few minutes a day", "Admins", "Whenever Review shows a count"]} />

      <BeforeAndUnlocks
        before={
          <>
            <li>Admin access to your brand</li>
            <li>For AI lines: a connected product that sends an insight for each person</li>
          </>
        }
        unlocks={
          <>
            <li>Vizzy&apos;s drafts going live, once you&apos;ve checked them</li>
            <li>Personal AI lines in your journey emails</li>
          </>
        }
      />

      <Warning>
        AI lines have a deadline. They appear about 12 hours before their email is due, and anything you don&apos;t decide in
        time goes out as the standard version.
      </Warning>

      <H2 id="what">What lands in Review</H2>
      <P>
        Open <Open href="/admin/approvals">Review</Open> in the sidebar. Each item links to where you act on it.
      </P>
      <UL>
        <li>
          <strong>AI lines for upcoming emails</strong>: personal lines waiting for approval.
        </li>
        <li>
          <strong>Posts that need you</strong>: scheduled posts that couldn&apos;t publish.
        </li>
        <li>
          <strong>Connection problems</strong>: your product&apos;s context endpoint keeps failing.
        </li>
        {connectorsCollect ? (
          <li>
            <strong>Data sources that need you</strong>: a connected tool that can&apos;t be read, has no property chosen, has
            failed to collect for 3 days, or was paused a week ago, so no new numbers are collected for it. Admins only. Its
            link opens it on Connected (<Open href="/help/connected-data#collected">Collected numbers</Open>).
            {sharing ? (
              <>
                {" "}
                A site, property or zone your organisation gives your brand names the organisation instead, as in &quot;Search
                Console from Acme Group can&apos;t be read since 21 Nov&quot;, because only its owners can fix it. An owner
                gets <strong>Fix</strong>, which opens Settings › Organisation, and any other admin <strong>See it</strong>, which
                opens it on Connected (<Open href="/help/connected-data#from-organisation">A part from your organisation</Open>).
              </>
            ) : null}
          </li>
        ) : null}
        <li>
          <strong>Drafts from Vizzy</strong>: journeys, welcome emails, invite waves and content plans.
          {agentRecord
            ? " Admins also see an email or image style Vizzy suggested, which opens Brand › Email style or Brand › Image style, and one row for the notes Vizzy suggested in your chats, which opens What we've seen."
            : ""}
        </li>
        {vizzyFields ? (
          <li>
            <strong>Suggestions about people</strong>: changes to someone&apos;s fields that Vizzy suggested. Each opens their page,
            where an admin confirms or dismisses it (<Open href="/help/your-audience#vizzy">Vizzy and their fields</Open>).
            {vizzyAddPerson ? " Admins also see New person forms Vizzy filled in, which open the form to check and add them." : ""}
          </li>
        ) : vizzyAddPerson ? (
          <li>
            <strong>Suggestions about people</strong>: New person forms Vizzy filled in, listed for admins only. Each opens the form,
            where an admin checks it, says how they agreed and adds them (<Open href="/help/your-audience#add">Add someone by hand</Open>).
          </li>
        ) : null}
        {raiseFollowUps ? (
          <li>
            <strong>{FOLLOW_UP_WORDS.title}</strong>: people on your investor or funding board who have been quiet for 14 days, or whose
            next step date has passed. Everyone on the team sees them; admins press <strong>{FOLLOW_UP_WORDS.followedUp}</strong> or{" "}
            <strong>{FOLLOW_UP_WORDS.dismiss}</strong> (<Open href="/help/investors-and-funding#follow-ups">Follow-ups in Review</Open>).
          </li>
        ) : null}
        {onboarding ? (
          <li>
            <strong>About your business</strong>: something new Vizzy heard about your business in a chat, listed for admins
            only. <strong>Check</strong> opens Settings, About your business, where an admin keeps or removes it (
            <Open href="/help#about-you">Tell Vizzy about your business</Open>).
          </li>
        ) : null}
        <li>
          <strong>Learned from your repo</strong>: steps, events and facts to accept into your catalog.
        </li>
        <li>
          <strong>Brand map suggestions</strong> and <strong>Content waiting for approval</strong>.
        </li>
        <li>
          <strong>Your strategy against competitors</strong>: where your copy of YouGrow checks your approved strategy each
          week, one row when your competitors moved on it, with each reason in full. <strong>Review the strategy</strong> opens
          the Strategy tab, and an admin can <strong>Dismiss</strong> it for 30 days (
          <Open href="/help/brand-map">Brand map</Open>).
        </li>
        {isAutopilotEnabled() ? (
          <li>
            <strong>Your next article</strong>: a question autopilot sorted and left ready to write, questions a draft asks
            your team, and a run that couldn&apos;t finish (<Open href="/help/brand-map#autopilot">Autopilot</Open>).
          </li>
        ) : null}
        {numbers ? (
          <li>
            <strong>What your numbers suggest</strong>: searches and pages from Search Console worth an article, with Plan an
            article and Dismiss. Admins only (<Open href="/help/review-and-approvals#numbers">Plan or dismiss them</Open>).
          </li>
        ) : null}
      </UL>

      <H2 id="drafts">Check Vizzy&apos;s drafts</H2>
      <P>
        Vizzy only ever saves drafts. It never publishes a journey, sends an invite or turns anything on. That stays with you.
      </P>
      <Steps>
        <li>
          Under <strong>Drafts from Vizzy</strong>, press <strong>Open</strong>.
        </li>
        <li>Read the draft and change anything you like.</li>
        <li>When you&apos;re happy, publish it, send it or approve it on that page. It then leaves Review.</li>
      </Steps>
      {agentRecord ? (
        <>
          <P>
            A style Vizzy suggested leaves Review once an admin saves it or dismisses it on its page. The notes row counts the notes
            nobody has kept or removed yet on <Open href="/admin/brand-kit/notes">What we&apos;ve seen</Open>, and says 50 or more
            once there are that many. Articles use only the notes you keep.
          </P>
          <P>
            YouGrow keeps a record of what Vizzy, research and autopilot drafted for your brand: when each was saved, and whether
            someone kept it as it was, kept it after changing it, or dismissed it. Ask Vizzy &quot;what happened to the drafts you
            made this month?&quot; and it answers from that record. The record starts when it was turned on for your brand, so
            older drafts aren&apos;t in it. A draft nobody decides closes after 90 days, which never counts as a no.
          </P>
        </>
      ) : null}
      {isBlogLiveWatchEnabled() ? (
        <P>
          A blog article you publish on your own site doesn&apos;t need approving here: once YouGrow finds it live, it is
          approved and its rows leave Review on their own (<Open href="/help/write-and-schedule#live">Check it&apos;s live</Open>).
        </P>
      ) : null}

      {numbers ? (
        <>
          <H2 id="numbers">Plan or dismiss what your numbers suggest</H2>
          <P>
            Once a day YouGrow looks at your Search Console numbers for pages losing Google clicks, questions on your brand
            map that sit just off Google&apos;s first page, and searches more people make. Each suggestion says what it saw,
            with its numbers and days.
          </P>
          <Steps>
            <li>
              Under <strong>What your numbers suggest</strong>, read the suggestion and its numbers.
            </li>
            <li>
              Press <strong>Plan an article</strong>. With more than one programme, choose which one. Drafts opens with the
              question, the page or the search filled in.
            </li>
            <li>
              Or press <strong>Dismiss</strong>. It won&apos;t come back for 30 days.
            </li>
          </Steps>
          <P>
            {SIGNALS_HELP.planning} A search more people make waits on your brand map as a proposed question instead, when
            your map is kept at any size (<Open href="/help/brand-map#from-searches">Questions from Google searches</Open>).
          </P>
        </>
      ) : null}

      <H2 id="ai-lines">Approve AI lines</H2>
      <P>
        An email in a product journey can carry one personal line, written from that person&apos;s own results. Turn it on
        per email: on the journey&apos;s <strong>Content</strong> tab, set <strong>AI line</strong> to{" "}
        <strong>Reviewed</strong>. Numbers only ever come from your product&apos;s insight. The AI line can&apos;t add any.
      </P>
      <Steps>
        <li>
          In Review, start with <strong>AI lines for upcoming emails</strong>. It always comes first.
        </li>
        <li>
          Read the product&apos;s insight and the AI line after it. Press <strong>Preview</strong> to see the whole email.
        </li>
        <li>Edit the line or the subject if you need to.</li>
        <li>
          Press <strong>Approve</strong> (<strong>Save &amp; approve</strong> after an edit). Or choose{" "}
          <strong>Use standard version</strong> or <strong>Skip this email</strong>.
        </li>
      </Steps>
      <P>
        An approved line goes out only if the insight is still current and the line still passes the checks. Otherwise the
        standard version sends. If a line is marked <strong>backfill</strong>, nothing sends to that person unless you approve
        it or choose the standard version.
      </P>

      <H2 id="check">Check it worked</H2>
      <Checks>
        <li>When everything is handled, Review says &quot;Nothing needs you right now.&quot;</li>
        <li>
          The count next to <strong>Review</strong> in the sidebar goes down.
        </li>
        <li>
          On the AI lines&apos; <strong>Decided</strong> tab, each line shows what happened, such as &quot;Sent with the AI
          line&quot;.
        </li>
      </Checks>

      <H2 id="messages">If you see this</H2>
      <Messages
        rows={[
          [
            "Nothing waiting. New lines appear about 12 hours before their email is due.",
            "Nothing to do yet. Lines only appear for emails with AI line set to Reviewed.",
          ],
          ["That one's too close to its send time", "The deadline has passed. That email goes out as the standard version."],
          ["no decision before the send", "Shown on the Decided tab. Nobody decided in time, so the standard version went out."],
          [
            "the product had no insight for this person",
            <>
              Your product sent no insight for them, so the standard version went out. Ask your developer, and see{" "}
              <Open href="/help/connect-your-product">Connect your product</Open>.
            </>,
          ],
          [
            "Your product's context endpoint keeps failing",
            "Open the product from Connection problems and fix the endpoint with your developer. Until then, AI lines fall back to the standard version.",
          ],
          ...(numbers
            ? ([
                ["Dismissed. It won't come back for 30 days.", "The suggestion left Review. If its numbers still say the same after 30 days, it can come back."],
                [
                  "That suggestion was decided already. Refresh Review to see what is waiting.",
                  "Someone on your team planned or dismissed it a moment ago. Refresh Review.",
                ],
                ["Choose the programme to write it in, or add one first.", "Press Plan an article again and choose a programme, or add one under Content first."],
                ["That suggestion couldn't be checked just now. Try again in a minute.", "A check behind it didn't answer for a moment. The suggestion is still there: press Plan an article again."],
              ] as Array<[string, string]>)
            : []),
          [
            "AI lines are switched off",
            "Whoever runs your YouGrow has switched AI lines off. Emails send as the standard version until they're back on.",
          ],
        ]}
      />

      <NextPage slug="review-and-approvals" />
    </article>
  );
}
