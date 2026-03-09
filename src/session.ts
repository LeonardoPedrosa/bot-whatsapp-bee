/**
 * session.ts
 *
 * In-memory session manager. Stores per-user conversation history as an
 * array of {role, content} message pairs. No persistence — history resets
 * on process restart, which is acceptable for a stateless, low-cost design.
 */

export interface Message {
  role: "user" | "assistant";
  content: string;
}

// Keyed by WhatsApp JID (e.g., "5585999999999@s.whatsapp.net")
const sessions = new Map<string, Message[]>();

/**
 * Returns the full conversation history for a user.
 * If no session exists yet, returns an empty array.
 */
export function getHistory(userId: string): Message[] {
  return sessions.get(userId) ?? [];
}

/**
 * Appends a new message to the user's conversation history.
 * Creates the session entry if it does not exist.
 */
export function appendMessage(
  userId: string,
  role: "user" | "assistant",
  content: string
): void {
  const history = sessions.get(userId) ?? [];
  history.push({ role, content });
  sessions.set(userId, history);
}

/**
 * Keeps only the last `maxMessages` messages for a user.
 * Prevents unbounded memory growth and keeps token counts manageable.
 * A value of 20 means up to 10 back-and-forth exchanges.
 */
export function trimHistory(userId: string, maxMessages: number): void {
  const history = sessions.get(userId);
  if (!history || history.length <= maxMessages) return;
  sessions.set(userId, history.slice(history.length - maxMessages));
}
