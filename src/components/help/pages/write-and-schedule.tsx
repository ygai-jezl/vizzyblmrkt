import { H1, H2, Lead, P } from "@/components/developers/Doc";
import { BeforeAndUnlocks, Checks, Messages, Meta, NextPage, Open, Steps, Warning } from "@/components/help/blocks";
import { isBrandNotesQuestionsUiEnabled, isBrandNotesRestUiEnabled, isBrandNotesUiEnabled } from "@/lib/brandNotes/flags";
import { isSiteSignupsEnabled } from "@/lib/waitlist/siteFlags";
import { isBlogAiSummaryUiEnabled } from "@/lib/content/blog/flags";
import { isEditModeEnabled, isEditModeVizzyEnabled, isEditModeVizzyLearningEnabled } from "@/lib/content/editor/flags";
import { isAiDraftKeptEnabled } from "@/lib/content/create/flags";
import { isLearnFromPostEditsEnabled, isPostResultsEnabled } from "@/lib/distribute/flags";
import { isNewsletterMarkdownEmailUiEnabled } from "@/lib/email/flags";
import { isSignalsDataForSeoEnabled } from "@/lib/signals/flags";
import { isAutopilotEnabled } from "@/lib/autopilot/flags";
import { isBlogDatesUiEnabled, isBlogFreshnessUiEnabled, isBlogLiveWatchEnabled } from "@/lib/brandMap/flags";
import { isConnectorSignalsEnabled } from "@/lib/connectors/flags";
import type { HelpBodyProps } from "@/lib/help/pages";
import { isUsageMeterUiEnabled } from "@/lib/plans/flags";
import { WEB_SEARCH_LIMIT_MESSAGE } from "@/lib/plans/resources";

