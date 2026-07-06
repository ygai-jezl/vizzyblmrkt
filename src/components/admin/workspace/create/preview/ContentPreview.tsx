"use client";

import React, { useMemo } from "react";
import { channelLabel } from "@/lib/content/channels";
import { truncateSeeMore } from "@/lib/distribute/preview/linkedin";
import { truncateCaption } from "@/lib/distribute/preview/instagram";
import { deconstructToThread } from "@/lib/distribute/threadDeconstructor";
import { wrap, renderEmailLayout, bodyToHtml } from "@/lib/email/emailRender";
import { MarkdownMessage } from "@/components/admin/chat/MarkdownMessage";
import type { ContentNode } from "@/lib/types/contentPlan";
import {
  previewKind,
  splitBlogTitle,
  domainFrom,
  firstLine,
  handleFrom,
  initial,
  metaSnippet,
  type PreviewKind,
  type PreviewView,
} from "./contentPreviewHelpers";

/**
 * Channel-native WYSIWYG previews for a Create node — the copy rendered at the
 * dimensions and chrome the destination surface actually uses, in two states:
 *   • "feed"   — as seen scrolling past (truncated at the network's cutoff)
 *   • "opened" — clicked into (full copy + detail chrome)
 * Presentational only. The truncation/threading rules are the shared pure libs in
 * src/lib/distribute/preview/*; the email frame reuses the send-path renderer
 * (wrap/renderEmailLayout) so an opened email matches what recipients receive.
 */

interface FrameProps {
  node: ContentNode;
  view: PreviewView;
  brandName?: string;
  /** Workspace id — needed to serve the node's generated post image (authenticated proxy). */
  workspaceId?: string;
}

/** The node's generated post image (if any), served by the authenticated workspace-asset
 *  proxy. `contain` on a neutral mat so any aspect ratio previews without cropping. */
function PostImage({
  node,
  workspaceId,
  className,
}: {
  node: ContentNode;
  workspaceId?: string;
  className?: string;
}) {
  if (!node.imageAssetRef || !workspaceId) return null;
  const src = `/api/admin/workspace/${workspaceId}/asset/${node.imageAssetRef}`;
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt="Post image"
      className={className ?? "max-h-80 w-full bg-neutral-100 object-contain dark:bg-neutral-900"}
    />
  );
}

// ── Inline rich-text (line-break-preserving) ────────────────────────────────────
// Social copy is one-idea-per-line with the occasional **bold**/link — so we keep
// newlines (unlike the block-collapsing MarkdownMessage) and render the inline subset.
const INLINE = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\((?:https?:\/\/|\/)[^)\s]+\))/g;

