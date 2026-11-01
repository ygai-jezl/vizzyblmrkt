import { H1, H2, Lead, P } from "@/components/developers/Doc";
import { BeforeAndUnlocks, Checks, Messages, Meta, NextPage, Open, Steps, Warning } from "@/components/help/blocks";
import { isBrandNotesQuestionsUiEnabled, isBrandNotesRestUiEnabled, isBrandNotesUiEnabled } from "@/lib/brandNotes/flags";
import { isSiteSignupsEnabled } from "@/lib/waitlist/siteFlags";
import { isBlogAiSummaryUiEnabled } from "@/lib/content/blog/flags";
import { isEditModeEnabled } from "@/lib/content/editor/flags";
import { isNewsletterMarkdownEmailUiEnabled } from "@/lib/email/flags";

export default function WriteAndScheduleHelp() {
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
      <P>
        You can also ask Vizzy. Press <strong>Ask Vizzy</strong> in the sidebar and say what you want, such as &quot;Draft a
        LinkedIn series about our launch&quot;. Vizzy only drafts. You approve, schedule and publish.
      </P>

      <H2 id="schedule">Schedule posts</H2>
      <Steps>
        <li>
          Connect LinkedIn or X in <Open href="/admin/account/connections">Settings › Integrations</Open>.
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
        <li>
          On <Open href="/admin">Home</Open>, &quot;Schedule your first post&quot; and &quot;Send a newsletter to your
          waitlist&quot; are ticked.
        </li>
      </Checks>

      <H2 id="messages">If you see this</H2>
      <Messages
        rows={[
          ["Give this workflow a name.", "Type a Workflow name on the Strategy step."],
          [
            "Research didn't finish. You can still write the article, or try again.",
            "Try again in a minute, or let the article be written without it.",
          ],
          ["That item isn't generated yet", "Open it in Drafts and generate it first."],
          ["Connect LinkedIn in Settings › Integrations first", "Connect it, then press Schedule again."],
          ["Connect X in Settings › Integrations first", "Connect it, then press Schedule again."],
          [
            "That LinkedIn Page isn't connected.",
            "Connect LinkedIn Pages while signed in to LinkedIn as an admin of the Page, or choose to post as yourself.",
          ],
          [
            "Nobody has joined this launch's weekly newsletter yet",
            "Add the weekly newsletter step to the launch's welcome journey (step 1 above), and wait for someone to reach it.",
          ],
          ["Pick a future date and time.", "The newsletter's scheduled time has passed. Pick a later one, or leave it empty to send now."],
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
