/**
 * Every word on the getting to know you screens, in one place, so the help can quote them and a
 * test can hold them to house style (src/lib/content/writingRules.ts). Client safe. The words are
 * the owner-approved mockups' except where a comment says a state wasn't drawn.
 */

export const FRAME_WORDS = {
  label: "Welcome",
} as const;

export const WELCOME_WORDS = {
  title: "Hi, I'm Vizzy, your AI co-founder",
  lead: (brand: string) => `Tell me about ${brand} and I'll suggest your first steps.`,
  talk: "Talk with Vizzy",
  fastest: "Fastest",
  talkSub: "By voice, 3 to 5 minutes",
  talkHint:
    "Talking it through gets you value from YouGrow sooner. Vizzy learns far more from a conversation than from four answers, so your first steps fit from day one.",
  orQuestions: "Or answer 4 quick questions",
  /** With voice off the questions are the main choice (not drawn in the mockups). */
  questions: "Answer 4 quick questions",
  skip: "Skip for now",
  foot: "Vizzy keeps the words, never the audio. Read or delete them in Settings.",
} as const;

/** Talk with Vizzy: the microphone, the call and its end (Welcome.html). */
export const VOICE_WORDS = {
  micTitle: "Allow your microphone",
  micLead: "Your browser asks once. Vizzy listens only on this page.",
  instead: "Answer 4 quick questions instead",
  micFoot: "Vizzy keeps the words, never the audio.",
  live: "Live",
  left: (clock: string) => `${clock} left`,
  leftAria: (clock: string) => `Time left: ${clock}`,
  listening: "Listening",
  muted: "Muted",
  topics: "What Vizzy makes sure it covers",
  covered: (answer: string) => ` (covered: ${answer})`,
  now: " (talking about it now)",
  transcript: "Live transcript",
  vizzy: "Vizzy",
  you: "You",
  mute: "Mute",
  end: "End",
  talkFoot: "Talk about anything else too. Vizzy keeps the words, never the audio.",
  endedTitle: "Thanks, that's plenty",
  allCovered: (length: string) => `${length}. All four covered.`,
  /** Fewer than four (not drawn in the mockups). */
  someCovered: (length: string, n: number) => `${length}. ${n} of 4 covered.`,
  heard: "What Vizzy heard",
  seeLearned: "See what I learned",
  endedFoot: "The transcript is in Settings, under About your business.",
  /** When a call can't start or stops (not drawn in the mockups). */
  blocked: "Your browser blocked the microphone. Allow it in your browser's site settings, or answer 4 quick questions.",
  usedToday: "You've talked with Vizzy today. Answer 4 quick questions, or talk again tomorrow.",
  unavailable: "Voice isn't available right now. Answer 4 quick questions instead.",
  full: "You've kept 20 conversations. Delete one in Settings to talk again.",
  dropped: "The call dropped. What you said so far is kept.",
} as const;

export const QUESTIONS_WORDS = {
  progress: (n: number, of: number) => `${n} of ${of}`,
  soFar: "Your answers so far",
  pickOne: "Pick one. You can change it later.",
  back: "Back",
  skip: "Skip",
  done: "That's all four",
  yourAnswers: "Your answers",
  skipped: (short: string) => `${short}: skipped`,
  next: "See your next action",
  foot: "Talk with Vizzy any time to tell it more. Settings, About your business.",
  /** When the last save fails (not drawn in the mockups). */
  notSaved: "Your answers didn't save.",
  retry: "Try again",
} as const;

/** Here's what I learned, after a call (Learned.html). */
export const LEARNED_WORDS = {
  fromCall: (length: string, date: string) => `From our call, ${length}, ${date}`,
  fromChat: (messages: string, date: string) => `From our chat, ${messages}, ${date}`,
  title: "Here's what I learned",
  lead: "Change anything that's off. Vizzy reads this in every chat.",
  basics: "The basics",
  heard: "What else I heard",
  nothing: "Nothing else for now.",
  removed: (fact: string) => `Removed: ${fact}`,
  undo: "Undo",
  looksRight: "Looks right",
  readTranscript: "Read the transcript",
  readChat: "Read the chat",
  /** When Looks right fails (not drawn in the mockups). */
  notSaved: "That didn't save. Try again.",
} as const;

