FROM node:22-bookworm-slim AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY --from=dependencies /app/node_modules ./node_modules
COPY . .
ARG NEXT_PUBLIC_APP_URL
ARG NEXT_PUBLIC_BRAND_NAME
ARG NEXT_PUBLIC_SUPABASE_URL
ARG NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
# The 2 GB droplet builds this image in place; Node's default heap is too small for it.
ENV NODE_OPTIONS=--max-old-space-size=3072 \
    NEXT_TELEMETRY_DISABLED=1 \
    NEXT_PUBLIC_APP_URL=$NEXT_PUBLIC_APP_URL \
    NEXT_PUBLIC_BRAND_NAME=$NEXT_PUBLIC_BRAND_NAME \
    NEXT_PUBLIC_SUPABASE_URL=$NEXT_PUBLIC_SUPABASE_URL \
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=$NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
RUN npm run build
RUN npm prune --omit=dev

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN groupadd --system automata && useradd --system --gid automata --create-home automata
COPY --from=build --chown=automata:automata /app/package.json /app/package-lock.json ./
COPY --from=build --chown=automata:automata /app/node_modules ./node_modules
COPY --from=build --chown=automata:automata /app/.next ./.next
COPY --from=build --chown=automata:automata /app/public ./public
COPY --from=build --chown=automata:automata /app/src ./src
COPY --from=build --chown=automata:automata /app/scripts ./scripts
COPY --from=build --chown=automata:automata /app/next.config.ts /app/tsconfig.json ./
# Workflow video jobs use ffmpeg for assembly/narration and Chromium for
# product capture, captions, and branded end cards. Keep both available to the
# same non-root user running the app and the background worker.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
    && npx playwright install --with-deps chromium \
    && chmod -R a+rX /ms-playwright \
    && rm -rf /var/lib/apt/lists/*
USER automata
EXPOSE 3000
CMD ["npm", "start"]
