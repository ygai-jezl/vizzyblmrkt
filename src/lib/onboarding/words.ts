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
