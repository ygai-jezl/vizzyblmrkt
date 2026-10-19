import { H1, H2, Lead, P } from "@/components/developers/Doc";
import { BeforeAndUnlocks, Checks, Messages, Meta, NextPage, Open, Steps, Warning } from "@/components/help/blocks";
import { isBrandMapSituationAskUiEnabled } from "@/lib/brandMap/flags";

export default function BrandMapHelp() {
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
        <li>
          Under <strong>Suggestions</strong>, untick anything wrong. Press <strong>Add ticked</strong>, then{" "}
          <strong>Dismiss the rest</strong>.
        </li>
        <li>
          Press <strong>Save brand map</strong>.
        </li>
        <li>
          Open <strong>Subjects</strong>. New subjects from research wait under <strong>Proposed</strong>. Press{" "}
          <strong>Add</strong> or <strong>Dismiss</strong> on each. Changes on this tab save straight away.
        </li>
      </Steps>

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
