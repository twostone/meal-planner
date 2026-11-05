#!/usr/bin/env bash
# Smoke test of the app image, called by the shared CI (twostone/hassio-workflows app-ci.yml).
# Usage: scripts/smoke.sh <image>
set -euo pipefail
IMAGE="${1:?usage: $0 <image>}"

dump() { echo "--- container log ($1)"; docker logs "$1" || true; }

# 1) Ingress guard switched off: frontend and API are served and SQLite works inside the image.
docker run -d --name smoke -p 8099:8099 -e INGRESS_ONLY_IP= "$IMAGE"
for _ in $(seq 1 30); do
  curl -fsS http://localhost:8099/api/plans >/dev/null 2>&1 && break
  sleep 1
done
curl -fsS http://localhost:8099/api/plans | grep -q '^\[\]$' || { dump smoke; exit 1; }
curl -fsS http://localhost:8099/ | grep -q '<title>Essensplanung</title>' || { dump smoke; exit 1; }
curl -fsS -X POST http://localhost:8099/api/plans -H 'Content-Type: application/json' \
  -d '{"start_date":"2026-10-03","end_date":"2026-10-09"}' | grep -q '"id":1' || { dump smoke; exit 1; }
docker rm -f smoke

# 2) Default configuration: only Supervisor's ingress address may connect, everyone else gets 403.
docker run -d --name guarded -p 8100:8099 "$IMAGE"
code=000
for _ in $(seq 1 30); do
  code=$(curl -s -o /dev/null -w '%{http_code}' http://localhost:8100/api/plans || true)
  [ "$code" != "000" ] && break
  sleep 1
done
[ "$code" = "403" ] || { echo "expected 403 from the ingress guard, got $code"; dump guarded; exit 1; }
docker rm -f guarded

# 3) HA state port: 401 without the token, 404 for anything else, the token file exists and works.
docker run -d --name hastate -p 8098:8100 -e INGRESS_ONLY_IP= "$IMAGE"
code=000
for _ in $(seq 1 30); do
  code=$(curl -s -o /dev/null -w '%{http_code}' http://localhost:8098/ha/state || true)
  [ "$code" != "000" ] && break
  sleep 1
done
[ "$code" = "401" ] || { echo "expected 401 without token, got $code"; dump hastate; exit 1; }
[ "$(curl -s -o /dev/null -w '%{http_code}' http://localhost:8098/api/plans)" = "404" ] || { dump hastate; exit 1; }
token=$(docker exec hastate cat /data/ha-token)
curl -fsS -H "Authorization: Bearer $token" http://localhost:8098/ha/state | grep -q '"current":null' || { dump hastate; exit 1; }
docker rm -f hastate

# Shutdown: SIGTERM (what `ha apps stop` sends) must end the app cleanly with exit code 0 within the Supervisor's
# 10 s timeout. Otherwise the Supervisor shows the app as "error" instead of "stopped".
docker run -d --name stopping -p 8099:8099 -e INGRESS_ONLY_IP= "$IMAGE"
for _ in $(seq 1 30); do
  curl -fsS http://localhost:8099/api/plans >/dev/null 2>&1 && break
  sleep 1
done
start=$(date +%s)
docker stop -t 10 stopping >/dev/null
elapsed=$(( $(date +%s) - start ))
exit_code=$(docker inspect -f '{{.State.ExitCode}}' stopping)
[ "$exit_code" = "0" ] || { echo "expected exit code 0 after SIGTERM, got $exit_code"; dump stopping; exit 1; }
[ "$elapsed" -lt 9 ] || { echo "stop took ${elapsed}s (limit 10 s)"; dump stopping; exit 1; }
docker rm -f stopping
