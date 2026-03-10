/**
 * whatsapp.ts
 *
 * Thin client for Evolution API.
 * Provides a single sendMessage() function that posts a text message to a
 * WhatsApp number through an Evolution API instance.
 *
 * Errors are caught and logged without crashing the process — a failed
 * message delivery should never bring down the whole server.
 */

import axios from "axios";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getConfig() {
  const url = process.env.EVOLUTION_URL;
  const apiKey = process.env.EVOLUTION_API_KEY;
  const instance = process.env.EVOLUTION_INSTANCE_NAME;

  if (!url || !apiKey || !instance) {
    throw new Error(
      "Missing Evolution API environment variables: " +
        "EVOLUTION_URL, EVOLUTION_API_KEY, EVOLUTION_INSTANCE_NAME"
    );
  }

  return { url, apiKey, instance };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Sends a plain-text WhatsApp message via Evolution API.
 *
 * @param to   - Recipient JID (e.g., "5585999999999@s.whatsapp.net")
 *               or bare number (Evolution API accepts both formats).
 * @param text - The message body to send.
 */
export async function sendMessage(to: string, text: string): Promise<void> {
  let config: ReturnType<typeof getConfig>;

  try {
    config = getConfig();
  } catch (err) {
    console.error("[whatsapp] Configuration error:", err);
    return;
  }

  const endpoint = `${config.url}/message/sendText/${config.instance}`;

  try {
    await axios.post(
      endpoint,
      { number: to, text },
      {
        headers: {
          apikey: config.apiKey,
          "Content-Type": "application/json",
        },
        // Reasonable timeout to prevent hanging requests
        timeout: 15_000,
      }
    );

    console.log(`[whatsapp] Message sent to ${to}`);
  } catch (err) {
    // Log details without crashing — a delivery failure is non-fatal.
    if (axios.isAxiosError(err)) {
      console.error(
        `[whatsapp] Failed to send message to ${to}: ` +
          `HTTP ${err.response?.status ?? "?"} — ${JSON.stringify(err.response?.data ?? err.message)}`
      );
    } else {
      console.error(`[whatsapp] Unexpected error sending to ${to}:`, err);
    }
  }
}

/**
 * Sends a "composing" (typing) presence indicator to the given number.
 * Errors are swallowed — a failed presence update is non-fatal.
 *
 * @param to         - Recipient JID or bare number.
 * @param durationMs - How long (ms) to show the typing indicator.
 */
export async function sendTyping(to: string, durationMs: number): Promise<void> {
  let config: ReturnType<typeof getConfig>;

  try {
    config = getConfig();
  } catch {
    return;
  }

  const endpoint = `${config.url}/chat/sendPresence/${config.instance}`;

  console.log(`[whatsapp] Sending typing presence to ${to} (${durationMs}ms) — endpoint: ${endpoint}`);

  try {
    await axios.post(
      endpoint,
      { number: to, presence: "composing", delay: durationMs },
      {
        headers: {
          apikey: config.apiKey,
          "Content-Type": "application/json",
        },
        timeout: 10_000,
      }
    );
    console.log(`[whatsapp] Typing presence sent to ${to}`);
  } catch (err) {
    if (axios.isAxiosError(err)) {
      console.error(
        `[whatsapp] Failed to send typing presence to ${to}: ` +
          `HTTP ${err.response?.status ?? "?"} — ${JSON.stringify(err.response?.data ?? err.message)}`
      );
    } else {
      console.error(`[whatsapp] Unexpected error sending presence to ${to}:`, err);
    }
  }
}
