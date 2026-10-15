import { createHash, randomBytes } from "node:crypto";
import { normalizeUrl, textKey } from "@/lib/content/blog/brief";
import { fold } from "./changes";

/**
 * Ids and keys for the map's records (BRAND_MAP_SCALE_ENABLED). Server-only.
 *
 * A record proposed by research, an import or Vizzy takes its id from what it is (a
 * subject from its name, a question from its subject and words), so two research steps
 * running at once can never propose the same thing twice. A collision with a record since
 * renamed falls back to a fresh id (records.ts).
 */

const digest = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 20);

export const subjectKey = (name: string) => fold(name);
export const questionKey = (text: string) => textKey(text);
export const situationKey = (text: string) => textKey(text);
export const urlKey = (url: string | null | undefined) => (url ? normalizeUrl(url) || null : null);

export const subjectIdFor = (tenantId: string, name: string) => `sub_${digest(`${tenantId}\nsub\n${subjectKey(name)}`)}`;
export const questionIdFor = (tenantId: string, subjectId: string, text: string) => `q_${digest(`${tenantId}\nq\n${subjectId}\n${questionKey(text)}`)}`;
export const groupIdFor = (tenantId: string, name: string) => `grp_${digest(`${tenantId}\ngrp\n${fold(name)}`)}`;
export const situationIdFor = (tenantId: string, text: string) => `sit_${digest(`${tenantId}\nsit\n${situationKey(text)}`)}`;

/** A fresh id, made once and never reused. */
export const freshId = (prefix: "sub" | "q" | "grp" | "sit" | "run" | "imp") => `${prefix}_${randomBytes(10).toString("hex")}`;

/** Answered ÷ questions in thousandths, for sorting least answered first. */
export const shareOf = (answered: number, questions: number) => (questions > 0 ? Math.round((1000 * answered) / questions) : 0);
