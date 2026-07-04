import { describe, it, expect } from "vitest";
import { buildVoiceChatLink } from "./voiceChatLink";
import type { Signup } from "@/lib/types/signup";
import type { Campaign } from "@/lib/types/campaign";

const voiceOn = { aiConversation: { enabled: true } } as unknown as Campaign;
const voiceOff = { aiConversation: { enabled: false } } as unknown as Campaign;

function signupWith(
  referralLink: string,
  extra: Partial<Signup> = {},
): Signup {
  return { referralLink, referralToken: "ABC123", ...extra } as unknown as Signup;
}

describe("buildVoiceChatLink", () => {
  it("swaps ?ref= for rt+voice and keeps the tenant hint (shared host)", () => {
    const link = buildVoiceChatLink(
      signupWith("https://yougrow.ai/waitlist/camp1?ref=ABC123&t=ten_x"),
      voiceOn,
    );
    expect(link).toBe(
      "https://yougrow.ai/waitlist/camp1?t=ten_x&rt=ABC123&voice=1",
    );
  });

  it("builds a link when our hosted page is served on a custom domain", () => {
    // Custom DOMAIN still serving our /waitlist route (waitlistUrlLocation unset):
    // the voice handling runs, so a link is produced.
    const link = buildVoiceChatLink(
      signupWith("https://brand.example/waitlist/camp1?ref=ABC123"),
      voiceOn,
    );
    expect(link).toBe("https://brand.example/waitlist/camp1?rt=ABC123&voice=1");
  });

  it("returns '' for a launch with a custom external waitlist page", () => {
    // waitlistUrlLocation = the brand's own site, which runs none of our voice
    // deep-link handling, so the link would dead-end.
    expect(
      buildVoiceChatLink(signupWith("https://brand.example/join?ref=ABC123"), {
        aiConversation: { enabled: true },
        waitlistUrlLocation: "https://brand.example/join",
      } as unknown as Campaign),
    ).toBe("");
  });

  it("appends the recipient's stored language so the landing matches the email", () => {
    const link = buildVoiceChatLink(
      signupWith("https://yougrow.ai/waitlist/camp1?ref=ABC123&t=ten_x", {
        locale: "fr",
      }),
      voiceOn,
    );
    expect(link).toBe(
      "https://yougrow.ai/waitlist/camp1?t=ten_x&rt=ABC123&voice=1&lng=fr",
    );
  });

  it("preserves query values that themselves contain '?'", () => {
    const link = buildVoiceChatLink(
      signupWith("https://yougrow.ai/waitlist/camp1?next=/a?b=c&ref=ABC123"),
      voiceOn,
    );
    // The `b=c` tail must survive (a naive split("?") would drop it).
    expect(link).toBe(
      "https://yougrow.ai/waitlist/camp1?next=%2Fa%3Fb%3Dc&rt=ABC123&voice=1",
    );
  });

  it("returns '' when the launch has the voice feature disabled", () => {
    expect(
      buildVoiceChatLink(
        signupWith("https://yougrow.ai/waitlist/camp1?ref=ABC123"),
        voiceOff,
      ),
    ).toBe("");
    expect(
      buildVoiceChatLink(
        signupWith("https://yougrow.ai/waitlist/camp1?ref=ABC123"),
        {} as unknown as Campaign,
      ),
    ).toBe("");
  });

  it("returns '' when the signup lacks referralLink or referralToken", () => {
    expect(buildVoiceChatLink(signupWith(""), voiceOn)).toBe("");
    expect(
      buildVoiceChatLink(
        { referralLink: "https://x.test/?ref=ABC123", referralToken: "" } as unknown as Signup,
        voiceOn,
      ),
    ).toBe("");
  });
});
