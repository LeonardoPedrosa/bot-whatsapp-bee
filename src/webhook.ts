/**
 * webhook.ts
 *
 * Evolution API webhook handler.
 *
 * Registers a single POST /webhook route on the Express app.
 * The route immediately responds with HTTP 200 so Evolution API does not
 * retry the delivery, then processes the message asynchronously.
 *
 * Payload shape (Evolution API v2 "messages.upsert" event):
 * {
 *   event: "messages.upsert",
 *   instance: "my-bot",
 *   data: {
 *     key: { remoteJid: "5585999999999@s.whatsapp.net", fromMe: false, id: "..." },
 *     message: { conversation: "User text here" },
 *     messageTimestamp: 1700000000,
 *     pushName: "John Doe"
 *   }
 * }
 */

import { Express, Request, Response } from "express";
import { validateRequest } from "./guard";
import { askClaude } from "./claude";
import { sendMessage } from "./whatsapp";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface WebhookPayload {
  event?: string;
  instance?: string;
  data?: {
    key?: {
      remoteJid?: string;
      fromMe?: boolean;
      id?: string;
    };
    message?: {
      // Plain text messages arrive here
      conversation?: string;
      // Some clients send extended text (link previews, etc.)
      extendedTextMessage?: { text?: string };
    };
    messageTimestamp?: number;
    pushName?: string;
  };
}

// ---------------------------------------------------------------------------
// Message extraction helpers
// ---------------------------------------------------------------------------

/**
 * Extracts the plain text content from a message payload.
 * Returns undefined if no text is found (e.g., media-only messages).
 */
function extractText(payload: WebhookPayload): string | undefined {
  const msg = payload.data?.message;
  if (!msg) return undefined;

  // Prefer the plain conversation field; fall back to extended text.
  return (
    msg.conversation ??
    msg.extendedTextMessage?.text
  );
}

// ---------------------------------------------------------------------------
// Webhook route
// ---------------------------------------------------------------------------

export function registerWebhook(app: Express): void {
  app.post("/webhook", (req: Request, res: Response) => {
    // Respond immediately to prevent Evolution API from retrying.
    res.sendStatus(200);

    // Process the message asynchronously — do not await here.
    processWebhook(req.body as WebhookPayload).catch((err) => {
      console.error("[webhook] Unhandled error in processWebhook:", err);
    });
  });

  console.log("[webhook] Route registered: POST /webhook");
}

// ---------------------------------------------------------------------------
// Async message processor
// ---------------------------------------------------------------------------

async function processWebhook(payload: WebhookPayload): Promise<void> {
  // Only handle "messages.upsert" events; ignore status updates, etc.
  if (payload.event !== "messages.upsert") return;

  const from = payload.data?.key?.remoteJid;
  const fromMe = payload.data?.key?.fromMe;
  const text = extractText(payload);
  const pushName = payload.data?.pushName ?? "User";

  // Skip messages sent by the bot itself to avoid infinite loops.
  if (fromMe === true) return;

  // Skip if we could not extract a sender or text (media messages, etc.).
  if (!from || !text) return;

  console.log(`[webhook] Incoming from ${pushName} (${from}): "${text.slice(0, 80)}"`);

  // -------------------------------------------------------------------------
  // Security & validation
  // -------------------------------------------------------------------------
  const guard = validateRequest(from, text);

  if (!guard.allowed) {
    console.warn(
      `[webhook] Message from ${from} rejected — reason: ${guard.reason}`
    );

    // For rate-limited users, send a polite message so they know to slow down.
    if (guard.reason === "rate_limit") {
      await sendMessage(
        from,
        "Please wait a moment before sending more messages. I'll be happy to help you shortly!"
      );
    }

    // Injection attempts are silently blocked (no reply — do not reward the attempt).
    // Other reasons (blocked, empty, too_long) are also silently discarded.
    return;
  }

  // -------------------------------------------------------------------------
  // Claude reply
  // -------------------------------------------------------------------------
  try {
    const reply = await askClaude(from, text);
    await sendMessage(from, reply);
  } catch (err) {
    console.error(`[webhook] Error generating reply for ${from}:`, err);
    await sendMessage(
      from,
      "Sorry, an error occurred while processing your message. Please try again in a moment."
    );
  }
}
