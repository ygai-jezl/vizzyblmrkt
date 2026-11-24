import { H1, H2, Lead, P } from "@/components/developers/Doc";
import { BeforeAndUnlocks, Checks, Messages, Meta, NextPage, Open, Steps, Warning } from "@/components/help/blocks";
import { isConnectorRevokeEnabled, isConnectorRevokeXEnabled } from "@/lib/integrations/flags";
import { isConnectorsScreenEnabled } from "@/lib/connectors/flags";

export default function ConnectedAccountsHelp() {
  return (
    <article>
      <H1>Connected accounts</H1>
      <Lead>
        Connect LinkedIn or X so your scheduled posts publish on time. Connect GitHub or GitLab only if your code is in a
        private repo.
      </Lead>
      <Meta items={["About 5 minutes", "Admins", "Once per brand"]} />
      <P>
        Only admins connect or disconnect accounts. Everyone else on your team sees what&apos;s connected, and asks an admin
        when something needs connecting.
      </P>
      {isConnectorsScreenEnabled() ? (
        <P>
          These accounts are under <strong>Accounts</strong> in Settings › Connections. To bring in numbers from Cloudflare,
          Google Search Console or Google Analytics instead, see <Open href="/help/connected-data">Connected data</Open>.
        </P>
      ) : null}

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
          Open <Open href="/admin/account/connections">Settings › Connections</Open>.
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
          Open <Open href="/admin/account/connections">Settings › Connections</Open>.
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
        YouGrow renews GitLab&apos;s access by itself. A GitLab connection made before YouGrow started renewing it needs
        reconnecting once: press <strong>Reconnect</strong> next to it. The repos you chose stay chosen.
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

      <H2 id="disconnect">Disconnect an account</H2>
      {isConnectorRevokeEnabled() ? (
        <P>
          Disconnect removes the connection from YouGrow. For{" "}
          {isConnectorRevokeXEnabled() ? "GitLab, X and an older GitHub connection" : "GitLab and an older GitHub connection"}{" "}
          it also cancels YouGrow&apos;s access on that service. It never removes the YouGrow app from GitHub, because other
          brands may use the same installation. You can uninstall it on GitHub, but that stops it for every brand that uses
          it.{" "}
          {isConnectorRevokeXEnabled()
            ? "For LinkedIn, you can remove YouGrow in your LinkedIn settings, but that stops it for every brand connected with the same LinkedIn account."
            : "For LinkedIn or X, you can remove YouGrow in that service's settings, but that stops it for every brand connected with the same account."}
        </P>
      ) : (
        <P>
          Disconnect removes the connection from YouGrow. To cancel YouGrow&apos;s access on the service too, remove YouGrow
          in that service&apos;s settings. That stops it for every brand connected with the same account.
        </P>
      )}

      <H2 id="messages">If you see this</H2>
      <Messages
        rows={[
          [
            "Not set up on this YouGrow yet.",
            "Whoever runs your YouGrow hasn't added this service's app keys yet. Ask them to.",
          ],
          [
            "Only admins can connect or disconnect accounts.",
            "You're a member of this brand, so you see what's connected but can't change it. Ask an admin.",
          ],
          [
            "Only admins can connect accounts. Ask an admin on your team.",
            "You pressed Connect as a member. An admin on your brand connects it from the same page.",
          ],
          [
            "Ask an admin to connect it for private repos.",
            "Reading a private repo needs GitHub or GitLab connected, and only an admin can connect it. A public repo needs nothing.",
          ],
          [
            "Connect LinkedIn to publish this post",
            "A post was due before LinkedIn was connected. Ask an admin to connect it, then pick a new time on the post and press Reschedule.",
          ],
          [
            "Connect your LinkedIn page to publish this post",
            "A YouGrow admin who is also an admin of the Page on LinkedIn connects LinkedIn Pages. Then reschedule the post.",
          ],
          [
            "Connect X to publish this post",
            "Ask an admin to connect X (Twitter), then pick a new time on the post and press Reschedule.",
          ],
          [
            "Request sent",
            "Your GitHub organisation's owners must approve the app. Once one does, press Install on GitHub (read-only) again.",
          ],
          [
            "This older connection can also write to your repos.",
            "An admin presses Switch now to move to the read-only YouGrow app.",
          ],
          [
            "This connection needs reconnecting.",
            "The service no longer accepts YouGrow's access, or an older GitLab connection needs renewing. An admin presses Reconnect next to it. Chosen repos stay chosen.",
          ],
          [
            "Ask an admin to reconnect it.",
            "A connection needs reconnecting and you're a member, so you can't do it yourself. An admin presses Reconnect in Settings › Connections.",
          ],
        ]}
      />

      <NextPage slug="connected-accounts" />
    </article>
  );
}
