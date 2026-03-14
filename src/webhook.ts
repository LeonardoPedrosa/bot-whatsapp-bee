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
// Per-JID auto-pause — when the owner writes to a client, the bot pauses for
// that specific number and auto-resumes after 48 hours of owner inactivity.
// ---------------------------------------------------------------------------

const OWNER_TAKEOVER_MS = 48 * 60 * 60 * 1_000; // 48 hours
const pausedJids = new Map<string, ReturnType<typeof setTimeout>>();

function pauseForJid(jid: string): void {
  const existing = pausedJids.get(jid);
  if (existing) clearTimeout(existing);

  const timer = setTimeout(() => {
    pausedJids.delete(jid);
    console.log(`[webhook] Auto-resumed bot for ${jid} after owner inactivity`);
  }, OWNER_TAKEOVER_MS);

  pausedJids.set(jid, timer);
  console.log(`[webhook] Bot paused for ${jid} (owner took over)`);
}

// ---------------------------------------------------------------------------
// Name filter — silently ignore messages that mention the owner's name
// ---------------------------------------------------------------------------

const OWNER_NAME_PATTERN = /\b(luciano|luci[a-z]*|lucano)\b/i;

// ---------------------------------------------------------------------------
// Attendant request — detect when a client wants to speak to a human
// ---------------------------------------------------------------------------

const ATTENDANT_PATTERN = /\b(atendente|atendimento|humano|pessoa|falar com algu[eé]m|quero falar|chamar|suporte|responsável)\b/i;

const OWNER_JID = process.env.OWNER_JID ?? "5581998385772@s.whatsapp.net";

// ---------------------------------------------------------------------------
// Business hours check — Mon–Fri 09:00–18:00 (Brazil BRT = UTC-3)
// ---------------------------------------------------------------------------

function isWithinBusinessHours(): boolean {
  const now = new Date();
  // Convert to BRT (UTC-3) — adjust for server's local offset
  const brtTime = new Date(now.getTime() + (now.getTimezoneOffset() - 180) * 60_000);
  const day = brtTime.getDay();  // 0=Sun … 6=Sat
  const hour = brtTime.getHours();
  return day >= 1 && day <= 5 && hour >= 9 && hour < 18;
}

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
      // Audio messages
      audioMessage?: object;
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
    } else if (from && !from.endsWith("@g.us")) {
      // Owner wrote a normal message to a client — pause bot for that number
      // and reset the 48-hour auto-resume timer.
      pauseForJid(from);
    }
    return;
  }

  // While paused, silently ignore all client messages.
  if (paused) {
    console.log(`[webhook] Bot is paused — ignoring message from ${from}`);
    return;
  }

  // Per-JID owner takeover — bot is silenced for this specific number.
  if (from && pausedJids.has(from)) {
    console.log(`[webhook] Bot paused for ${from} (owner takeover) — ignoring message`);
    return;
  }

  // Skip group messages — only respond to individual chats.
  if (from?.endsWith("@g.us")) {
    console.log(`[webhook] Ignoring group message from ${from}`);
    return;
  }

  // Audio messages — reply with a polite notice and stop processing.
  if (from && payload.data?.message?.audioMessage) {
    await sendMessage(
      from,
      "Eu não consigo escutar áudio ainda, pois sou uma inteligência artificial. Por favor, envie sua mensagem por texto."
    );
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
  // Attendant request — notify owner and reply to client
  // -------------------------------------------------------------------------
  if (ATTENDANT_PATTERN.test(text)) {
    // Always notify the owner regardless of business hours
    await sendMessage(
      OWNER_JID,
      `*Bia:* Cliente solicitando atendimento humano.\n\nNome: ${pushName}\nhttps://wa.me/${from.replace("@s.whatsapp.net", "")}?text=Luciano%3A%0A%0AOl%C3%A1!+Sou+o+Luciano%2C+da+Bee+Assessorar.+%0AComo+posso+ajudar+voc%C3%AA+hoje%3F`
    );

    // Reply to client based on business hours
    if (isWithinBusinessHours()) {
      await sendMessage(
        from,
        "Entendido! Vou chamar um atendente. Em breve alguém entrará em contato com você."
      );
    } else {
      await sendMessage(
        from,
        "Nosso horário de atendimento é de seg - sex das 09 - 18:00. Em breve um atendente entrará em contato com você!"
      );
    }
    return; // Do not call Claude for this message
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

    await sendMessage(from, `*Bia:*\n\n${reply}`);
  } catch (err) {
    console.error(`[webhook] Error generating reply for ${from}:`, err);
    await sendMessage(
      from,
      "Ocorreu um erro ao processar sua mensagem. Por favor, tente novamente em instantes."
    );
  }
}
