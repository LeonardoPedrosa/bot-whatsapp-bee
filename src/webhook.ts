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
import { sendMessage, sendTyping } from "./whatsapp";
import { isFirstMessage } from "./session";

// ---------------------------------------------------------------------------
// Pause/Resume — owner can silence the bot by sending /pause from the bot's
// own number (fromMe: true). Send /resume to bring it back.
// ---------------------------------------------------------------------------

let paused = false;

// ---------------------------------------------------------------------------
// Name filter — silently ignore messages that mention the owner's name
// ---------------------------------------------------------------------------

const OWNER_NAME_PATTERN = /\b(luciano|luci[a-z]*|lucano)\b/i;

// ---------------------------------------------------------------------------
// Deduplication — prevents the same message being processed twice
// (Evolution API can occasionally deliver duplicates)
// ---------------------------------------------------------------------------

const processedIds = new Set<string>();

function markProcessed(id: string): void {
  processedIds.add(id);
  // Auto-expire after 60 s to avoid unbounded growth
  setTimeout(() => processedIds.delete(id), 60_000);
}

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
  const messageId = payload.data?.key?.id;
  const text = extractText(payload);
  const pushName = payload.data?.pushName ?? "";

  // Handle owner commands sent from the bot's own number (fromMe: true).
  if (fromMe === true) {
    const cmd = text?.trim().toLowerCase();
    if (cmd === "/pause") {
      paused = true;
      console.log("[webhook] Bot paused by owner");
    } else if (cmd === "/resume") {
      paused = false;
      console.log("[webhook] Bot resumed by owner");
    }
    return;
  }

  // While paused, silently ignore all client messages.
  if (paused) {
    console.log(`[webhook] Bot is paused — ignoring message from ${from}`);
    return;
  }

  // Skip group messages — only respond to individual chats.
  if (from?.endsWith("@g.us")) {
    console.log(`[webhook] Ignoring group message from ${from}`);
    return;
  }

  // Skip if we could not extract a sender or text (media messages, etc.).
  if (!from || !text) return;

  // Deduplicate — skip messages we've already handled.
  if (messageId) {
    if (processedIds.has(messageId)) {
      console.log(`[webhook] Duplicate message ${messageId} ignored`);
      return;
    }
    markProcessed(messageId);
  }

  // Silently ignore messages that mention the owner's name.
  if (OWNER_NAME_PATTERN.test(text)) {
    console.log(`[webhook] Ignoring message mentioning owner name from ${from}`);
    return;
  }

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
        "Aguarde um momento antes de enviar mais mensagens. Em breve estarei pronta para te ajudar!"
      );
    }

    // Injection attempts are silently blocked (no reply — do not reward the attempt).
    // Other reasons (blocked, empty, too_long) are also silently discarded.
    return;
  }

  // -------------------------------------------------------------------------
  // Claude reply
  // -------------------------------------------------------------------------
  const first = isFirstMessage(from);

  // Random typing delay between 3 and 5 seconds to feel more human.
  const delayMs = 3_000 + Math.floor(Math.random() * 2_000);

  await sendTyping(from, delayMs);
  await new Promise((resolve) => setTimeout(resolve, delayMs));

  try {
    const reply = await askClaude(from, text, pushName, first);

    // If Claude signals out-of-scope, stay silent — no message sent to client.
    if (reply === "[FORA_DE_CONTEXTO]") {
      console.log(`[webhook] Out-of-scope message from ${from} — no reply sent`);
      return;
    }

    await sendMessage(from, `*BEEatriz:*\n${reply}`);
  } catch (err) {
    console.error(`[webhook] Error generating reply for ${from}:`, err);
    await sendMessage(
      from,
      "Ocorreu um erro ao processar sua mensagem. Por favor, tente novamente em instantes."
    );
  }
}
