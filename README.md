# WhatsApp AI Agent

A production-ready WhatsApp chatbot that answers questions about a single company using Anthropic Claude (Haiku 4.5). Built with Node.js + TypeScript, designed to run on [Railway](https://railway.app) and integrate with [Evolution API](https://doc.evolution-api.com) as the WhatsApp bridge.

**Key characteristics:**
- Stateless and database-free (in-memory session history only)
- Cost-optimised: uses Claude Haiku 4.5 + prompt caching for the company knowledge base
- Security layer: blocklist, rate limiting, prompt injection detection
- Only responds to incoming messages — never initiates conversations

---

## Project Structure

```
/
├── src/
│   ├── index.ts       # Entry point — Express server setup
│   ├── webhook.ts     # Evolution API webhook handler
│   ├── guard.ts       # Security & validation (blocklist, rate limit, injection)
│   ├── claude.ts      # Anthropic Claude API integration
│   ├── whatsapp.ts    # Evolution API client (send messages)
│   └── session.ts     # In-memory conversation history
├── context.txt        # Company knowledge base (replace with your own data)
├── .env.example       # Environment variable template
├── tsconfig.json
├── package.json
├── Dockerfile
└── README.md
```

---

## Prerequisites

- Node.js 20+
- An [Anthropic API key](https://console.anthropic.com)
- A running [Evolution API](https://doc.evolution-api.com) instance with a WhatsApp instance connected

---

## Running Locally

### 1. Install dependencies

```bash
npm install
```

### 2. Configure environment variables

```bash
cp .env.example .env
```

Edit `.env` and fill in all values:

```env
ANTHROPIC_API_KEY=sk-ant-...
EVOLUTION_URL=https://my-evolution.up.railway.app
EVOLUTION_API_KEY=your-evolution-api-key
EVOLUTION_INSTANCE_NAME=my-bot
PORT=3000
```

### 3. Customise the knowledge base

Edit `context.txt` with your company's information. The file is read once at startup and cached in the Anthropic system prompt. Replace the sample NovaTech content with your own:

- Company overview
- Products and services
- Pricing
- Opening hours
- Contact information
- FAQ

### 4. Start the development server

```bash
npm run dev
```

The server starts on `http://localhost:3000`. Test the health endpoint:

```bash
curl http://localhost:3000/health
# {"status":"ok","timestamp":"2025-01-15T10:00:00.000Z"}
```

---

## Building and Running with Docker

```bash
# Build the image
docker build -t whatsapp-ai-agent .

# Run the container (pass env vars from your .env file)
docker run --env-file .env -p 3000:3000 whatsapp-ai-agent
```

---

## Deploying on Railway

### 1. Push your code to GitHub

Create a GitHub repository and push this project.

### 2. Create a new Railway service

1. Go to [railway.app](https://railway.app) and create a new project.
2. Click **Deploy from GitHub repo** and select your repository.
3. Railway will auto-detect the `Dockerfile` and build your service.

### 3. Set environment variables

In your Railway service settings → **Variables**, add:

| Variable | Value |
|---|---|
| `ANTHROPIC_API_KEY` | Your Anthropic API key |
| `EVOLUTION_URL` | URL of your Evolution API service |
| `EVOLUTION_API_KEY` | Your Evolution API key |
| `EVOLUTION_INSTANCE_NAME` | Your Evolution instance name |
| `PORT` | `3000` (Railway injects `$PORT` automatically too) |

### 4. Deploy

Railway will build the Docker image and deploy automatically on every push to your main branch. Your service will get a public URL like `https://my-bot.up.railway.app`.

---

## Configuring Evolution API

### 1. Deploy Evolution API

Deploy Evolution API as a separate Railway service (or any other hosting). Follow the [official docs](https://doc.evolution-api.com/get-started/installation).

### 2. Create a WhatsApp instance

Using the Evolution API Manager UI or REST API, create a new instance:

```bash
curl -X POST https://your-evolution.up.railway.app/instance/create \
  -H "apikey: YOUR_EVOLUTION_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"instanceName": "my-bot", "qrcode": true}'
```

### 3. Connect via QR Code

1. Open the Evolution Manager UI.
2. Select your instance.
3. Scan the QR code with the WhatsApp Business app on your phone.

### 4. Configure the webhook

Point Evolution API to your bot's webhook endpoint:

```bash
curl -X POST https://your-evolution.up.railway.app/webhook/set/my-bot \
  -H "apikey: YOUR_EVOLUTION_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://YOUR-BOT.up.railway.app/webhook",
    "webhook_by_events": false,
    "events": ["MESSAGES_UPSERT"]
  }'
```

Replace `YOUR-BOT.up.railway.app` with your actual Railway bot URL and `my-bot` with your instance name.

---

## How It Works

1. **Incoming message** → Evolution API sends a POST to `/webhook`.
2. **Ack** → Bot immediately responds with HTTP 200 to prevent retries.
3. **Guard** → Message is validated: blocklist, empty, too long, rate limit, injection.
4. **Claude** → Validated message + session history sent to Claude Haiku 4.5.
5. **Reply** → Bot sends the assistant reply back via Evolution API.

### Security features (guard.ts)

| Check | Behaviour |
|---|---|
| Blocklist | Sender permanently blocked — silent drop |
| Empty message | Silent drop |
| Message > 1000 chars | Silent drop |
| > 10 messages / 60s | Send polite rate-limit notice |
| Prompt injection attempt | Block sender permanently — silent drop |

### Prompt caching

The company knowledge base (`context.txt`) is sent to Claude with `cache_control: { type: "ephemeral" }`. On the first request the full content is billed at the normal input token rate; subsequent requests within the ~5-minute cache window are billed at ~10% of the input token cost, significantly reducing API spend for busy bots.

---

## Updating the Knowledge Base

Edit `context.txt` and redeploy. The file is read once at startup, so a rolling restart is needed to pick up changes. On Railway, pushing a new commit triggers a redeploy automatically.

---

## Useful Commands

```bash
npm run dev       # Start development server with auto-reload
npm run build     # Compile TypeScript to dist/
npm run start     # Run compiled output
npm run typecheck # Type-check without emitting files
```

---

## Environment Variables Reference

| Variable | Required | Description |
|---|---|---|
| `ANTHROPIC_API_KEY` | Yes | Anthropic API key |
| `EVOLUTION_URL` | Yes | Base URL of your Evolution API instance |
| `EVOLUTION_API_KEY` | Yes | Evolution API authentication key |
| `EVOLUTION_INSTANCE_NAME` | Yes | Name of the WhatsApp instance in Evolution |
| `PORT` | No | HTTP port (default: 3000) |
