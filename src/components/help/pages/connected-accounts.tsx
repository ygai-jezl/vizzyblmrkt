import { H1, H2, Lead, P } from "@/components/developers/Doc";
import { BeforeAndUnlocks, Checks, Messages, Meta, NextPage, Open, Steps, Warning } from "@/components/help/blocks";

export default function ConnectedAccountsHelp() {
  return (
    <article>
      <H1>Connected accounts</H1>
      <Lead>
        Connect LinkedIn or X so your scheduled posts publish on time. Connect GitHub or GitLab only if your code is in a
        private repo.
      </Lead>
      <Meta items={["About 5 minutes", "Anyone on your team", "Once per brand"]} />

      <BeforeAndUnlocks
        before={
          <>
            <li>The LinkedIn or X account you post from</li>
            <li>For a LinkedIn Company Page: you&apos;re an admin of that Page on LinkedIn</li>
            <li>For GitHub: you can install apps on the account or organisation that owns the code, or know who can</li>
          </>
        }
        unlocks={
          <>
            <li>Scheduled posts that publish themselves</li>
            <li>
              Knowledge and <strong>Learn from repo</strong> from a private repo
            </li>
          </>
        }
      />

      <Warning>
        Connect before you schedule. YouGrow won&apos;t schedule a LinkedIn or X post until its account is connected.
      </Warning>

      <H2 id="social">Connect LinkedIn or X</H2>
      <Steps>
        <li>
          Open <Open href="/admin/account/connections">Settings › Integrations</Open>.
        </li>
        <li>
          Find the account you post from: <strong>LinkedIn</strong> for your own profile, <strong>LinkedIn Pages</strong> for a
          Company Page, or <strong>X (Twitter)</strong>.
        </li>
        <li>
          Press <strong>Connect</strong>. A new window opens.
        </li>
        <li>Sign in and allow access. When the window says it&apos;s connected, close it.</li>
      </Steps>
      <P>
        With a Page connected, each LinkedIn post has a <strong>Post as</strong> list. Choose your profile or the Page there
        when you schedule.
      </P>

      <H2 id="github">Connect GitHub or GitLab</H2>
      <P>
        YouGrow reads code for a programme&apos;s <Open href="/help/programmes-and-knowledge#knowledge">knowledge</Open> and
        for <Open href="/help/connect-your-product#learn">Learn from repo</Open>. A public repo needs nothing here. A private
        one needs a connection. Access is read only: YouGrow never changes your code.
      </P>
      <Steps>
        <li>
          Open <Open href="/admin/account/connections">Settings › Integrations</Open>.
        </li>
        <li>
          Next to <strong>GitHub</strong>, press <strong>Install on GitHub (read-only)</strong>.
        </li>
        <li>On GitHub, choose the account or organisation that owns your code.</li>
        <li>
          Under <strong>Repository access</strong>, choose <strong>Only select repositories</strong> and pick your repos.
        </li>
        <li>
          Press <strong>Install</strong>, then close the window when it says it&apos;s connected.
        </li>
      </Steps>
      <P>
        Using GitLab? Press <strong>Connect</strong> next to <strong>GitLab</strong> and allow access. It&apos;s read only too.
      </P>
      <P>
        In an organisation you don&apos;t own, GitHub shows <strong>Request</strong> instead of Install. Once an owner approves
        it, press <strong>Install on GitHub (read-only)</strong> again. To change which repos YouGrow can read, use{" "}
        <strong>Add or remove repositories on GitHub</strong>. More detail is in{" "}
        <Open href="/developers/connect-your-code">Connecting your code</Open>.
      </P>

      <H2 id="check">Check it worked</H2>
      <Checks>
        <li>
          Each account you connected says <strong>Connected as</strong> and your account name. GitHub and GitLab also show{" "}
          <strong>Read-only</strong>.
        </li>
        <li>
          On <Open href="/admin">Home</Open>, &quot;Connect LinkedIn or X&quot; is ticked, and &quot;Connect GitHub&quot; too if
          you connected it.
        </li>
      </Checks>

      <H2 id="messages">If you see this</H2>
      <Messages
        rows={[
          [
            "Not set up on this YouGrow yet.",
            "Whoever runs your YouGrow hasn't added this service's app keys yet. Ask them to.",
          ],
          [
            "Connect LinkedIn to publish this post",
            "A post was due before LinkedIn was connected. Connect it, then pick a new time on the post and press Reschedule.",
          ],
          [
            "Connect your LinkedIn page to publish this post",
            "Connect LinkedIn Pages while signed in to LinkedIn as an admin of the Page. Then reschedule the post.",
          ],
          ["Connect X to publish this post", "Connect X (Twitter), then pick a new time on the post and press Reschedule."],
          [
            "Request sent",
            "Your GitHub organisation's owners must approve the app. Once one does, press Install on GitHub (read-only) again.",
          ],
          [
            "This older connection can also write to your repos.",
            "Press Switch now to move to the read-only YouGrow app.",
          ],
        ]}
      />

      <NextPage slug="connected-accounts" />
    </article>
  );
}
