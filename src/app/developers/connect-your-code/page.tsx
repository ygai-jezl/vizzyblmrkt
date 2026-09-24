import { C, Code, Fields, H1, H2, H3, Lead, Note, OL, P, UL } from "@/components/developers/Doc";
import { docsOrigin, githubAppPublicUrl } from "@/lib/developers/flags";
import { isGitHubAppLinkEnabled } from "@/lib/integrations/githubApp";

export default function ConnectYourCodeDocs() {
  const app = githubAppPublicUrl();
  const origin = docsOrigin();
  const linking = isGitHubAppLinkEnabled();
  return (
    <article>
      <H1>Connecting your code</H1>
      <Lead>
        YouGrow reads your product&apos;s code to learn how it works — what getting started means, which events it can
        send, which numbers it can report about each user — so setting up lifecycle email takes minutes, not a project.
        Access is <strong>read-only</strong>, limited to the repositories you choose, and you can remove it at any time.
      </Lead>

      <H2 id="what">What YouGrow can and can&apos;t do</H2>
      <Fields
        rows={[
          ["Can", "", "Read the code in the repositories you choose, when you ask it to learn from them."],
          ["Can't", "", "Change anything: no pushing code, no pull requests, issues, comments or settings. GitHub enforces this — the app is only granted read access."],
          ["Can't", "", "See any repository you haven't chosen."],
          ["Keeps", "", "A short list of findings, each with a few lines of code as evidence. Secrets and keys are removed before anything is read or stored. The copy of your code is deleted as soon as the analysis finishes."],
          ["Tokens", "", "We store no password or long-lived token for GitHub. Each analysis uses a read-only access token that expires within an hour."],
        ]}
      />

      <H2 id="github">Connect GitHub (about a minute)</H2>
      <OL>
        <li>
          In YouGrow, open <strong>Products → your product → Learn from repo</strong> and press <strong>Connect GitHub</strong>{" "}
          (or use <strong>Account → Connections</strong>).
        </li>
        {linking ? (
          <li>
            GitHub asks you to <strong>authorise</strong> YouGrow. This only confirms who you are. If the YouGrow app is
            already installed on your account or organisation, pick it from the list and you&apos;re done. Otherwise, carry on.
          </li>
        ) : null}
        <li>
          GitHub shows the <strong>YouGrow</strong> app{app ? (
            <>
              {" "}
              (<a className="underline" href={app} target="_blank" rel="noreferrer">{app.replace("https://", "")}</a>)
            </>
          ) : null}{" "}
          asking for <strong>read access to code and metadata</strong> — nothing else.
        </li>
        <li>Choose where to install it: your personal account, or the organisation that owns your product&apos;s code.</li>
        <li>
          Under <strong>Repository access</strong>, pick <strong>Only select repositories</strong> and choose your
          product&apos;s repos — for example your web app and your backend. (You can change this later.)
        </li>
        <li>Press <strong>Install</strong>. You&apos;re returned to YouGrow, where your repositories are listed — tick them and press <strong>Learn from repo</strong>.</li>
      </OL>

      <H3>If your organisation needs approval</H3>
      <P>
        Only an organisation <strong>owner</strong> can install apps on an organisation. If you&apos;re a member, GitHub shows{" "}
        <strong>Request</strong> instead of Install — press it, and YouGrow tells you the request is on its way. Your
        owners get a notification from GitHub; once one approves it (<strong>Organisation settings → GitHub Apps →
        Pending requests</strong>), press <strong>Connect GitHub</strong> again in YouGrow to finish.
      </P>
      <P>Here&apos;s a message you can send them:</P>
      <Code title="For your GitHub organisation owner">{`Hi — we're setting up YouGrow for lifecycle email. It needs READ-ONLY access
to our product's code so it can learn our onboarding steps and events.

Please approve the "YouGrow" GitHub app request${app ? ` (${app})` : ""}.
It asks only for read access to code and metadata, and only for the
repositories we choose — it can't push, open pull requests or change settings.
Details: ${origin}/developers/connect-your-code`}</Code>

      <H3>Change which repositories YouGrow can read</H3>
      {linking ? (
        <P>
          In YouGrow, use <strong>Add or remove repositories on GitHub</strong> (on Learn from repo, or Account →
          Connections). That opens the app&apos;s settings page on GitHub — change <strong>Repository access</strong>{" "}
          and save. The change applies immediately; YouGrow&apos;s list refreshes when you come back.
        </P>
      ) : (
        <P>
          In YouGrow, use <strong>Add or remove repositories on GitHub</strong> (on Learn from repo, or Account →
          Connections). That opens GitHub&apos;s page for the app — choose <strong>Configure</strong>, change{" "}
          <strong>Repository access</strong>, and save. The change applies immediately; YouGrow&apos;s list refreshes when
          you come back.
        </P>
      )}

      <H3>Disconnect</H3>
      <UL>
        <li>In YouGrow, <strong>Account → Connections → Disconnect</strong> removes the connection on our side.</li>
        <li>
          To remove the app from GitHub entirely: <strong>Settings → Applications → Installed GitHub Apps → YouGrow →
          Uninstall</strong> (for an organisation, <strong>Organisation settings → GitHub Apps</strong>). YouGrow can no
          longer read anything from that moment.
        </li>
      </UL>

      <H2 id="gitlab">Connect GitLab</H2>
      <OL>
        <li>In YouGrow, open <strong>Account → Connections</strong> and press <strong>Connect</strong> next to GitLab.</li>
        <li>
          GitLab asks you to authorise YouGrow with <C>read_repository</C>, <C>read_api</C> and <C>read_user</C> — all
          read-only. YouGrow can&apos;t push or change anything.
        </li>
        <li>Back in YouGrow, choose which projects it may use. Only those are ever read.</li>
      </OL>
      <P>GitLab access follows your own project permissions, so there&apos;s no separate group approval.</P>

      <H2 id="public">Public repositories</H2>
      <P>
        Nothing to connect: on <strong>Learn from repo</strong>, choose <strong>Add a repository by address</strong> and
        paste it (for example <C>github.com/your-org/your-app</C>).
      </P>

      <H2 id="faq">Questions</H2>
      <H3>Why an app, not a token?</H3>
      <P>
        A GitHub App is the only way GitHub lets you grant <em>read-only</em> access to <em>chosen</em> repositories, and
        it shows your organisation exactly what&apos;s granted. Personal access tokens and older OAuth apps can&apos;t be
        limited that way.
      </P>
      <H3>Something isn&apos;t in the list</H3>
      <P>The list shows exactly the repositories the app was granted. Add the missing one with <strong>Add or remove repositories on GitHub</strong>.</P>
      <Note>
        Learning from your code is always a proposal: you review each finding — with the code it came from — and choose
        what YouGrow keeps. Nothing changes until you do.
      </Note>
    </article>
  );
}
