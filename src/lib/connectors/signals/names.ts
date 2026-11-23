/**
 * The names suggestions from collected numbers go by (Connectors 2 group 4, ADR-0012), apart
 * from the detector so erase and Review read them without loading it.
 */

/** A Review suggestion: a rising search (brand map at scale off), a page losing clicks, a question within reach. */
export const DATA_SIGNAL_ACTION = "data_signal.suggest";
/** A rising search proposed as a question on the brand map at any size. */
export const PROPOSE_QUESTION_ACTION = "brand_map.propose_question";
/** The agent that proposes both (already in AGENT_NAMES). */
export const SIGNALS_AGENT = "connector_signals" as const;
/** Where a suggestion's Review row sits. */
export const SIGNALS_REVIEW_HREF = "/admin/approvals#data_signal";
/** A suggestion stays open this long before it expires. */
export const EXPIRY_DAYS = 30;
