# ---- build ----
FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json ./
COPY src ./src
RUN npx tsc && npm prune --omit=dev --ignore-scripts

# ---- run ----
FROM node:24-slim
ENV NODE_ENV=production PORT=4021 DB_PATH=/data/payments.db TRUST_PROXY=fly
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 4021
CMD ["node", "dist/server.js"]
