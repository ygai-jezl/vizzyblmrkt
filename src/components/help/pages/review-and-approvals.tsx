import { H1, H2, Lead, P, UL } from "@/components/developers/Doc";
import { BeforeAndUnlocks, Checks, Messages, Meta, NextPage, Open, Steps, Warning } from "@/components/help/blocks";

export default function ReviewAndApprovalsHelp() {
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
        <li>
          <strong>Drafts from Vizzy</strong>: journeys, welcome emails, invite waves and content plans.
        </li>
        <li>
          <strong>Learned from your repo</strong>: steps, events and facts to accept into your catalog.
        </li>
        <li>
          <strong>Brand map suggestions</strong> and <strong>Content waiting for approval</strong>.
        </li>
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
