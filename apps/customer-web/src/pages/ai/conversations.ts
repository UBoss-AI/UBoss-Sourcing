/**
 * What a conversation is, as the AI Mode page and its sidebar see it.
 *
 * A module of its own rather than a couple of exports beside the sidebar
 * component: React Fast Refresh cannot preserve state across an edit to a file
 * that exports both a component and something else, and a sidebar that
 * remounts on every save loses the thread being read.
 */

export interface ConversationSummary {
  id: string;
  /** What the customer renamed it to. Null is the ordinary case. */
  title: string | null;
  /** The opening question, so an unnamed thread still reads as something. */
  preview: string | null;
  messageCount: number;
  lastMessageAt: string | null;
  createdAt: string;
}

/**
 * What a row is called.
 *
 * The customer's own name for it wins; otherwise their first question, which
 * is a better label than anything generated and costs no provider call to
 * produce. The fallback is only reached by a thread that somehow has neither,
 * which the API's `messageCount > 0` filter should already have excluded.
 */
export function conversationLabel(
  conversation: ConversationSummary,
  fallback: string,
): string {
  const title = conversation.title?.trim() ?? '';
  if (title.length > 0) return title;

  const preview = conversation.preview?.trim() ?? '';
  if (preview.length > 0) return preview;

  return fallback;
}
