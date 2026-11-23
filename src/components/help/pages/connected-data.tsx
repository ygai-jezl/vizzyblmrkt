import { H1, H2, H3, Lead, P, Pairs, UL } from "@/components/developers/Doc";
import { BeforeAndUnlocks, Checks, Messages, Meta, NextPage, Open, Steps } from "@/components/help/blocks";
import { CONNECTED_COPY, PICKER_COPY, SCREEN_COPY, activityWords } from "@/components/admin/connectors/words";
import { isConnectorsChatEnabled } from "@/lib/connectors/flags";
import { connectedDataHelp, type ConnectorHelp } from "@/lib/connectors/helpText";
import { tokenRefusedMessage } from "@/lib/connectors/messages";
import type { HelpBodyProps } from "@/lib/help/pages";

/** "A and B", or "A, B and C". */
function andList(items: readonly string[]): string {
  return items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

/** "Google Search Console, Google Analytics 4 and Cloudflare". */
const names = (list: readonly ConnectorHelp[]) => andList(list.map((c) => c.name));

function ConnectorSection({ c }: { c: ConnectorHelp }) {
  return (
    <>
      <H2 id={c.id}>{c.name}</H2>
      <P>{c.summary}</P>
      {c.signIn ? (
        <>
          <H3>Sign in with Google</H3>
          <Steps>
            {c.signIn.steps.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </Steps>
        </>
      ) : null}
      {c.share ? (
        <>
          <H3>Share access</H3>
          <P>
            The address gets the <strong>{c.share.role}</strong> role, which can only read.
          </P>
          <Steps>
            {c.share.steps.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </Steps>
        </>
      ) : null}
      {c.token ? (
        <>
          <H3>With an API token</H3>
          <Steps>
            {c.token.steps.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </Steps>
          {c.token.link ? (
            <P>
              The link on the {c.name} page opens {c.name}&apos;s token form with the {c.token.permissions.length === 1 ? "permission" : "permissions"} filled in:{" "}
              <a href={c.token.link} className="font-medium text-sky-700 underline-offset-2 hover:underline dark:text-sky-400">
                make a token
              </a>
              .
            </P>
          ) : null}
          <UL>
            {c.token.fields.map((f) => (
              <li key={f.label}>
                <strong>{f.label}</strong>
                {f.help ? `: ${f.help}` : null}
              </li>
            ))}
          </UL>
        </>
      ) : null}
      <H3>What it reads</H3>
      <Pairs head={["From " + c.name, "In YouGrow"]} rows={c.shares.map((s) => [s.detail ? `${s.what} (${s.detail})` : s.what, `${s.direction}. ${s.where}`])} />
      <UL>
        {c.numbers.map((n) => (
          <li key={n.name}>
            <strong>{n.name}</strong>: {n.definition}
            {n.caveat ? ` ${n.caveat}` : null}
          </li>
        ))}
      </UL>
      {c.days.map((d) => (
        <P key={d}>{d}</P>
      ))}
      <P>
        {c.lag} {c.disconnect}
      </P>
    </>
  );
}

/**
 * /help/connected-data (NEXT_PUBLIC_CONNECTORS_ENABLED): Settings › Connections › Browse,
 * a connector's Listing, the picker and Connected. Every connector's steps, what it reads, its
 * numbers and what Disconnect does come from its manifest (src/lib/connectors/helpText.ts), so
 * the page can't drift from what each one really asks for. `connectorsChat` is whether Vizzy reads
 * connected data (CONNECTORS_CHAT_ENABLED); the How to drawer passes what the server said.
 */
export default function ConnectedDataHelp({ connectorsChat = isConnectorsChatEnabled() }: HelpBodyProps = {}) {
  const help = connectedDataHelp();
  const google = help.connectors.filter((c) => c.signIn || c.share);
  const health = help.health;
  return (
    <article>
      <H1>Connected data</H1>
      <Lead>
        Bring numbers from {names(help.connectors)} into YouGrow, read live when you
        {connectorsChat ? " or Vizzy ask" : " ask"}. Each connection shows exactly what it reads, and admins choose who can read it.
      </Lead>
      <Meta items={["About 5 minutes", "Admins", "Once per connection"]} />
      <P>
        Only admins connect, check, pause, change who can read and disconnect. Everyone else on your team sees each
        connection&apos;s name and state. Your copy of YouGrow lists only the connectors it has turned on.
      </P>

      <BeforeAndUnlocks
        before={
          <>
            <li>For Cloudflare: an account that can make API tokens for your site</li>
            <li>For Google: a Google account that can see the site or property, or someone who can add users to it</li>
          </>
        }
        unlocks={
          <>
            <li>Your traffic and search numbers, each with what it means</li>
            {connectorsChat ? <li>Vizzy answering questions about them, when an admin allows it</li> : null}
          </>
        }
      />

      <H2 id="connect">Connect a tool</H2>
      <Steps>
        <li>
          Open <Open href="/admin/account/connections/browse">Settings › Connections › Browse</Open>.
        </li>
        <li>Press the card of the tool you use. Its page says what it reads and how to connect.</li>
        <li>Connect it the way that page offers, as below for each tool.</li>
        <li>
          On <Open href="/admin/account/connections/connected">Connected</Open>, choose who can read it.
        </li>
      </Steps>
      <P>
        Your accounts for code and posts (GitHub, GitLab, LinkedIn and X) stay under <strong>Accounts</strong>, as{" "}
        <Open href="/help/connected-accounts">Connected accounts</Open> explains. Email sending is set up under{" "}
        <Open href="/admin/account">Settings › Sending</Open>.
      </P>

      {help.connectors.map((c) => (
        <ConnectorSection key={c.id} c={c} />
      ))}

      {google.length ? (
        <>
          <H2 id="sign-in">Signing in with Google</H2>
          <P>{help.signIn.account}</P>
          <P>{help.signIn.unverified}</P>
          <P>{help.signIn.testing}</P>
          <P>{help.signIn.limit}</P>
          <P>{help.signIn.reconnect}</P>
          <P>{help.signIn.removeAccess}</P>
          <P>{help.signIn.disconnect}</P>

          <H2 id="share-access">Sharing access instead</H2>
          <P>{help.share.what}</P>
          <P>{help.share.check}</P>
          <P>
            Then pick the one this connection reads. One that isn&apos;t on your brand&apos;s own website is marked, so you
            notice, but you can still choose it.
          </P>
          <P>{help.share.hidden}</P>
          <P>{help.share.disconnect}</P>
          <P>{help.share.workspace}</P>
        </>
      ) : null}

      <H2 id="connected">Check it worked</H2>
      <Checks>
        <li>
          On <Open href="/admin/account/connections/connected">Connected</Open>, the connection says <strong>Working</strong>.
        </li>
        <li>
          Press <strong>{CONNECTED_COPY.checkNow}</strong> on it any time. &quot;{CONNECTED_COPY.checkedOk}&quot; means it reads.
        </li>
      </Checks>
      <Pairs
        head={["Status", "What it means"]}
        rows={[
          ["Working", health.ok],
          ["Check failed", health.check],
          ["Needs attention", health.broken],
          ["Paused", health.paused],
          ["Choose a property", "It signed in or was shared, but nobody chose which site or property it reads. Nothing is read until an admin does."],
          ["Turned off here", CONNECTED_COPY.turnedOff],
        ]}
      />
      <P>
        <strong>{CONNECTED_COPY.pause}</strong> stops every read until an admin presses <strong>{CONNECTED_COPY.resume}</strong>.{" "}
        <strong>{CONNECTED_COPY.disconnect}</strong> deletes what YouGrow stored for it; each tool&apos;s section above says
        what it leaves at the tool. {health.disconnected} The activity on Connected shows the latest changes, and the
        activity log is kept for 90 days.
      </P>
      <P>
        When your brand has two connections to one tool, such as two Cloudflare zones, each banner and activity line on
        Connected says which one, as in &quot;{activityWords({ kind: "paused", code: null }, "Cloudflare for acme.example", "token_fields")}&quot;.
      </P>

      <H2 id="who-can-read">Who can read it</H2>
      <UL>
        {help.grants.map((g) => (
          <li key={g}>{g}</li>
        ))}
      </UL>
      <P>
        On Connected, choose the connection, then tick <strong>{CONNECTED_COPY.members}</strong>
        {connectorsChat ? (
          <>
            {" "}
            or <strong>{CONNECTED_COPY.vizzy}</strong>
          </>
        ) : null}
        . A new connection starts with only admins.
      </P>

      {connectorsChat ? (
        <>
          <H2 id="vizzy">Letting Vizzy read it</H2>
          <UL>
            {help.vizzy.map((v) => (
              <li key={v}>{v}</li>
            ))}
          </UL>
        </>
      ) : null}

      <H2 id="messages">If you see this</H2>
      <Messages
        rows={[
          [SCREEN_COPY.coreOff, "Connected data isn't turned on in your copy. Whoever runs it turns on CONNECTORS_ENABLED."],
          [SCREEN_COPY.noConnectors, "Each connector has a switch of its own. Whoever runs your copy turns on the ones you need."],
          ...help.connectors.flatMap((c): Array<[string, string]> =>
            c.token
              ? [
                  [tokenRefusedMessage(c.name, "connected", connectorsChat), "Make a new token with the same permissions, then press Reconnect on Connected and paste it."],
                  [tokenRefusedMessage(c.name, "connecting", connectorsChat), "Copy the token again with nothing cut off, or make a new one with the permissions in the steps above."],
                ]
              : [],
          ),
          [help.messages.account_refused, "Check the Zone ID, and that the token includes that site, then connect again."],
          ...help.connectors.flatMap((c): Array<[string, string]> =>
            c.token?.pick ? [[c.token.pick.cantList, `Type the ${c.token.pick.typed}, or make the token again with ${andList(c.token.permissions)} to pick from a list.`]] : [],
          ),
          [help.signIn.message, "Press Reconnect on Connected and sign in with the same Google account. Its property, who can read it and its history stay."],
          [help.messages.share_not_visible, "Add the address in your property exactly as shown, with the role shown, then press Check access again."],
          [help.messages.share_pending, "Wait a minute, then press Check access again."],
          [help.messages.share_quota, "Sign in with Google instead, or try again later."],
          [help.messages.share_limit, "Disconnect a shared connection you no longer use, or sign in with Google."],
          [help.messages.share_unconfigured, "Ask whoever runs your copy to set up its identities project, or sign in with Google."],
          [help.messages.signin_unconfigured, "Ask whoever runs your copy to add its Google client, or share access instead."],
          [help.messages.vault_unconfigured, "Ask whoever runs your copy to set CONNECTORS_VAULT_KEY. Nothing can be connected until then."],
          [help.messages.rate_limited, "Nothing to do. Calls start again by themselves."],
          [help.messages.paused, "An admin presses Resume on Connected."],
          [PICKER_COPY.noneSignedIn, "The Google account you signed in with can't see the site or property. Sign in again with one that can."],
          [help.signInReasons.denied, "Start again and allow access on Google's screen."],
          [help.signInReasons.scope_not_granted, "Start again and tick the permission to read on Google's screen."],
          [help.signInReasons.wrong_browser, "Start again in the browser you'll finish in."],
          [help.signInReasons.wrong_admin, "Each admin finishes the sign in they started. Start your own."],
          [help.signInReasons.state_expired, "Start again and finish within 10 minutes."],
          [help.signInReasons.no_refresh_token, "Remove YouGrow in your Google account, then sign in again."],
          [help.signInReasons.site_not_visible, "Sign in with the Google account that can see the site this connection reads."],
          [CONNECTED_COPY.askAdmin, "You're a member, so you see the connection but can't reconnect it. An admin presses Reconnect on Connected."],
        ]}
      />

      <NextPage slug="connected-data" />
    </article>
  );
}
