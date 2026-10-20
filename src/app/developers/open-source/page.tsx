import { C, Code, H1, H2, H3, Lead, Note, OL, P, Pairs, UL } from "@/components/developers/Doc";
import { sourceRepoUrl } from "@/lib/developers/flags";

const SETUP_PROMPT = "Get YouGrow running on my laptop. Follow AGENTS.md.";
const CURSOR_PROMPT_LINK = `https://cursor.com/link/prompt?text=${encodeURIComponent(SETUP_PROMPT)}`;

export default function OpenSourceDocs() {
  const repo = sourceRepoUrl();
  const file = (path: string) => `${repo}/blob/main/${path}`;
  const link = (href: string, text: string) => (
    <a className="underline" href={href} target="_blank" rel="noreferrer">
      {text}
    </a>
  );
  return (
    <article>
      <H1>Open source</H1>
      <Lead>
        YouGrow is open source under the AGPL-3.0 licence. You can run it on your laptop in about 15 minutes with no
        accounts, host your own copy on Google Cloud, and build on it. The repository is set up for coding agents, so
        Claude Code or Cursor can do most of the work: you mostly approve what it proposes.
      </Lead>

      <H2 id="need">What you need</H2>
      <UL>
        <li>Git.</li>
        <li>Node 24 (Node 22 works).</li>
        <li>Java 21 or newer, for the Firebase emulators.</li>
        <li>
          Claude Code ({link("https://code.claude.com/docs/en/setup", "install")}) or Cursor ({link("https://cursor.com", "download")}).
        </li>
      </UL>
      <P>A local run needs no Google Cloud project, no Firebase account and no keys.</P>

      <H2 id="run">Run it on your laptop</H2>
      <H3>With Claude Code</H3>
      <Code title="In a terminal">{`git clone ${repo} yougrow
cd yougrow
claude "${SETUP_PROMPT}"`}</Code>
      <H3>With Cursor</H3>
      <OL>
        <li>
          Clone the repository (the first two lines above) and open the <C>yougrow</C> folder in Cursor.
        </li>
        <li>
          In the agent chat, send <C>{SETUP_PROMPT}</C>, or {link(CURSOR_PROMPT_LINK, "open the prompt in Cursor")}.
        </li>
        <li>Approve the terminal commands it proposes.</li>
      </OL>
      <H3>What happens next</H3>
      <OL>
        <li>
          The agent runs <C>npm run doctor</C>. It checks your machine and prints a fix for anything missing, most often
          Java 21.
        </li>
        <li>
          It asks before running <C>npm install</C>.
        </li>
        <li>
          It starts <C>npm run local</C>: the app on the Firebase emulators, with a made-up brand called Acme. Nothing
          reaches the internet, and emails are written to the log instead of sent.
        </li>
        <li>
          Open <C>http://localhost:3002/login</C>, click <strong>Sign in with Google</strong>, and pick{" "}
          <C>admin@example.com</C> on the emulator&apos;s test page.
        </li>
      </OL>
      <Note>
        AI writing, images and knowledge search need a Gemini key. Get one at{" "}
        {link("https://aistudio.google.com/apikey", "aistudio.google.com/apikey")}, add it to <C>.env.local</C> as{" "}
        <C>GEMINI_API_KEY</C> yourself, and restart the local run. Don&apos;t paste keys into the chat.
      </Note>

      <H2 id="next">What to ask next</H2>
      <Pairs
        head={["You want to", "Ask your agent"]}
        rows={[
          ["Find your way around", "Give me a tour of the admin, and show me where each part's code lives."],
          ["Build a feature", "Add a feature that ... It should ship behind a switch, with tests."],
          ["Fix a bug", "When I ..., I see ... Find out why and fix it, with a test."],
          ["Check your work", "Check my change is ready for a pull request."],
          ["Host your own copy", "Host YouGrow on my Google Cloud project my-project-id. Follow docs/self-host.md."],
        ]}
      />
      <P>
        The agent follows <C>AGENTS.md</C> and five step by step skills in <C>.claude/skills/</C>. Claude Code and Cursor
        both read them.
      </P>

      <H2 id="host">Host your own copy</H2>
      <P>You need a Google Cloud project with billing turned on, the gcloud CLI and the Firebase CLI. Allow about 45 minutes, most of it the first build.</P>
      <OL>
        <li>
          Sign in yourself, in a terminal: <C>gcloud auth login</C>, then <C>gcloud auth application-default login</C>, then{" "}
          <C>firebase login</C>.
        </li>
        <li>
          Ask your agent: <C>Host YouGrow on my Google Cloud project my-project-id. Follow docs/self-host.md.</C>
        </li>
        <li>
          It shows a read-only plan (<C>npm run selfhost -- --project my-project-id</C>), then applies one step at a time
          and asks before each change.
        </li>
        <li>
          Two steps need you in a browser: connecting your fork of the repository to App Hosting, and turning on Google
          sign-in in the Firebase console. The agent tells you when.
        </li>
        <li>
          Check the result: <C>npm run doctor -- --cloud --project my-project-id</C>.
        </li>
      </OL>
      <P>Costs and every step: {link(file("docs/self-host.md"), "the self-host guide")}.</P>

      <H2 id="safety">What the agent asks before doing</H2>
      <UL>
        <li>Any deploy or rollout, and any setup step or script that changes a Google Cloud project.</li>
        <li>
          Installing packages, <C>git push</C>, and other changes that are hard to undo.
        </li>
        <li>
          It never reads <C>.env.local</C> or secret values.
        </li>
      </UL>
      <P>
        Claude Code enforces this through the repository&apos;s settings. In Cursor, approve terminal commands one at a time,
        and read any with <C>deploy</C>, <C>selfhost</C> or <C>--apply</C> before you approve.
      </P>

      <H2 id="guides">Full guides</H2>
      <UL>
        <li>{link(file("docs/start-with-claude-or-cursor.md"), "Start with Claude or Cursor")}: every step, with fixes for common problems.</li>
        <li>{link(file("AGENTS.md"), "AGENTS.md")}: what your coding agent reads first.</li>
        <li>{link(file("docs/self-host.md"), "Host it on your own Google Cloud")}: the full self-host guide.</li>
        <li>{link(file("docs/agents/cloud.md"), "Cloud coding agents")}: Claude Code on the web, Cursor Cloud Agents and Codespaces.</li>
        <li>{link(file("CONTRIBUTING.md"), "Contributing")}: send your changes back.</li>
      </UL>
    </article>
  );
}
