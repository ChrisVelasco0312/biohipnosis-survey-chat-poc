# Biohipnosis POC · API para Cloud Run
FROM node:24-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:24-slim
ENV NODE_ENV=production \
    PORT=8080 \
    POC_PORT=8080 \
    POC_HOST=0.0.0.0 \
    POC_STORE=cloud
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json ./
COPY server ./server
COPY prompts ./prompts
COPY public ./public
RUN useradd --system --uid 1001 --create-home app \
    && chown -R app:app /app
USER app
EXPOSE 8080
CMD ["node", "server/index.js"]
