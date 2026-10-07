#!/usr/bin/env bash
set -euo pipefail

image=${1:?Usage: bash scripts/verify-container.sh IMAGE}
# Every resource belongs to this invocation; never reuse operator databases.
prefix="insurance-verify-$$-${RANDOM}"
network="${prefix}-network"
postgres="${prefix}-postgres"
web="${prefix}-web"
worker="${prefix}-worker"
cleanup() {
  result=$?
  if (( result != 0 )); then
    docker logs "$postgres" 2>/dev/null || true
    docker logs "$web" 2>/dev/null || true
    docker logs "$worker" 2>/dev/null || true
  fi
  docker rm -fv "$web" "$worker" "$postgres" >/dev/null 2>&1 || true
  docker network rm "$network" >/dev/null 2>&1 || true
  exit "$result"
}
trap cleanup EXIT

test "$(docker run --rm "$image" node --version)" = v22.18.0
docker network create "$network" >/dev/null
docker run -d --name "$postgres" --network "$network" --network-alias postgres \
  -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=insurance_test \
  postgres:17 >/dev/null
# The initialization server listens only on a socket; require the final TCP server.
for attempt in {1..60}; do
  if docker exec "$postgres" pg_isready -h 127.0.0.1 -U postgres -d insurance_test >/dev/null 2>&1; then break; fi
  sleep 1
done
docker exec "$postgres" pg_isready -h 127.0.0.1 -U postgres -d insurance_test >/dev/null

environment=(--network "$network"
  -e 'DATABASE_URL=postgresql://postgres:postgres@postgres:5432/insurance_test?schema=public&sslmode=disable&connection_limit=6'
  -e VERIFY_ISOLATED_DB=1 -e APP_ENV=staging -e SHOPIFY_API_KEY=container-dummy-key
  -e SHOPIFY_API_SECRET=container-dummy-secret -e SHOPIFY_APP_URL=http://localhost:3000
  -e SCOPES=write_products,read_orders,write_publications,write_cart_transforms -e WORKER_CONCURRENCY=1)
docker run --rm "${environment[@]}" "$image" node node_modules/prisma/build/index.js migrate deploy
docker run --rm "${environment[@]}" "$image" npm run verify:schema
docker run --rm "${environment[@]}" "$image" node scripts/verify-postgres.js
# Exercise the child-script path from outside /app in the final runtime image.
docker run --rm "${environment[@]}" -w /tmp "$image" node /app/scripts/verify-webhook-postgres.js

docker run -d --name "$web" "${environment[@]}" "$image" \
  node node_modules/@react-router/serve/dist/cli.js ./build/server/index.js >/dev/null
for attempt in {1..60}; do
  if docker exec "$web" node -e 'fetch("http://127.0.0.1:3000/healthz").then(async r => { if (!r.ok || !(await r.json()).ok) process.exit(1); }).catch(() => process.exit(1))' >/dev/null 2>&1; then break; fi
  sleep 1
done
docker exec "$web" node -e 'fetch("http://127.0.0.1:3000/healthz").then(async r => { if (!r.ok || !(await r.json()).ok) process.exit(1); }).catch(() => process.exit(1))'

docker run -d --name "$worker" "${environment[@]}" "$image" node scripts/worker.js >/dev/null
for attempt in {1..60}; do
  if docker logs "$worker" 2>&1 | grep -q '"event":"worker_started"'; then break; fi
  sleep 1
done
docker logs "$worker" 2>&1 | grep -q '"event":"worker_started"'
docker stop --time 30 "$worker" >/dev/null
test "$(docker inspect --format '{{.State.ExitCode}}' "$worker")" = 0
docker logs "$worker" 2>&1 | grep -q '"event":"worker_stopped"'
if docker logs "$worker" 2>&1 | grep -q '"level":"error"'; then
  echo 'Worker reported an error during container verification.' >&2
  exit 1
fi
printf '%s\n' 'Container verification passed: Node 22.18.0, Prisma/schema, PostgreSQL verifiers, web health, worker startup and graceful shutdown.'
