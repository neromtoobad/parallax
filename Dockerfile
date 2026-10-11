FROM node:24-slim
WORKDIR /app

COPY server/package.json server/package-lock.json server/
RUN cd server && npm ci --omit=dev
COPY web/package.json web/package-lock.json web/
RUN cd web && npm ci

COPY server server
COPY web web
RUN cd web && npm run build

COPY start.sh .
ENV NODE_ENV=production PARALLAX_DATA=/data API_PORT=8787 PARALLAX_API_URL=http://127.0.0.1:8787
CMD ["sh", "start.sh"]
