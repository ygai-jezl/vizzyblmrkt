import { C, Note } from "@/components/developers/Doc";
import { isIdeaWordsEnabled } from "@/lib/ideas/flags";

/**
 * While the screens call launches ideas (isIdeaWordsEnabled()), says the API hasn't changed: an idea
 * is a launch, with the same id and site key, and the API's paths, fields and errors keep "launch".
 * Renaming the API is piece K's; until then this note is the only place the docs say idea.
 */
export function IdeasApiNote() {
  if (!isIdeaWordsEnabled()) return null;
  return (
    <Note>
      <strong>Launches and ideas.</strong> YouGrow&apos;s screens call a launch an idea. It is the same thing, with the same
      id and the same site key, and the API keeps the word launch, as in the error <C>launch_closed</C>.
    </Note>
  );
}
