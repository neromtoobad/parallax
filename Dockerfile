# One container: the server (Node 24 runs its TypeScript directly) serves the API and the built site.
FROM node:24-slim AS web
WORKDIR /app/web
COPY web/package*.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

FROM node:24-slim
ENV NODE_ENV=production
WORKDIR /app
COPY server/package*.json server/
RUN cd server && npm ci --omit=dev
COPY server/ server/
COPY deployments/ deployments/
COPY --from=web /app/web/dist web/dist
WORKDIR /app/server
CMD ["node", "src/index.ts"]
