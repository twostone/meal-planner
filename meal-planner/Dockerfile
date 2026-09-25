# Two stages. The frontend is built once on the builder's own architecture (BUILDPLATFORM): the result is static
# files, identical for every target, and building it under QEMU emulation for arm64 would only be slow.
# The runtime stage is built per target architecture. Plain Node image instead of the HA base image: no
# s6/bashio needed (the app has no options), and Node >= 22.13 is guaranteed, which node:sqlite needs.

FROM --platform=$BUILDPLATFORM node:22-alpine AS web
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY vite.config.ts ./
COPY web ./web
RUN npm run build

FROM node:22-alpine
WORKDIR /app

COPY package.json package-lock.json ./
# Fail the build (not the first start) if node:sqlite is missing. Only runtime dependencies are installed.
RUN node -e "require('node:sqlite')" \
    && npm ci --omit=dev

COPY src ./src
COPY --from=web /app/dist ./dist

# HA ingress: port 8099, only Supervisor's proxy (172.30.32.2) may connect.
# /data is the add-on's persistent volume (included in HA backups).
ENV NODE_ENV=production \
    PORT=8099 \
    DB_PATH=/data/meal-planner.db \
    INGRESS_ONLY_IP=172.30.32.2

EXPOSE 8099
CMD ["node", "--import", "tsx", "src/server.ts"]
