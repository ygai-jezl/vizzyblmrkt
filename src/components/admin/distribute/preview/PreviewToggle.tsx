"use client";

import { useState } from "react";
import { ChannelPreview } from "./ChannelPreviews";

/** A "Preview" link that expands a channel-native preview of the copy inline. */
export function PreviewToggle({ channel, body }: { channel: string; body: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="text-xs text-neutral-500 underline-offset-2 hover:underline"
        aria-expanded={open}
      >
        {open ? "Hide preview" : "Preview"}
      </button>
      {open ? (
        <div className="mt-2 max-w-md">
          <ChannelPreview channel={channel} body={body} />
        </div>
      ) : null}
    </div>
  );
}
