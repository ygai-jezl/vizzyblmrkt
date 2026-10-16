import { H1, H2, Lead, P } from "@/components/developers/Doc";
import { BeforeAndUnlocks, Checks, Messages, Meta, NextPage, Open, Steps, Warning } from "@/components/help/blocks";

export default function ProgrammesAndKnowledgeHelp() {
  return (
    <article>
      <H1>Programmes and knowledge</H1>
      <Lead>
        A programme is one line of content, such as a newsletter or a LinkedIn series. Its knowledge is what Vizzy writes
        from.
      </Lead>
      <Meta items={["About 10 minutes, plus reading time", "Anyone on your team", "Once per programme"]} />

      <BeforeAndUnlocks
        before={
          <>
            <li>Your website&apos;s address</li>
            <li>
              Your brand voice, if you have it (<Open href="/help/your-brand">Your brand</Open>)
            </li>
          </>
        }
        unlocks={
          <>
            <li>Drafts that use your own facts and words</li>
            <li>Research for your brand map</li>
            <li>Studies and reports your blog articles can cite</li>
          </>
        }
      />

      <Warning>
        Add knowledge before you write. Without it, drafts are generic, and the draft wizard only shows a quiet hint (&quot;No
        vectorized sources yet&quot;) and carries on.
      </Warning>

      <H2 id="start">Create a content programme</H2>
      <Steps>
        <li>
          Open <Open href="/admin/workspace">Content</Open>.
        </li>
        <li>
          Press <strong>+ New programme</strong>.
        </li>
        <li>
          Type a <strong>Programme name</strong>, such as &quot;Weekly newsletter&quot;. Add a description if you like.
        </li>
        <li>
          Press <strong>Create programme</strong>. It opens on its <strong>Overview</strong>.
        </li>
        <li>
          Open the <strong>Settings</strong> tab. Tick the <strong>Authority topics</strong> you want to be known for, describe
          your <strong>Audience</strong>, and press <strong>Save</strong>.
        </li>
      </Steps>

      <H2 id="knowledge">Add knowledge</H2>
      <P>
        Open your programme, then the <strong>Knowledge</strong> tab. Each source is read and tagged, so any draft in this
        programme can use it.
      </P>
      <Steps>
        <li>
          In the first list, choose <strong>Website (crawl)</strong>. Paste your website&apos;s address, starting https://.
        </li>
        <li>
          If you like, pick a <strong>Topic</strong> and type tags, pressing Enter after each. You can narrow what a draft
          reads by topic later.
        </li>
        <li>
          Press <strong>Ingest</strong>. Its status moves from pending to done.
        </li>
        <li>
          For one document or page, such as a pricing page or a help article, choose <strong>Docs / page</strong> instead.
          Knowledge reads web addresses, not uploaded files.
        </li>
        <li>
          For code, choose <strong>GitHub repo</strong> or <strong>GitLab repo</strong> and paste the repo&apos;s address. Add
          a branch if you want one. A private repo needs your account connected first (
          <Open href="/help/connected-accounts#github">Connected accounts</Open>). If a <strong>Connect</strong> link shows
          under the address, press it.
        </li>
      </Steps>

      <H2 id="cite">Mark a web source to cite</H2>
      <P>
        A cite source is a study, report or page of data your blog articles may quote, alongside what a web search finds.
        Only web pages can be cited, not repos.
      </P>
      <Steps>
        <li>
          Choose <strong>Docs / page</strong> and paste the page&apos;s address.
        </li>
        <li>
          Tick <strong>Cite source</strong>. <strong>This page only</strong> ticks too, so nothing else on that site is read.
        </li>
        <li>
          Press <strong>Ingest</strong>.
        </li>
        <li>
          To cite a source you added earlier, press <strong>Cite in articles</strong> on it once it&apos;s read.{" "}
          <strong>Stop citing</strong> undoes it.
        </li>
      </Steps>
      <P>A cite source on someone else&apos;s site is used as evidence only, never as what you say about yourself.</P>

      <H2 id="check">Check it worked</H2>
      <Checks>
        <li>Each source shows done and a number of chunks.</li>
        <li>
          Under <strong>Test retrieval</strong>, type a question about your product and press <strong>Test</strong>. Passages
          from your site come back.
        </li>
        <li>
          On <Open href="/admin">Home</Open>, &quot;Add your website to its knowledge&quot; is ticked.
        </li>
        <li>If a source stays pending for a long time, whoever runs your YouGrow needs to check its ingestion worker.</li>
      </Checks>

      <H2 id="messages">If you see this</H2>
      <Messages
        rows={[
          [
            "That URL isn't allowed (https only; git sources must be github.com / gitlab.com).",
            "Use the full address, starting https://. A repo must be on github.com or gitlab.com.",
          ],
          ["That source is already ingested.", "Nothing to do. To read it again, press Re-ingest on the source."],
          [
            "That repo isn't selected on your connection, so it's ingested without access",
            "Choose the repo on your GitHub or GitLab connection in Settings › Integrations, then press Re-ingest. Until then only a public repo can be read.",
          ],
          ["Too many ingestions in progress", "Wait for some sources to finish, then try again."],
          ["Wait until this source has finished being read.", "Press Cite in articles again once the source shows done."],
          [
            "Couldn't start the ingestion worker.",
            "Whoever runs your YouGrow needs to check its ingestion worker. Then press Re-ingest on the source.",
          ],
        ]}
      />

      <NextPage slug="programmes-and-knowledge" />
    </article>
  );
}
