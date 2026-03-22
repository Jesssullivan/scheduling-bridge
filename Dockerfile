# Dockerfile
# Standalone middleware server with Playwright + Chromium
# for running the Acuity wizard automation remotely.
#
# Usage:
#   docker build -t acuity-middleware .
#   docker run -p 3001:3001 \
#     -e AUTH_TOKEN=... \
#     -e ACUITY_BASE_URL=https://MassageIthaca.as.me \
#     -e ACUITY_BYPASS_COUPON=... \
#     acuity-middleware
#
# Modal Labs:
#   modal deploy modal-app.py

FROM mcr.microsoft.com/playwright:v1.58.2-noble

# Install Node.js 22 LTS + pnpm
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && \
    apt-get install -y nodejs && \
    corepack enable && corepack prepare pnpm@9.15.9 --activate && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package files for dependency install
COPY package.json ./

# Install production dependencies only (playwright comes from base image)
RUN pnpm install --no-frozen-lockfile --prod

# Copy source
COPY src/ ./src/
COPY tsconfig.json ./

# Pre-compile with tsx for faster startup
RUN pnpm add tsx

# Non-root user for security
RUN useradd -m -s /bin/bash middleware
USER middleware

EXPOSE 3001

ENV NODE_ENV=production
ENV PORT=3001
ENV PLAYWRIGHT_HEADLESS=true
ENV PLAYWRIGHT_TIMEOUT=30000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3001/health', (r) => r.statusCode === 200 ? process.exit(0) : process.exit(1))"

CMD ["node", "--import", "tsx/esm", "src/middleware/server.ts"]
