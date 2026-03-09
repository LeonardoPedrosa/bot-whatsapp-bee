# ============================================================
# Stage 1 — Builder
# Installs all dependencies (including devDependencies) and
# compiles TypeScript to JavaScript in /app/dist.
# ============================================================
FROM node:20-alpine AS builder

WORKDIR /app

# Copy dependency manifests first so Docker can cache the npm install layer
COPY package.json package-lock.json ./

# Install all dependencies (including devDependencies for the TS compiler)
RUN npm ci

# Copy the rest of the source files
COPY tsconfig.json ./
COPY src/ ./src/

# Compile TypeScript
RUN npm run build

# ============================================================
# Stage 2 — Runner
# Copies only the compiled output and production dependencies.
# Results in a minimal, production-ready image.
# ============================================================
FROM node:20-alpine AS runner

ENV NODE_ENV=production

WORKDIR /app

# Copy dependency manifests and install ONLY production deps
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Copy compiled JavaScript from the builder stage
COPY --from=builder /app/dist ./dist

# Copy the company knowledge base (read at runtime)
COPY context.txt ./

EXPOSE 3000

# Health check so Railway / Docker knows when the app is ready
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:3000/health || exit 1

CMD ["node", "dist/index.js"]
