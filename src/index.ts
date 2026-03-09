/**
 * index.ts
 *
 * Application entry point.
 *
 * Loads environment variables, creates the Express server,
 * registers routes, and starts listening.
 */

import "dotenv/config";
import express from "express";
import { registerWebhook } from "./webhook";

const app = express();

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------
app.use(express.json());

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

// Liveness / readiness probe (used by Railway and load balancers)
app.get("/health", (_req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// WhatsApp webhook (Evolution API)
registerWebhook(app);

// ---------------------------------------------------------------------------
// Start server
// ---------------------------------------------------------------------------
const PORT = Number(process.env.PORT) || 3000;

app.listen(PORT, () => {
  console.log(`[server] WhatsApp AI Agent running on port ${PORT}`);
  console.log(`[server] Health check: http://localhost:${PORT}/health`);
  console.log(`[server] Webhook endpoint: http://localhost:${PORT}/webhook`);
});
