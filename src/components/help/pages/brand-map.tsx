import { H1, H2, Lead, P, UL } from "@/components/developers/Doc";
import { BeforeAndUnlocks, Checks, Messages, Meta, NextPage, Open, Steps, Warning } from "@/components/help/blocks";
import { isBlogLiveWatchEnabled, isBrandMapScaleEnabled, isBrandMapSituationAskUiEnabled } from "@/lib/brandMap/flags";
import { isConnectorSignalsEnabled } from "@/lib/connectors/flags";
import { SIGNALS_HELP } from "@/lib/connectors/helpText";
import type { HelpBodyProps } from "@/lib/help/pages";
import { isCompetitorsUiEnabled } from "@/lib/competitors/flags";
import { isAutopilotEnabled, isNextUpEnabled } from "@/lib/autopilot/flags";

export default function BrandMapHelp({ connectorSignals = isConnectorSignalsEnabled(), brandMapScale = isBrandMapScaleEnabled() }: HelpBodyProps = {}) {
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
