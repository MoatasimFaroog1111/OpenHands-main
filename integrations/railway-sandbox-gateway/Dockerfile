FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json ./
RUN npm install --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
RUN apt-get update \
    && apt-get install -y --no-install-recommends gosu \
    && rm -rf /var/lib/apt/lists/*
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY entrypoint.sh /usr/local/bin/railway-sandbox-gateway-entrypoint
RUN chmod 0755 /usr/local/bin/railway-sandbox-gateway-entrypoint
EXPOSE 8080
ENTRYPOINT ["railway-sandbox-gateway-entrypoint"]
CMD ["node", "dist/index.js"]