function inlineNodes(text: string, keyPrefix: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  let last = 0;
  let match: RegExpExecArray | null;
  let i = 0;
  INLINE.lastIndex = 0;
  while ((match = INLINE.exec(text)) !== null) {
    if (match.index > last) out.push(text.slice(last, match.index));
    const token = match[0] ?? "";
    const key = `${keyPrefix}-${i++}`;
    if (token.startsWith("**")) {
      out.push(<strong key={key}>{token.slice(2, -2)}</strong>);
    } else if (token.startsWith("`")) {
      out.push(
        <code key={key} className="rounded bg-black/5 px-1 font-mono text-[0.9em] dark:bg-white/10">
          {token.slice(1, -1)}
        </code>,
      );
    } else {
      const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(token);
      if (link) {
        out.push(
          <a
            key={key}
            href={link[2] ?? "#"}
            target="_blank"
            rel="noopener noreferrer"
            className="text-sky-600 hover:underline dark:text-sky-400"
          >
            {link[1] ?? token}
          </a>,
        );
      } else {
        out.push(token);
      }
    }
    last = match.index + token.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** Render text preserving line breaks + inline bold/link/code. */
function RichText({ text }: { text: string }) {
  const lines = (text ?? "").replace(/\r\n/g, "\n").split("\n");
  return (
    <>
      {lines.map((line, i) => (
        <React.Fragment key={i}>
          {line ? inlineNodes(line, `l${i}`) : null}
          {i < lines.length - 1 ? <br /> : null}
        </React.Fragment>
      ))}
    </>
  );
}

function EmptyCopy() {
  return (
    <p className="text-sm italic text-neutral-400">
      No content yet — generate this node to preview it.
    </p>
  );
}

// ── Icons (monochrome, inherit currentColor) ────────────────────────────────────
function Ic({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`h-[18px] w-[18px] ${className ?? ""}`}
      aria-hidden
    >
      {children}
    </svg>
  );
}
const IconHeart = () => (
  <Ic>
    <path d="M19.5 5.5a4.6 4.6 0 0 0-6.5 0l-1 1-1-1a4.6 4.6 0 1 0-6.5 6.5l7.5 7.5 7.5-7.5a4.6 4.6 0 0 0 0-6.5Z" />
  </Ic>
);
const IconComment = () => (
  <Ic>
    <path d="M20 11.5a7.5 7.5 0 0 1-10.7 6.8L4 20l1.7-4.2A7.5 7.5 0 1 1 20 11.5Z" />
  </Ic>
);
const IconRepost = () => (
  <Ic>
    <path d="M4 8V7a3 3 0 0 1 3-3h9" />
    <path d="M14 2l3 2-3 2" />
    <path d="M20 16v1a3 3 0 0 1-3 3H8" />
    <path d="M10 22l-3-2 3-2" />
  </Ic>
);
const IconShare = () => (
  <Ic>
    <path d="M22 3 11 14" />
    <path d="M22 3 15 21l-4-7-7-4Z" />
  </Ic>
);
const IconThumb = () => (
  <Ic>
    <path d="M7 10v10H4V10h3Z" />
    <path d="M7 10l4-7a2 2 0 0 1 2 2v3h5.2a2 2 0 0 1 2 2.4l-1.2 6A2 2 0 0 1 18 20H7" />
  </Ic>
);
const IconBookmark = () => (
  <Ic>
    <path d="M6 3h12v18l-6-4-6 4V3Z" />
  </Ic>
);

/** A muted row of platform actions (like/comment/…). */
function ActionBar({
  items,
  className,
}: {
  items: { label: string; icon: React.ReactNode }[];
  className?: string;
}) {
  return (
    <div className={`flex items-center ${className ?? "justify-around"}`}>
      {items.map((it, i) => (
        <span
          key={i}
          className="flex items-center gap-1.5 rounded px-2 py-1.5 text-xs font-medium text-neutral-500"
        >
          {it.icon}
          {it.label ? <span className="hidden sm:inline">{it.label}</span> : null}
        </span>
      ))}
    </div>
  );
}

// ── LinkedIn ─────────────────────────────────────────────────────────────────
function LinkedInFrame({ node, view, brandName, workspaceId }: FrameProps) {
  const name = brandName || "Your Page";
  const { visible, truncated } = truncateSeeMore(node.body);
  const shown = view === "opened" ? node.body : visible;
  return (
    <article className="overflow-hidden rounded-lg border border-black/10 bg-white text-[14px] text-neutral-900 shadow-sm dark:border-white/10 dark:bg-neutral-950 dark:text-neutral-100">
      <header className="flex items-start gap-2 p-3">
        <div className="h-12 w-12 shrink-0 rounded-full bg-gradient-to-br from-sky-400 to-indigo-500" />
        <div className="min-w-0 leading-tight">
          <div className="font-semibold">{name}</div>
          <div className="truncate text-xs text-neutral-500">Your headline</div>
          <div className="text-xs text-neutral-500">now · 🌐</div>
        </div>
        <span className="ml-auto text-neutral-400">···</span>
      </header>
      <div className="px-3 pb-2">
        {node.body.trim() ? (
          <p className="whitespace-pre-wrap leading-relaxed">
            <RichText text={shown} />
            {view === "feed" && truncated ? <span className="text-neutral-500"> …see more</span> : null}
          </p>
        ) : (
          <EmptyCopy />
        )}
      </div>
      <PostImage node={node} workspaceId={workspaceId} />
      <div className="mx-3 flex items-center justify-between border-t border-black/10 py-1 dark:border-white/10">
        <ActionBar
          className="w-full justify-around"
          items={[
            { label: "Like", icon: <IconThumb /> },
            { label: "Comment", icon: <IconComment /> },
            { label: "Repost", icon: <IconRepost /> },
            { label: "Send", icon: <IconShare /> },
          ]}
        />
      </div>
      {view === "opened" ? (
        <div className="flex items-center gap-2 border-t border-black/10 p-3 dark:border-white/10">
          <div className="h-8 w-8 shrink-0 rounded-full bg-neutral-300 dark:bg-neutral-700" />
          <div className="flex-1 rounded-full border border-black/10 px-3 py-1.5 text-xs text-neutral-400 dark:border-white/10">
            Add a comment…
          </div>
        </div>
      ) : null}
    </article>
  );
}

// ── X (Twitter) ────────────────────────────────────────────────────────────────
function XFrame({ node, view, brandName, workspaceId }: FrameProps) {
  const name = brandName || "Your account";
  const handle = `@${handleFrom(brandName)}`;
  const parts = deconstructToThread(node.body);
  const shown = view === "feed" ? parts.slice(0, 1) : parts;
  return (
    <article className="rounded-2xl border border-black/10 bg-white text-[15px] text-neutral-900 dark:border-white/10 dark:bg-black dark:text-neutral-100">
      {shown.length ? (
        shown.map((part, i) => (
          <div key={i} className={`flex gap-3 p-3 ${i > 0 ? "border-t border-black/5 dark:border-white/10" : ""}`}>
            <div className="flex flex-col items-center">
              <div className="h-10 w-10 shrink-0 rounded-full bg-gradient-to-br from-neutral-500 to-neutral-800" />
              {i < shown.length - 1 ? <div className="mt-1 w-px flex-1 bg-black/10 dark:bg-white/15" /> : null}
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-x-1 text-[14px]">
                <span className="font-bold">{name}</span>
                <span className="text-neutral-500">
                  {handle} · now
                </span>
              </div>
              <p className="mt-0.5 whitespace-pre-wrap leading-normal">
                <RichText text={part} />
              </p>
              {i === 0 ? (
                <PostImage
                  node={node}
                  workspaceId={workspaceId}
                  className="mt-2 max-h-80 w-full rounded-2xl border border-black/10 bg-neutral-100 object-contain dark:border-white/10 dark:bg-neutral-900"
                />
              ) : null}
              <ActionBar
                className="mt-2 max-w-[340px] justify-between"
                items={[
                  { label: "", icon: <IconComment /> },
                  { label: "", icon: <IconRepost /> },
                  { label: "", icon: <IconHeart /> },
                  { label: "", icon: <IconShare /> },
                ]}
              />
            </div>
          </div>
        ))
      ) : (
        <div className="p-3">
          <EmptyCopy />
          {/* An image can be generated before copy — still show it (self-guards to null). */}
          <PostImage
            node={node}
            workspaceId={workspaceId}
            className="mt-2 max-h-80 w-full rounded-2xl border border-black/10 bg-neutral-100 object-contain dark:border-white/10 dark:bg-neutral-900"
          />
        </div>
      )}
      {view === "feed" && parts.length > 1 ? (
        <div className="border-t border-black/5 px-4 py-2.5 text-[14px] text-sky-600 dark:border-white/10 dark:text-sky-400">
          Show this thread
        </div>
      ) : null}
    </article>
  );
}

// ── Instagram ────────────────────────────────────────────────────────────────
function InstagramFrame({ node, view, brandName, workspaceId }: FrameProps) {
  const handle = handleFrom(brandName);
  const { visible, truncated } = truncateCaption(node.body);
  const caption = view === "opened" ? node.body : visible;
  return (
    <article className="overflow-hidden rounded-md border border-black/10 bg-white text-[14px] text-neutral-900 dark:border-white/10 dark:bg-black dark:text-neutral-100">
      <header className="flex items-center gap-2 p-3">
        <div className="h-8 w-8 rounded-full bg-gradient-to-tr from-amber-400 via-pink-500 to-purple-600 p-[2px]">
          <div className="h-full w-full rounded-full bg-white dark:bg-black" />
        </div>
        <span className="text-[13px] font-semibold">{handle}</span>
        <span className="ml-auto text-neutral-400">···</span>
      </header>
      {node.imageAssetRef && workspaceId ? (
        <PostImage node={node} workspaceId={workspaceId} className="aspect-square w-full bg-neutral-100 object-cover dark:bg-neutral-900" />
      ) : (
        <div className="flex aspect-square items-center justify-center bg-gradient-to-br from-neutral-100 to-neutral-200 text-xs text-neutral-400 dark:from-neutral-900 dark:to-neutral-800">
          Your media
        </div>
      )}
      <div className="flex items-center gap-4 px-3 pt-3 text-neutral-800 dark:text-neutral-200">
        <IconHeart />
        <IconComment />
        <IconShare />
        <span className="ml-auto">
          <IconBookmark />
        </span>
      </div>
      <div className="px-3 pt-2 text-[13px] font-semibold">1,024 likes</div>
      <div className="px-3 pb-3 pt-1 text-[14px]">
        {node.body.trim() ? (
          <p className="whitespace-pre-wrap leading-snug">
            <span className="font-semibold">{handle}</span> <RichText text={caption} />
            {view === "feed" && truncated ? <span className="text-neutral-400"> … more</span> : null}
          </p>
        ) : (
          <EmptyCopy />
        )}
        {view === "opened" ? (
          <div className="mt-2 text-[13px] text-neutral-400">View all 128 comments</div>
        ) : null}
      </div>
    </article>
  );
}

// ── Blog (SEO/GEO) ───────────────────────────────────────────────────────────
function BlogFrame({ node, view, brandName }: FrameProps) {
  const { title, body } = splitBlogTitle(node);
  const brand = brandName || "Your Brand";
  if (view === "feed") {
    // As seen "in the feed" of a blog: the Google search result.
    return (
      <div className="rounded-lg border border-black/10 bg-white p-4 dark:border-white/10 dark:bg-neutral-950">
        <div className="flex items-center gap-2 text-xs text-neutral-600 dark:text-neutral-400">
          <div className="h-6 w-6 rounded-full bg-neutral-200 dark:bg-neutral-800" />
          <div className="leading-tight">
            <div className="font-medium text-neutral-800 dark:text-neutral-200">{brand}</div>
            <div>{domainFrom(brandName)} › blog</div>
          </div>
        </div>
        <h3 className="mt-2 text-xl leading-snug text-[#1a0dab] dark:text-[#8ab4f8]">{title}</h3>
        <p className="mt-1 text-sm leading-snug text-neutral-600 dark:text-neutral-400">
          {metaSnippet(body) || "Your meta description preview appears here once the copy is generated."}
        </p>
      </div>
    );
  }
  return (
    <article className="rounded-lg border border-black/10 bg-white px-8 py-8 text-neutral-900 dark:border-white/10 dark:bg-neutral-950 dark:text-neutral-100">
      <h1 className="text-3xl font-bold leading-tight tracking-tight">{title}</h1>
      <div className="mt-2 text-sm text-neutral-500">{brand} · article</div>
      <div className="mt-5">
        {node.body.trim() ? (
          body.trim() ? (
            <MarkdownMessage content={body} />
          ) : null
        ) : (
          <EmptyCopy />
        )}
      </div>
    </article>
  );
}

// ── Newsletter / Email ─────────────────────────────────────────────────────────
function EmailFrame({ node, view, brandName }: FrameProps) {
  const from = brandName || "Your Brand";
  const subject = node.subject?.trim() || node.role || "(no subject)";
  const preheader = node.previewText?.trim() || firstLine(node.body);
  const html = useMemo(() => {
    const inner =
      node.layout && node.layout.blocks?.length
        ? renderEmailLayout(node.layout)
        : bodyToHtml(node.body || "");
    return wrap(inner, null);
  }, [node.layout, node.body]);

  if (view === "feed") {
    // As seen "in the feed": the inbox list row.
    return (
      <div className="overflow-hidden rounded-lg border border-black/10 bg-white dark:border-white/10 dark:bg-neutral-950">
        <div className="border-b border-black/5 px-4 py-2 text-xs text-neutral-500 dark:border-white/10">
          📥 Inbox
        </div>
        <div className="flex items-start gap-3 px-4 py-3">
          <div className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-gradient-to-br from-emerald-400 to-teal-500 text-lg font-semibold text-white">
            {initial(from)}
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="truncate text-sm font-semibold text-neutral-900 dark:text-neutral-100">{from}</span>
              <span className="ml-auto shrink-0 text-xs text-neutral-400">now</span>
            </div>
            <div className="truncate text-sm font-medium text-neutral-900 dark:text-neutral-100">{subject}</div>
            <div className="truncate text-sm text-neutral-500">{preheader || "—"}</div>
          </div>
        </div>
      </div>
    );
  }
  return (
    <div className="overflow-hidden rounded-lg border border-black/10 bg-white dark:border-white/10 dark:bg-neutral-950">
      <div className="border-b border-black/10 px-4 py-3 dark:border-white/10">
        <div className="text-lg font-semibold text-neutral-900 dark:text-neutral-100">{subject}</div>
        <div className="mt-1.5 flex items-center gap-2 text-xs text-neutral-500">
          <div className="grid h-7 w-7 place-items-center rounded-full bg-gradient-to-br from-emerald-400 to-teal-500 text-xs font-semibold text-white">
            {initial(from)}
          </div>
          <span>
            <span className="font-medium text-neutral-700 dark:text-neutral-300">{from}</span> · to me
          </span>
        </div>
      </div>
      <iframe srcDoc={html} sandbox="" title="Email preview" className="h-[64vh] w-full bg-white" />
    </div>
  );
}

// ── Generic (standalone / unknown) ───────────────────────────────────────────
function GenericFrame({ node, view }: FrameProps) {
  const clipped = view === "feed" && node.body.length > 280;
  const shown = clipped ? node.body.slice(0, 280) : node.body;
  return (
    <div className="rounded-lg border border-black/10 bg-white p-4 text-sm text-neutral-900 dark:border-white/10 dark:bg-neutral-950 dark:text-neutral-100">
      <div className="mb-1 text-[11px] uppercase tracking-wide text-neutral-400">{channelLabel(node.channel)}</div>
      {node.body.trim() ? (
        <p className="whitespace-pre-wrap leading-relaxed">
          <RichText text={shown} />
          {clipped ? <span className="text-neutral-400"> …</span> : null}
        </p>
      ) : (
        <EmptyCopy />
      )}
    </div>
  );
}

const FRAMES: Record<PreviewKind, (p: FrameProps) => React.ReactElement> = {
  linkedin: LinkedInFrame,
  x: XFrame,
  instagram: InstagramFrame,
  blog: BlogFrame,
  email: EmailFrame,
  generic: GenericFrame,
};

/** Render a node as its channel-native post, in the requested feed/opened state. */
export function ContentPreview({ node, view, brandName, workspaceId }: FrameProps) {
  const Frame = FRAMES[previewKind(node)];
  return <Frame node={node} view={view} brandName={brandName} workspaceId={workspaceId} />;
}
