import { H1, H2, H3, Lead, P, Pairs, UL } from "@/components/developers/Doc";
import { BeforeAndUnlocks, Checks, Messages, Meta, NextPage, Open, Steps } from "@/components/help/blocks";
import { ConnectorTile } from "@/components/admin/connectors/ConnectorTile";
import { CONNECTED_COPY, PART_COPY, PICKER_COPY, SCREEN_COPY, activityWords } from "@/components/admin/connectors/words";
import { isConnectorsChatEnabled, isConnectorsCollectEnabled, isConnectorSignalsEnabled, isConnectorsSearchTextEnabled, isConnectorsSharingEnabled } from "@/lib/connectors/flags";
import { COLLECT_HELP, connectedDataHelp, SEARCH_CONSOLE_FRESHNESS_ERASED, SEARCH_TEXT_HELP, SIGNALS_HELP, VIZZY_COLLECTED_HELP, type ConnectorHelp } from "@/lib/connectors/helpText";
import { CONNECTOR_ERRORS, tokenRefusedMessage } from "@/lib/connectors/messages";
import type { HelpBodyProps } from "@/lib/help/pages";

/** "A and B", or "A, B and C". */
function andList(items: readonly string[]): string {
  return items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

/** "Google Search Console, Google Analytics 4 and Cloudflare". */
const names = (list: readonly ConnectorHelp[]) => andList(list.map((c) => c.name));

function ConnectorSection({ c, collect }: { c: ConnectorHelp; collect: boolean }) {
  return (
    <>
      <H2 id={c.id}>
        {/* The mark is an image with no words, so the Markdown heading stays the name alone. */}
        {c.icon ? (
          <span className="inline-flex items-center gap-2">
            <ConnectorTile id={c.id} name={c.name} icon={c.icon} size="sm" />
            {c.name}
          </span>
        ) : (
          c.name
        )}
      </H2>
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
      {collect && c.collect ? (
        <P>
          {c.collect.where} {c.collect.lag} {c.collect.keeps}
        </P>
      ) : null}
    </>
  );
}

/**
 * /help/connected-data (NEXT_PUBLIC_CONNECTORS_ENABLED): Settings › Connections › Browse,
 * a connector's Listing, the picker and Connected. Every connector's steps, what it reads, its
 * numbers and what Disconnect does come from its manifest (src/lib/connectors/helpText.ts), so
 * the page can't drift from what each one really asks for. `connectorsChat` is whether Vizzy reads
 * connected data (CONNECTORS_CHAT_ENABLED) and `connectorsCollect` whether its numbers are collected
 * daily (CONNECTORS_COLLECT_ENABLED), and with both on, how Vizzy reads the collected numbers;
 * `connectorsSearchText` whether Search Console's searches go into brand search
 * (CONNECTORS_SEARCH_TEXT_ENABLED, ADR-0013), and `connectorSignals` whether collected numbers
 * suggest what to write (CONNECTOR_SIGNALS_ENABLED). `sharing` is whether organisations share
 * connections (CONNECTORS_SHARING_ENABLED): then a part your organisation gives your brand, as the
 * brand's own Connected view shows it, has its own section. The How to drawer passes what the
 * server said.
 */
export default function ConnectedDataHelp({
  connectorsChat = isConnectorsChatEnabled(),
  connectorsCollect = isConnectorsCollectEnabled(),
  connectorsSearchText = isConnectorsSearchTextEnabled(),
  connectorSignals = isConnectorSignalsEnabled(),
  sharing = isConnectorsSharingEnabled(),
}: HelpBodyProps = {}) {
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
      {sharing ? (
        <P>
          When your brands share an organisation, its owners can connect Search Console, Google Analytics 4 or Cloudflare once
          for all of them and give each brand its own site, property or zone, as{" "}
          <Open href="/help/shared-connections">Shared connections</Open> explains. A part given to your brand shows on Connected
          like any other connection.
        </P>
      ) : null}

      {help.connectors.map((c) => (
        <ConnectorSection key={c.id} c={c} collect={connectorsCollect} />
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

      {connectorsCollect ? (
        <>
          <H2 id="collected">Collected numbers</H2>
          <P>{COLLECT_HELP.what}</P>
          <UL>
            {COLLECT_HELP.when.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </UL>
          <P>
            {COLLECT_HELP.keeps} {COLLECT_HELP.filling}
          </P>
          <Pairs head={["Collected says", "What it means"]} rows={COLLECT_HELP.states.map(([words, meaning]) => [words, meaning])} />
          <P>{COLLECT_HELP.card}</P>
          <P>{COLLECT_HELP.erase}</P>
          <P>
            {COLLECT_HELP.review} See <Open href="/help/review-and-approvals#what">Review and approvals</Open>.
          </P>
        </>
      ) : null}

      {connectorsCollect && connectorsSearchText ? (
        <>
          <H2 id="search-text">Google searches in brand search</H2>
          <P>{SEARCH_TEXT_HELP.what}</P>
          <UL>
            <li>{SEARCH_TEXT_HELP.why}</li>
            <li>
              {SEARCH_TEXT_HELP.who} <Open href="/help/connected-data#who-can-read">Who can read it</Open> explains how to
              choose.
            </li>
            {connectorsChat ? <li>{SEARCH_TEXT_HELP.vizzy}</li> : null}
            <li>{SEARCH_TEXT_HELP.when}</li>
            <li>{SEARCH_TEXT_HELP.erase}</li>
          </UL>
          <P>
            <Open href="/help/search#whats-in">What search covers</Open> lists everything else it finds.
          </P>
        </>
      ) : null}

      {connectorsCollect && connectorSignals ? (
        <>
          <H2 id="suggestions">What your numbers suggest</H2>
          <P>{SIGNALS_HELP.what}</P>
          <UL>
            {SIGNALS_HELP.rules.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </UL>
          <P>
            {SIGNALS_HELP.planning} <Open href="/help/connected-data#who-can-read">Who can read it</Open> explains how to choose. {SIGNALS_HELP.noChat}
          </P>
          <P>{SIGNALS_HELP.strict}</P>
          <UL>
            <li>
              {SIGNALS_HELP.review} See <Open href="/help/review-and-approvals#numbers">Review and approvals</Open>.
            </li>
            <li>
              {SIGNALS_HELP.map} See <Open href="/help/brand-map#from-searches">Brand map</Open>.
            </li>
            <li>{SIGNALS_HELP.nextUp}</li>
            {connectorsChat ? <li>{SIGNALS_HELP.vizzy}</li> : null}
          </UL>
          <P>{SIGNALS_HELP.erase}</P>
        </>
      ) : null}

      <H2 id="who-can-read">Who can read it</H2>
      <UL>
        {help.grants.map((g) => (
          <li key={g}>{g}</li>
        ))}
      </UL>
      <P>
        On Connected, press anywhere on the connection&apos;s row, then tick <strong>{CONNECTED_COPY.members}</strong>
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

      {connectorsChat && connectorsCollect ? (
        <>
          <H2 id="vizzy-collected">Vizzy and your collected numbers</H2>
          <P>{VIZZY_COLLECTED_HELP.what}</P>
          <P>{VIZZY_COLLECTED_HELP.ask}</P>
          <UL>
            <li>{VIZZY_COLLECTED_HELP.reach}</li>
            <li>{VIZZY_COLLECTED_HELP.live}</li>
            <li>{VIZZY_COLLECTED_HELP.source}</li>
            <li>{VIZZY_COLLECTED_HELP.grants}</li>
          </UL>
          <P>
            To let Vizzy read a connection, tick <strong>{CONNECTED_COPY.vizzy}</strong> on it, as{" "}
            <Open href="/help/connected-data#who-can-read">Who can read it</Open> explains.
          </P>
        </>
      ) : null}

      {sharing ? (
        <>
          <H2 id="from-organisation">A part from your organisation</H2>
          <P>
            When your organisation gives your brand a site, property or zone from one of its{" "}
            <Open href="/help/shared-connections">Shared connections</Open>, it shows on{" "}
            <Open href="/admin/account/connections/connected">Connected</Open> with <strong>From</strong> and your
            organisation&apos;s name under How. It reads, collects and plans like a connection of your own, and its numbers stay
            in your brand&apos;s region.
          </P>
          <UL>
            <li>
              Its card says it is <strong>Managed by</strong> your organisation: its owners choose the part, sign in and fix its
              access. When your brand keeps its numbers in another region than the sign in, the card says both.
            </li>
            <li>
              Admins choose who can read it, and press <strong>{CONNECTED_COPY.checkNow}</strong>,{" "}
              <strong>{CONNECTED_COPY.pause}</strong> or <strong>{PART_COPY.stopUsing}</strong>. It has no property to choose, no
              Google address, no Check access and no Reconnect here.
            </li>
            <li>
              <strong>{PART_COPY.stopUsing}</strong> ends it for your brand at once and deletes what YouGrow collected for it,
              with the suggestions its numbers made and {SEARCH_CONSOLE_FRESHNESS_ERASED}. Your organisation&apos;s owners see
              that it stopped. It never removes access at Google or Cloudflare, since the same sign in can serve your other
              brands.
            </li>
            <li>
              When your brand leaves the organisation, its parts end the same way, and Connected says when it left. A
              connection of your brand&apos;s own fills its 90 days again within a day.
            </li>
          </UL>
          <Pairs
            head={["Status", "What it means"]}
            rows={[
              [
                "Needs, with your organisation's name",
                "Its organisation's sign in needs attention, or YouGrow can't read this part. An owner of your organisation fixes it on Settings › Organisation, and Review lists it under Data sources that need you.",
              ],
              ["Paused", "An admin here paused it, and an admin here resumes it. Or your organisation's owners paused it for every brand, and only they resume it."],
              ["Turned off here", `${CONNECTOR_ERRORS.sharing_off} It comes back as it was when sharing is turned on again.`],
              [
                PART_COPY.ended,
                `Your organisation no longer gives it, so it reads nothing. It leaves Connected within the hour, and what was collected for it is deleted, with ${SEARCH_CONSOLE_FRESHNESS_ERASED}.`,
              ],
              [PART_COPY.pending, "An owner is still giving it. It reads once that finishes."],
              [PART_COPY.unknownCell, "YouGrow couldn't check it with your organisation just now, so it reads nothing this time. Reload the page in a minute."],
            ]}
          />
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
          [help.messages.share_access_lost, "Someone took the connection's Google address off the property. Add it again with the role shown, then press Check access on Connected. The message says the day it stopped."],
          [help.messages.share_pending, "Wait a minute, then press Check access again."],
          [help.messages.share_quota, "Sign in with Google instead, or try again later."],
          [help.messages.share_limit, "Disconnect one you no longer use, or sign in with Google."],
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
          ...(sharing
            ? ([
                [CONNECTOR_ERRORS.source_broken, "An owner of your organisation signs in again, or fixes its Google address or token, on Settings › Organisation."],
                [CONNECTOR_ERRORS.source_paused, "An owner of your organisation resumes it on Settings › Organisation."],
                [CONNECTOR_ERRORS.managed_by_organisation, "Ask an owner of your organisation to change it on Settings › Organisation."],
                [CONNECTOR_ERRORS.part_ended, "Your organisation took it back, or your brand left it. Ask an owner if you still need it, or connect it for this brand."],
                [CONNECTOR_ERRORS.sharing_off, "Whoever runs your copy turns on CONNECTORS_SHARING_ENABLED. Every part comes back as it was."],
                [PART_COPY.pendingLine, "Reload the page in a minute. If it stays, an owner gives it again."],
                [PART_COPY.unknownLine, "Reload the page in a minute."],
              ] satisfies Array<[string, string]>)
            : []),
        ]}
      />

      <NextPage slug="connected-data" />
    </article>
  );
}
