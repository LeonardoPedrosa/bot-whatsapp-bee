/**
 * guard.ts
 *
 * Security and validation layer for incoming WhatsApp messages.
 * Enforces a manual blocklist, per-user rate limiting, message length limits,
 * empty-message rejection, and prompt-injection detection.
 *
 * All state is in-memory and resets on process restart.
 */

export type GuardReason =
  | "blocked"
  | "rate_limit"
  | "too_long"
  | "empty"
  | "injection_attempt";

export interface GuardResult {
  allowed: boolean;
  reason?: GuardReason;
}

// ---------------------------------------------------------------------------
// Blocklist
// Manually blocked phone JIDs. Injection attempts are added here automatically.
// ---------------------------------------------------------------------------
const blocklist = new Set<string>();

/**
 * Manually block a user by JID (e.g., for abuse). This is also called
 * automatically when a prompt injection attempt is detected.
 */
export function blockUser(userId: string): void {
  blocklist.add(userId);
}

// ---------------------------------------------------------------------------
// Rate limiting
// Max 10 messages per user within a 60-second sliding window.
// ---------------------------------------------------------------------------
const RATE_LIMIT_MAX = 10;
const RATE_LIMIT_WINDOW_MS = 60_000; // 60 seconds

interface RateEntry {
  count: number;
  resetAt: number; // epoch ms at which the window resets
}

const rateLimits: Record<string, RateEntry> = {};

function checkRateLimit(userId: string): boolean {
  const now = Date.now();
  const entry = rateLimits[userId];

  if (!entry || now >= entry.resetAt) {
    // Start a fresh window
    rateLimits[userId] = { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS };
    return true; // allowed
  }

  if (entry.count >= RATE_LIMIT_MAX) {
    return false; // limit exceeded
  }

  entry.count += 1;
  return true;
}

// ---------------------------------------------------------------------------
// Prompt injection patterns
// If any matches, the sender is permanently blocked.
// ---------------------------------------------------------------------------
const INJECTION_PATTERNS: RegExp[] = [
  /ignore (previous|all) instructions/i,
  /you are now/i,
  /forget your (system|context)/i,
  /act as (an?|a different)/i,
  /jailbreak/i,
  /\bDAN\b/,
  /ignore todas (as|as anteriores) instruções/i,
  /novo prompt/i,
  /finja que você é/i,
];

function hasInjectionAttempt(text: string): boolean {
  return INJECTION_PATTERNS.some((pattern) => pattern.test(text));
}

// ---------------------------------------------------------------------------
// Main validation function
// ---------------------------------------------------------------------------

/**
 * Validates an incoming message from a given sender.
 * Returns { allowed: true } when the message should be processed,
 * or { allowed: false, reason } when it should be rejected.
 *
 * Side effects:
 *  - Increments the rate-limit counter for the sender.
 *  - Adds the sender to the blocklist on injection attempts.
 */
export function validateRequest(
  from: string,
  message: string
): GuardResult {
  // 1. Blocklist check — cheapest, so first
  if (blocklist.has(from)) {
    return { allowed: false, reason: "blocked" };
  }

  // 2. Empty message check
  if (message.trim().length === 0) {
    return { allowed: false, reason: "empty" };
  }

  // 3. Message length check (protects against token-stuffing)
  if (message.length > 1000) {
    return { allowed: false, reason: "too_long" };
  }

  // 4. Prompt injection detection — block the user on detection
  if (hasInjectionAttempt(message)) {
    blockUser(from);
    return { allowed: false, reason: "injection_attempt" };
  }

  // 5. Rate limiting — checked last so counters are not incremented for
  //    already-blocked or trivially-invalid messages
  if (!checkRateLimit(from)) {
    return { allowed: false, reason: "rate_limit" };
  }

  return { allowed: true };
}
