FROM node:22-alpine AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:22-alpine AS build
WORKDIR /app
COPY --from=dependencies /app/node_modules ./node_modules
COPY . .
ARG NEXT_PUBLIC_APP_URL
ARG NEXT_PUBLIC_BRAND_NAME
ARG NEXT_PUBLIC_SUPABASE_URL
ARG NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
ENV NEXT_TELEMETRY_DISABLED=1 \
    NEXT_PUBLIC_APP_URL=$NEXT_PUBLIC_APP_URL \
    NEXT_PUBLIC_BRAND_NAME=$NEXT_PUBLIC_BRAND_NAME \
    NEXT_PUBLIC_SUPABASE_URL=$NEXT_PUBLIC_SUPABASE_URL \
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=$NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
RUN npm run build
RUN npm prune --omit=dev

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1
RUN addgroup -S automata && adduser -S automata -G automata
COPY --from=build --chown=automata:automata /app/package.json /app/package-lock.json ./
COPY --from=build --chown=automata:automata /app/node_modules ./node_modules
COPY --from=build --chown=automata:automata /app/.next ./.next
COPY --from=build --chown=automata:automata /app/public ./public
COPY --from=build --chown=automata:automata /app/src ./src
COPY --from=build --chown=automata:automata /app/scripts ./scripts
COPY --from=build --chown=automata:automata /app/next.config.ts /app/tsconfig.json ./
USER automata
EXPOSE 3000
CMD ["npm", "start"]
