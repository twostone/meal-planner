# Plain Node image instead of the HA base image: no s6/bashio needed (the app has no options),
# and Node >= 22.13 is guaranteed, which node:sqlite needs.
FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json vite.config.ts ./
COPY src ./src
COPY web ./web
# Fail the build (not the first start) if node:sqlite is missing, then drop build-only packages.
RUN node -e "require('node:sqlite')" \
    && npm run build \
    && npm prune --omit=dev

# HA ingress: port 8099, only Supervisor's proxy (172.30.32.2) may connect.
# /data is the add-on's persistent volume (included in HA backups).
ENV NODE_ENV=production \
    PORT=8099 \
    DB_PATH=/data/meal-planner.db \
    INGRESS_ONLY_IP=172.30.32.2

EXPOSE 8099
CMD ["node", "--import", "tsx", "src/server.ts"]