/** The How to drawer passes the server's switches (connectorSignals): it can't read them itself. */
export default function WriteAndScheduleHelp({ connectorSignals = isConnectorSignalsEnabled() }: HelpBodyProps = {}) {
  return (
    <article>
      <H1>Write and schedule</H1>
      <Lead>Draft posts, articles and newsletters with Vizzy, then put them on your calendar.</Lead>
      <Meta items={["About 15 minutes for your first draft", "Anyone on your team", "Every week"]} />

      <BeforeAndUnlocks
        before={
          <>
            <li>
              A programme with knowledge (<Open href="/help/programmes-and-knowledge">Programmes and knowledge</Open>)
            </li>
            <li>
              LinkedIn or X connected, to post (<Open href="/help/connected-accounts#social">Connected accounts</Open>)
            </li>
            <li>
              A launch, for the newsletter (<Open href="/help/launch-and-waitlist">Launch and waitlist</Open>)
            </li>
          </>
        }
        unlocks={
          <>
            <li>Posts that go out on LinkedIn or X at the time you pick</li>
            <li>A weekly newsletter to your waitlist</li>
          </>
        }
      />

      <Warning>
        Connect LinkedIn or X before you schedule. YouGrow won&apos;t schedule a post until the account it goes out from is
        connected.
      </Warning>

      <H2 id="scrapbook">Save clippings in the Scrapbook</H2>
      <P>
        The Scrapbook keeps posts you admire, links, screenshots and quick thoughts, so you can write from them later. Each one
        is a clipping.
      </P>
      <Steps>
        <li>
          Open your programme, then <strong>Scrapbook</strong>.
        </li>
        <li>
          Paste a link, paste the text or jot a thought, or press <strong>Add screenshot</strong>. Any one of them is enough.
        </li>
        <li>
          Press <strong>Save clipping</strong>. It shows below, with where it came from: a site, a screenshot or text.
        </li>
        <li>
          To reuse its shape, press <strong>Templatize</strong>. Vizzy turns it into a template on the{" "}
          <strong>Templates</strong> tab, and the clipping then shows <strong>View template</strong>.
        </li>
        <li>
          To remove a clipping, press <strong>Delete</strong>.
        </li>
      </Steps>
      <P>
        YouGrow can&apos;t read pages on LinkedIn, X, Instagram, Facebook, Threads, TikTok or YouTube from the link alone. For
        those, paste the text or add a screenshot too, so the template comes out right.
      </P>

      <H2 id="write">Write a draft</H2>
      <Steps>
        <li>
          Open your programme, then <strong>Drafts</strong>. If the wizard isn&apos;t open, press <strong>+ New workflow</strong>.
        </li>
        <li>
          <strong>Strategy</strong>: type a <strong>Workflow name</strong> and pick an <strong>Objective</strong>. Press{" "}
          <strong>Next</strong>.
        </li>
        <li>
          <strong>Scope</strong>: pick your <strong>Authority topics</strong> and write the <strong>Spark</strong>, the point
          you want to make. Press <strong>Next</strong>.
        </li>
        <li>
          <strong>Knowledge</strong>: leave <strong>Global</strong> to use all of the programme&apos;s knowledge. Press{" "}
          <strong>Next</strong>.
        </li>
        <li>
          <strong>Topology</strong>: choose a <strong>Hub channel</strong> (Newsletter or Blog) and the{" "}
          <strong>Spoke channels</strong> to post on. Press <strong>Build workflow</strong>.
        </li>
        <li>
          On the canvas, press <strong>Generate hub</strong>. Click the hub, read it, then press <strong>Approve</strong>.
        </li>
        <li>
          Press <strong>Generate spokes &amp; promos</strong>. Read each one and approve the ones you&apos;ll use.
        </li>
      </Steps>
      <P>
        For a <strong>Blog (SEO/GEO)</strong> hub, <strong>Generate hub</strong> first researches what buyers ask on the web
        and in your cite sources, then writes the article and checks its facts. It follows your brand map once the map is
        saved. Under <strong>Export</strong>, press <strong>Copy Markdown</strong> or <strong>Copy HTML</strong> to put it on
        your site.
      </P>
      {connectorSignals ? (
        <P>
          From <Open href="/help/review-and-approvals#numbers">Review</Open>, <strong>Plan an article</strong> on a suggestion
          your numbers made opens the wizard with a line such as &quot;Writing next from your numbers: fewer Google clicks to
          /pricing.&quot; and its page or search as the <strong>Workflow name</strong>. For a page losing clicks, its address is
          filled in as the <strong>Hub URL</strong>; for a question on your brand map, the wizard starts from that question.
        </P>
      ) : null}
      {isEditModeEnabled() ? (
        <P>
          To edit an article or a newsletter the way readers will see it, click the hub and press <strong>Edit mode</strong>{" "}
          beside <strong>Final copy</strong>. Headings, bold, lists, links, tables and boxes such as <strong>Key facts</strong>{" "}
          look as they will on the page, with the article&apos;s checks and an outline beside the text. Press{" "}
          <strong>Save</strong> when you&apos;re done. What&apos;s saved is still Markdown, so <strong>Copy Markdown</strong>, the
          checks and Vizzy work as before, and <strong>Markdown</strong> at the top shows the text itself. Changes you
          haven&apos;t saved stay in this browser until you close the tab, and Edit mode offers them back when you open it again.
        </P>
      ) : null}
      {isEditModeEnabled() && isEditModeVizzyEnabled() ? (
        <P>
          In Edit mode, the <strong>Vizzy</strong> tab beside <strong>Checks</strong> changes the text for you. Select some words
          and press <strong>Ask Vizzy</strong>, or one of <strong>Shorter</strong>, <strong>Plainer</strong> and{" "}
          <strong>Fix grammar</strong>, and say what you want, such as &quot;make this less salesy&quot;. With nothing selected,
          Vizzy edits across the whole piece, such as &quot;use UK spelling&quot;. Each change shows in the text in green with{" "}
          <strong>Keep</strong> and <strong>Undo</strong>, and <strong>Show before</strong> shows what was there. Typing inside a
          change keeps it as yours. Nothing is saved until you press <strong>Save</strong>, which keeps any change you
          haven&apos;t kept or undone. Vizzy follows your brand voice and keeps links and merge values as they are.
        </P>
      ) : null}
      {isEditModeEnabled() && isEditModeVizzyLearningEnabled() ? (
        <P>
          Vizzy also learns how you like your edits from the changes you keep and undo, such as short intros or UK spelling, and
          uses that next time. <strong>What Vizzy remembers about how you edit</strong> on the Vizzy tab lists it. Only you see
          it, in this brand. <strong>Forget</strong> removes one, <strong>Forget everything</strong> removes them all, and
          clearing <strong>Learn from my edits</strong> stops Vizzy learning from them or using them. To learn, Vizzy sends what
          you asked and the words that changed, never the whole article, to Agent Platform Memory Bank in this copy of
          YouGrow&apos;s Google Cloud project. Anything not used for 6 months is forgotten. An admin can press{" "}
          <strong>Add to brand voice</strong> to make one a rule for the whole team in Brand kit.
        </P>
      ) : null}
      {isBlogAiSummaryUiEnabled() ? (
        <P>
          Once the article is approved and has its address (the <strong>Hub URL</strong> when you start the draft, or{" "}
          <strong>Article address</strong> on the hub where it shows), <strong>Summarize with AI</strong> under{" "}
          <strong>Export</strong> gives
          links that open ChatGPT, Claude, Perplexity and Google AI Mode with a prompt to summarize the article and cite your
          brand. The prompt is written from the article&apos;s title and its first sections. Press{" "}
          <strong>Copy buttons HTML</strong> or <strong>Copy links Markdown</strong> and paste them near the top or the end of
          the article on your site. Editing the article takes its approval away, so approve it again for links that match.
          Gemini isn&apos;t there yet, because its app can&apos;t take a prompt from a link.
        </P>
      ) : null}
      {isBrandNotesUiEnabled() ? (
        <P>
          Blog articles are written the way a practitioner writes: the answer first, the trade-offs and the common mistakes,
          and your brand kept to the margins. In the hub&apos;s <strong>Brief</strong>, <strong>What we&apos;ve seen</strong>{" "}
          shows the notes from <Open href="/help/your-brand#seen">your team&apos;s experience</Open> that fit the
          article&apos;s question; remove any that don&apos;t belong.{" "}
          {isBrandNotesQuestionsUiEnabled() ? (
            <>
              {isBrandNotesRestUiEnabled() ? (
                <>
                  A note another article used lately rests: it is listed apart with the reason, and <strong>Use anyway</strong>{" "}
                  adds it. Every article also asks your team three new questions, so each one can say something your other
                  articles don&apos;t.
                </>
              ) : (
                <>When nothing fits, it asks your team up to three questions.</>
              )}{" "}
              Press <strong>+</strong> beside one to answer it in its own box. The answer saves as you type: once it says <strong>Saved to What we&apos;ve seen</strong>, it is one of
              your team&apos;s notes. Every question is kept on What we&apos;ve seen too, answered or not, linked to the article,
              so another article that needs the same answer can ask it again.
            </>
          ) : (
            <>When nothing fits, answer one of the questions it suggests and the article can speak from experience.</>
          )}{" "}
          Under <strong>Publisher</strong>, add the author&apos;s role and a short bio for the byline and the author box at the
          end.
        </P>
      ) : null}
      {isAutopilotEnabled() ? (
        <P>
          A workflow the autopilot is writing says <strong>Autopilot is writing this workflow</strong> at the top. Edits
          don&apos;t save until it finishes; press <strong>Take over</strong> to stop it and carry on yourself (
          <Open href="/help/brand-map#autopilot">Autopilot</Open>).
        </P>
      ) : null}
      {isSignalsDataForSeoEnabled() ? (
        <>
          <H2 id="get-from-google">Get from Google</H2>
          <P>
            <strong>Get from Google</strong> under <strong>What buyers ask</strong>, when you create a blog and later in the
            blog hub&apos;s <strong>Brief</strong>, looks the article&apos;s question up on Google for you. Gemini checks each
            thing Google shows (People also ask, and what else people search for) against the article and your brand map,
            and only what fits is added. Under the button, <strong>What was left out, and why</strong> lists the rest: off
            topic, or for another article. It only adds lines, so what you typed stays. Research reads them as leads, like
            anything else you paste there.
          </P>
          <P>
            It searches your brand&apos;s Google market: an admin picks the country and language under{" "}
            <strong>Google market</strong> in <Open href="/admin/account/settings">Settings › General</Open> (United States,
            English until then). An answer usually comes within a minute. A question looked up in the last 90 days is used
            again without counting. Each brand has a number of lookups a month, shown under the button.
          </P>
        </>
      ) : null}
      <P>
        You can also ask Vizzy. Press <strong>Ask Vizzy</strong> in the sidebar and say what you want, such as &quot;Draft a
        LinkedIn series about our launch&quot;. Vizzy only drafts. You approve, schedule and publish.
      </P>

      {isBlogLiveWatchEnabled() ? (
        <>
          <H2 id="live">Check it&apos;s live</H2>
          <P>
            Once you know where a blog article will live, put its address under <strong>Article address</strong> on the hub.
            YouGrow opens the page and looks for the article&apos;s text there, so it finds the article even when your site
            gives the page its own title. It checks as soon as you save the address, then every few hours for two weeks.
          </P>
          <P>
            Or leave the address empty. YouGrow reads your site&apos;s sitemap every few hours while articles are waiting to go
            up. It opens new pages whose address shares the article&apos;s words, and when most of the article&apos;s text is
            on one, it saves that address for you. Your site is the <strong>Site</strong> on your{" "}
            <Open href="/help/brand-map">brand map</Open>, or your brand&apos;s domain.
          </P>
          <P>
            An article found live is approved, as if you had pressed <strong>Approve</strong>: your brand map counts its
            question as answered and its rows leave Review. <strong>Check it&apos;s live</strong> checks straight away.{" "}
            <strong>It&apos;s live</strong> is for a site that turns the check away, and approves it too.{" "}
            <strong>Not live</strong> takes the live mark away and keeps the approval.
          </P>
        </>
      ) : null}

      {isBlogDatesUiEnabled() ? (
        <>
          <H2 id="dates">Article dates</H2>
          <P>
            A blog article shows two dates under its title: <strong>Published</strong>, the day the page went up, and{" "}
            <strong>Updated</strong>, the day it last changed for real. Copy Markdown, Copy HTML and the markup carry the same
            dates, and the markup adds the time in your brand&apos;s time zone, as Google asks.
          </P>
          <P>
            Published comes from your page&apos;s own date when it shows one. Otherwise it is the day YouGrow first saw the
            article live, or the day you give with <strong>It&apos;s live</strong>. Until the article is live, the date line
            says today, the day you copy it.
          </P>
          <P>
            Updated moves only for a real change, never to make a page look new. When your page carries its own updated
            date, a later day shows here too.
          </P>
          <P>
            Set your time zone in <Open href="/admin/account/settings">Settings › General</Open>. Until you do, dates are in
            UTC.
          </P>
        </>
      ) : null}

      {isBlogFreshnessUiEnabled() ? (
        <>
          <H2 id="freshness">Article freshness</H2>
          <P>
            Once a blog article is live, YouGrow looks at it once a day and gives it one of three states:{" "}
            <strong>Fresh</strong>, <strong>Review soon</strong> or <strong>Due a refresh</strong>. The{" "}
            <strong>Freshness</strong> card on the article&apos;s hub says which, and why.
          </P>
          <P>
            Each live article has a clock of 20, 30 or 45 days, counted from the day it went live, was last updated or was last
            checked. YouGrow spreads new articles across the three clocks, so you learn which works for your brand. To use one
            clock for every article, an admin chooses it under <strong>Refresh clock</strong> on{" "}
            <Open href="/admin/brand-kit/map">Brand › Brand map</Open>.
          </P>
          <P>
            An article is due a refresh when it passes its clock, or sooner for a strong reason: fewer Google clicks to its page,
            a link that no longer opens, or a figure from two or more years ago. Review soon means it is within 5 days of its
            clock, or has a weaker reason: it sits just off Google&apos;s first page, it cites old sources, its subject has new
            questions that no live page answers, or your page shows no date.
          </P>
          <P>
            Due articles show in <Open href="/admin/approvals">Review</Open> under <strong>Articles due a refresh</strong>, and
            with a pill in the programme&apos;s list of articles. Next up can offer one as a pick, and a Search Console
            suggestion about one of your live articles says <strong>Refresh this article</strong>. Vizzy can list them too: ask
            &quot;which articles need refreshing?&quot;
          </P>
          <P>
            Looked, and nothing needs to change? Press <strong>Checked, nothing to change</strong> on the Freshness card. The
            clock starts again from today, and Updated stays as it is, because the page didn&apos;t change.
          </P>
        </>
      ) : null}

      <H2 id="schedule">Schedule posts</H2>
      <Steps>
        <li>
          An admin connects LinkedIn or X in <Open href="/admin/account/connections">Settings › Connections</Open>.
        </li>
        <li>
          Open your programme, then <strong>Calendar</strong>.
        </li>
        <li>
          Under <strong>Ready to schedule</strong>, find the post. A post shows here once it&apos;s generated.
        </li>
        <li>
          For LinkedIn, choose who to <strong>Post as</strong>, if that choice shows.
        </li>
        <li>
          Pick a date and time in your own time zone and press <strong>Schedule</strong>. The list shows times in UTC.
        </li>
        <li>
          To move or stop a post, press <strong>Reschedule</strong> or <strong>Cancel</strong> on it.
        </li>
      </Steps>
      <P>Only LinkedIn and X posts go out for you. Other items are marked done at their time, so publish those yourself.</P>
      {isAiDraftKeptEnabled() ? (
        <P>
          When you change a LinkedIn or X post Vizzy wrote, its card says how many words you changed. Press{" "}
          <strong>Show changes</strong> to see them: words you took out are struck through and words you put in are highlighted.
        </P>
      ) : null}
      {isLearnFromPostEditsEnabled() ? (
        <P>
          Vizzy also learns how you edit its LinkedIn and X posts, such as cutting emoji or starting with a question, and uses
          that in your next drafts. Once a post you changed is published, Vizzy sends the words you changed, never the whole
          post, to Agent Platform Memory Bank in this copy of YouGrow&apos;s Google Cloud project. <strong>What Vizzy remembers
          about how you edit</strong> on the Calendar lists what it learned, the same list as in Edit mode. Only you see it, in
          this brand, and clearing <strong>Learn from my edits</strong> stops it.
        </P>
      ) : null}
      {isPostResultsEnabled() ? (
        <P>
          Two days after a LinkedIn company page or X post goes out, its card shows <strong>Results</strong>: impressions or
          views, reactions or likes, comments, reposts and, on LinkedIn, clicks. YouGrow reads them again each day until the
          post is a week old, then says how it did against your usual. Posts with at least 200 impressions and 5 actions that
          beat your usual become examples Vizzy follows when it drafts. Posts from a personal LinkedIn profile have no results.
        </P>
      ) : null}

      <H2 id="newsletter">Send the weekly newsletter</H2>
      <P>
        It goes to people on a launch&apos;s waitlist who reached the weekly newsletter step of its welcome journey. If nobody
        has yet, YouGrow tells you and sends nothing.
      </P>
      {isSiteSignupsEnabled() ? (
        <P>
          Newsletter sign-ups from your own site join a launch just for the newsletter, and Send this week&apos;s newsletter
          offers that launch first. See <Open href="/help/newsletter-from-your-site">Newsletter from your own site</Open>.
        </P>
      ) : null}
      <Steps>
        <li>
          Open your launch, then <strong>Emails</strong>, and press <strong>Edit journey</strong>. On an Exit step, tick{" "}
          <strong>Then add them to the weekly newsletter</strong>. On an older journey, press <strong>Add exit</strong>, then{" "}
          <strong>Subscribe to the weekly newsletter</strong>. Press <strong>Publish</strong>.
        </li>
        <li>
          Write a draft with a <strong>Newsletter</strong> hub and generate it.
        </li>
        <li>
          On your programme&apos;s <strong>Overview</strong>, press <strong>Send this week&apos;s newsletter</strong>.
        </li>
        <li>
          Press <strong>Send this week</strong> on the newsletter you want.
        </li>
        <li>
          Check the <strong>Subject line</strong> and the launch. Press <strong>Send now</strong>, or pick a time under{" "}
          <strong>Schedule for later</strong> and press <strong>Schedule</strong>.
        </li>
      </Steps>

      {isNewsletterMarkdownEmailUiEnabled() ? (
        <P>
          The newsletter goes out formatted: its headings, bold, lists and links arrive the way the hub&apos;s{" "}
          <strong>Preview</strong> shows them.
        </P>
      ) : null}

      <H2 id="check">Check it worked</H2>
      <Checks>
        <li>A scheduled post shows pending and its time. After that time it shows done and published (linkedin) or published (x).</li>
        <li>
          A LinkedIn or X post that says published (manual) wasn&apos;t posted. Whoever runs your YouGrow needs to switch on
          live posting.
        </li>
        <li>The newsletter shows on the Calendar.</li>
        {isPostResultsEnabled() ? (
          <li>Two days after a LinkedIn company page or X post went out, its card shows Results with its numbers.</li>
        ) : null}
        <li>
          On <Open href="/admin">Home</Open>, &quot;Schedule your first post&quot; and &quot;Send a newsletter to your
          waitlist&quot; are ticked.
        </li>
      </Checks>

      <H2 id="messages">If you see this</H2>
      <Messages
        rows={[
          ["Add a link, paste text, or attach a screenshot.", "The Scrapbook saves a clipping only with something in it. Add one, then press Save clipping."],
          [
            "Couldn't save that clipping.",
            "Try again. A screenshot has to be a PNG, JPEG or WebP image of 8MB or less.",
          ],
          ["Give this workflow a name.", "Type a Workflow name on the Strategy step."],
          [
            "Research didn't finish. You can still write the article, or try again.",
            "Try again in a minute, or let the article be written without it.",
          ],
          ...(isUsageMeterUiEnabled()
            ? ([
                [
                  WEB_SEARCH_LIMIT_MESSAGE,
                  "Research used your own sources only, and Google wasn't searched. Add pages and facts to the brief by hand, or research again after the 1st.",
                ],
              ] as Array<[string, string]>)
            : []),
          ["That item isn't generated yet", "Open it in Drafts and generate it first."],
          [
            "Connect LinkedIn in Settings › Connections first",
            "Ask an admin to connect it in Settings › Connections, then press Schedule again.",
          ],
          ["Connect X in Settings › Connections first", "Ask an admin to connect it in Settings › Connections, then press Schedule again."],
          [
            "That LinkedIn Page isn't connected.",
            "A YouGrow admin who is also an admin of the Page on LinkedIn connects LinkedIn Pages. Or choose to post as yourself.",
          ],
          [
            "Nobody has joined this launch's weekly newsletter yet",
            "Add the weekly newsletter step to the launch's welcome journey (step 1 above), and wait for someone to reach it.",
          ],
          ["Pick a future date and time.", "The newsletter's scheduled time has passed. Pick a later one, or leave it empty to send now."],
          ...(isBlogLiveWatchEnabled()
            ? ([
                [
                  "The page answers, but it isn't this article yet",
                  "Most of the article's text isn't on that page. Check the address, or wait until the article is up. If it is the right page, press It's live.",
                ],
                ["Your site turned the check away. If the article is up, say so.", "Your site doesn't let checks read it. Press It's live once the article is up."],
              ] as Array<[string, string]>)
            : []),
          ...(isBlogDatesUiEnabled()
            ? ([
                [
                  "Your page shows no date. Paste the date line, or let your site show its own.",
                  "Your live page carries no Published date. Copy the article again and paste its date line, or turn on your site's own post dates.",
                ],
                ["Give the day it went up: today or earlier.", "The day for It's live can't be in the future. Pick the day the page went up."],
              ] as Array<[string, string]>)
            : []),
          ...(isBlogFreshnessUiEnabled()
            ? ([
                [
                  "YouGrow looks at live articles once a day. This one gets its clock at the next look.",
                  "Nothing to do. The article's clock and state show after the next daily look.",
                ],
                ["Checked. The clock starts again from today, and Updated stays as it is.", "Your check is saved. The article is fresh again until its clock runs out."],
                ["Only admins can change the refresh clock.", "Ask an admin to choose the clock on Brand › Brand map."],
              ] as Array<[string, string]>)
            : []),
          ...(isSignalsDataForSeoEnabled()
            ? ([
                [
                  "This brand has used all its Google lookups for this month.",
                  "Questions looked up in the last 90 days still fill in. New ones can wait for next month, or ask whoever runs your copy of YouGrow for more.",
                ],
                [
                  "Google lookups aren't set up on this copy of YouGrow yet.",
                  "Whoever runs your copy of YouGrow adds a DataForSEO login. Until then, paste what Google shows by hand.",
                ],
                ["Google couldn't be asked just now. Try again in a few minutes.", "Try again later. A lookup that never arrived doesn't count."],
                [
                  "Google's results couldn't be checked for this article just now.",
                  "Nothing was added unchecked. Press Get from Google again in a minute: the results are kept, so it doesn't count twice.",
                ],
              ] as Array<[string, string]>)
            : []),
          ...(isPostResultsEnabled()
            ? ([
                [
                  "Too few views to learn from",
                  "The post's numbers still show. Vizzy only learns from posts with at least 200 impressions and 5 actions.",
                ],
                [
                  "No results for posts from a personal profile.",
                  "Results are read for company page posts. Choose your page in Post as when you schedule.",
                ],
                [
                  "Reconnect it in Settings › Connections so your next posts get results.",
                  "An admin reconnects the LinkedIn page or X account. This post's numbers aren't read again, but your next posts get results.",
                ],
                [
                  "wouldn't give this post's numbers, so YouGrow stopped reading them.",
                  "The post may have been deleted, or the account lost access to it. The numbers read before that still show.",
                ],
              ] as Array<[string, string]>)
            : []),
          ...(isBlogAiSummaryUiEnabled()
            ? ([
                ["Approve the article to get its Summarize with AI links.", "Read the article and press Approve."],
                [
                  "Add the article's address to make its links.",
                  "Set the address the article has, or will have, on your site: the Hub URL, or Article address on the hub where it shows.",
                ],
                ["Use the article's own https address to make its links.", "Use the article's full https address, not your home page."],
              ] as Array<[string, string]>)
            : []),
          ...(isEditModeEnabled()
            ? ([
                [
                  "Edit mode can't keep",
                  "The message names the part, such as a table with one column. Change that part in Markdown, or remove it, then press Edit mode again.",
                ],
                [
                  "can't be kept in Markdown, so it will be saved simpler.",
                  "Press Save anyway to save it without that formatting, or Keep editing to change it. Italics inside a word and lists inside lists are the usual causes.",
                ],
                [
                  "Save failed. Your changes are still here, so try again.",
                  "Check your connection and press Save again. Your text stays in this browser until you close the tab.",
                ],
                [
                  "That address can't be a link here.",
                  "Use a web address that starts with https://, a page on your site such as /pricing, or a section of the article such as #faq.",
                ],
                ["Shorten it to save.", "An article or a newsletter holds up to 20,000 characters. Cut it down, then save."],
              ] as Array<[string, string]>)
            : []),
          ...(isEditModeEnabled() && isEditModeVizzyEnabled()
            ? ([
                [
                  "Vizzy's version dropped",
                  "Vizzy keeps every link and merge value, so a change that loses one isn't used. Ask again, or select less.",
                ],
                [
                  "Those words appear more than once, so nothing changed there.",
                  "Select the words you mean and ask again, so Vizzy knows which place to change.",
                ],
                ["The text changed while Vizzy was working. Ask again.", "You edited the selected text while Vizzy worked on it. Ask again."],
                ["Vizzy took too long. Try a shorter piece or a narrower ask.", "Select a part of the text, or ask for one kind of change at a time."],
                [
                  "Vizzy has had a lot of requests from your brand. Try again in a minute.",
                  "Your team has asked Vizzy a lot in the last minute or hour. Wait a little, then ask again.",
                ],
                ["Vizzy editing isn't included for this brand.", "Ask whoever runs your copy of YouGrow to turn it on for your brand."],
                [
                  "kept or undone yet.",
                  "Some of Vizzy's changes are still marked in the text. Press Keep them to go on, or Review them to keep or undo each one.",
                ],
              ] as Array<[string, string]>)
            : []),
          ...(isEditModeEnabled() && isEditModeVizzyLearningEnabled()
            ? ([
                [
                  "Your brand voice already has 12 rules. Edit them in Brand kit first.",
                  "Open Brand kit, remove or merge a rule under Do, then press Add to brand voice again.",
                ],
              ] as Array<[string, string]>)
            : []),
          ...(isBrandNotesQuestionsUiEnabled()
            ? ([
                [
                  "Couldn't save. Your text is kept; it tries again as you type.",
                  "Check your connection and keep typing, or click outside the box. Anything not saved yet is saved before the article is written.",
                ],
              ] as Array<[string, string]>)
            : []),
        ]}
      />

      <NextPage slug="write-and-schedule" />
    </article>
  );
}
