# Node 24 strips TypeScript natively, so there is no build step to stage.
# Debian slim over alpine: glibc avoids musl surprises, and pg/fastify are the
# only runtime dependencies, so the size difference is not worth the risk.
FROM node:24-slim

ENV NODE_ENV=production
WORKDIR /app

# Dependencies first, so a source-only change reuses this layer.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src

USER node
EXPOSE 8080
CMD ["node", "src/serve.ts"]
