"use client";

import { createContext, useContext, type ReactNode } from "react";

/** The words the admin screens use now, worked out on the server. */
export interface Words {
  /** Launches are called Ideas (isIdeaWordsEnabled()). */
  ideas: boolean;
}

const WordsContext = createContext<Words>({ ideas: false });

/**
 * Hands the server's answer to client components deep in the admin screens, the way
 * DeveloperDocsProvider does for /developers. The admin layout wraps its pages in it (nav v2 only:
 * the words need phase 3, so outside it everything reads false). The shell's own pieces (sidebar,
 * header, ⌘K, ShellProvider) take a prop instead, as they do for People.
 */
export function WordsProvider({ ideas, children }: { ideas: boolean; children: ReactNode }) {
  return <WordsContext.Provider value={{ ideas }}>{children}</WordsContext.Provider>;
}

/** The words in use: `ideaWord(useWords().ideas)` names a launch in a client component. */
export function useWords(): Words {
  return useContext(WordsContext);
}