/** The four answers as chips, on Learned and in Settings, About your business. */
export const BASICS_WORDS = {
  change: (short: string, answer: string) => `${short}: ${answer}. Change`,
  notSure: "Not sure yet",
  whyUnsure: (words: string) => `I couldn't tell from “${words}” Which fits?`,
  notPicked: "Not picked",
  notPickedAria: (short: string) => `${short}: not picked. Change`,
} as const;

/** What Vizzy heard, each with the member's own words. */
export const FACT_WORDS = {
  remove: "Remove",
  removeAria: (fact: string) => `Remove ${fact}`,
  fromCall: (date: string) => `From our call, ${date}`,
  fromChat: (date: string) => `From a chat, ${date}`,
} as const;

/** Read the conversation (About.overlay.html), on Learned and in Settings. */
export const TRANSCRIPT_WORDS = {
  title: "Read the conversation",
  close: "Close",
  call: "Call with Vizzy",
  chat: "Chat with Vizzy",
  callMeta: (date: string, length: string, turns: number) => `${date}, ${length}, ${turns} ${turns === 1 ? "turn" : "turns"}`,
  chatMeta: (date: string, messages: string) => `${date}, ${messages}`,
  vizzy: "Vizzy",
  you: "You",
  private: "Only your admins and Vizzy can read this. No audio is kept.",
  delete: "Delete",
  /** While the words load, and when they don't (not drawn in the mockups). */
  loading: "Getting the words.",
  failed: "The transcript didn't load.",
  retry: "Try again",
} as const;

/** Delete this conversation? (About.overlay.html). */
export const DELETE_CONVERSATION_WORDS = {
  title: "Delete this conversation?",
  text: (what: "call" | "chat", date: string) => `The transcript of your ${what} on ${date} goes for good.`,
  keep: "What Vizzy learned from it stays until you remove it.",
  cancel: "Cancel",
  confirm: "Delete conversation",
  close: "Close",
  /** When the delete fails (not drawn in the mockups). */
  failed: "It didn't delete. Try again.",
} as const;

/** Settings, General, About your business (About.html, About.js). */
export const ABOUT_WORDS = {
  title: "About your business",
  lead: "Vizzy reads this in every chat. Only your admins and Vizzy see it.",
  /** With no call kept (an existing brand starting from Settings; not drawn in the mockups). */
  talk: "Talk with Vizzy",
  talkAgain: "Talk with Vizzy again",
  deleted: "Conversation deleted.",
  basics: "The basics",
  learned: "What Vizzy learned",
  noFacts: "Nothing yet. Talk with Vizzy to add more.",
  conversations: "Conversations",
  table: "Conversations with Vizzy",
  conversation: "Conversation",
  date: "Date",
  length: "Length",
  actions: "Actions",
  view: "View transcript",
  viewAria: (what: "call" | "chat", date: string) => `View the transcript of the ${what} on ${date}`,
  delete: "Delete",
  deleteAria: (what: "call" | "chat", date: string) => `Delete the ${what} on ${date}`,
  noConversations: "No conversations kept.",
  kept: "Vizzy keeps the words, never the audio. Each one stays until you delete it.",
  /** When a change or a list fails (not drawn in the mockups). */
  notSaved: "That didn't save. Try again.",
  notRemoved: "It wasn't removed. Try again.",
  notLoaded: "This list didn't load. Try again in a moment.",
} as const;

/** Home's card of steps, with getting to know you on (Home.html). */
export const HOME_WORDS = {
  nextAction: "Your next action",
} as const;

const DAY_MONTH = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
const DAY_MONTH_YEAR = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

/** "25 Nov", with the year when it isn't this year's. "" for a date that can't be read. */
export function shortDate(at: string, now: number = Date.now()): string {
  const ms = Date.parse(at);
  if (!Number.isFinite(ms)) return "";
  const d = new Date(ms);
  return (d.getUTCFullYear() === new Date(now).getUTCFullYear() ? DAY_MONTH : DAY_MONTH_YEAR).format(d);
}

/** A call's length in round minutes ("4 min"), or seconds under a minute ("45 s"). */
export function shortLength(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  return s < 60 ? `${s} s` : `${Math.round(s / 60)} min`;
}

/** A call's length to the second ("4 min 12 s", "4 min", "45 s"). */
export function longLength(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  const m = Math.floor(s / 60);
  const rest = s % 60;
  if (!m) return `${rest} s`;
  return rest ? `${m} min ${rest} s` : `${m} min`;
}

/** "11 messages", "1 message". */
export function messageCount(n: number): string {
  return `${n} ${n === 1 ? "message" : "messages"}`;
}
