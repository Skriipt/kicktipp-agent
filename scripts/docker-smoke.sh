#!/usr/bin/env bash
set -euo pipefail

image="kicktipp-agent:smoke"
container="kicktipp-agent-smoke-$$"
volume="kicktipp-agent-smoke-$$"
fixture_dir="$(mktemp -d)"

cleanup() {
  docker rm -f "$container" >/dev/null 2>&1 || true
  docker volume rm "$volume" >/dev/null 2>&1 || true
  rm -rf "$fixture_dir"
}
trap cleanup EXIT

mkdir "$fixture_dir/config"
chmod 755 "$fixture_dir"
chmod 777 "$fixture_dir/config"
cat >"$fixture_dir/service.json" <<'JSON'
{
  "schemaVersion": 1,
  "job": {
    "id": "11111111-1111-4111-8111-111111111111",
    "name": "docker-smoke",
    "enabled": false,
    "profileId": "smoke",
    "communityId": "smoke",
    "language": "en",
    "displayTimezone": "UTC",
    "policy": {
      "excludeParticipantIds": [],
      "stages": [{ "beforeDeadlineMinutes": 60, "severity": "urgent" }]
    },
    "targetIds": []
  },
  "targets": []
}
JSON
chmod 644 "$fixture_dir/service.json"

docker compose config --format json | node --input-type=module --eval '
  import fs from "node:fs";
  const service = JSON.parse(fs.readFileSync(0, "utf8")).services.kicktipp;
  const volumes = Object.fromEntries(service.volumes.map((volume) => [volume.target, volume]));
  if (
    service.init !== true
    || service.hostname !== "kicktipp-agent"
    || service.restart !== "unless-stopped"
    || service.stop_grace_period !== "35s"
    || service.ports !== undefined
    || JSON.stringify(service.healthcheck.test) !== JSON.stringify(["CMD", "kicktipp", "service", "health"])
    || volumes["/config"]?.read_only !== true
    || volumes["/data"]?.read_only === true
  ) throw new Error("Compose Service contract mismatch");
'
docker build --tag "$image" .
docker volume create "$volume" >/dev/null

docker run --rm \
  --user node \
  --hostname kicktipp-agent-smoke \
  --network none \
  --mount "type=bind,source=$PWD/scripts,target=/smoke,readonly" \
  --mount "type=bind,source=$fixture_dir,target=/setup,readonly" \
  --mount "type=bind,source=$fixture_dir/config,target=/config" \
  --mount "type=volume,source=$volume,target=/data" \
  --entrypoint node \
  "$image" \
  --input-type=module --eval '
    import fs from "node:fs";
    const { setupService } = await import("./dist/service/store.js");
    setupService(JSON.parse(fs.readFileSync("/setup/service.json", "utf8")));
    const { seedAuth } = await import("/smoke/auth-smoke.mjs");
    await seedAuth();
  '

start_container() {
  docker run --detach \
    --init \
    --name "$container" \
    --hostname "${1:-kicktipp-agent-smoke}" \
    --network none \
    --mount "type=bind,source=$PWD/scripts,target=/smoke,readonly" \
    --mount "type=bind,source=$fixture_dir/config,target=/config,readonly" \
    --mount "type=volume,source=$volume,target=/data" \
    "$image" kicktipp serve --log-format json >/dev/null

  for _ in $(seq 1 40); do
    if docker exec "$container" kicktipp service health >/dev/null 2>&1; then
      return
    fi
    sleep 0.25
  done
  docker logs "$container"
  return 1
}

state_hash() {
  docker run --rm \
    --mount "type=volume,source=$volume,target=/data,readonly" \
    --entrypoint sha256sum "$image" /data/service-state.json | awk '{print $1}'
}

start_container
test "$(docker exec "$container" id -u)" != "0"
if docker exec "$container" node -e 'require("node:fs").writeFileSync("/config/write-test", "no")' 2>/dev/null; then
  echo "/config unexpectedly accepted a write" >&2
  exit 1
fi
docker exec "$container" node --input-type=module --eval '
  const { runAuthSmoke } = await import("/smoke/auth-smoke.mjs");
  await runAuthSmoke("refresh");
'
before="$(state_hash)"

started="$(date +%s)"
docker stop --time 35 "$container" >/dev/null
elapsed="$(( $(date +%s) - started ))"
test "$elapsed" -le 35
test "$(docker inspect --format '{{.State.ExitCode}}' "$container")" = "0"
docker rm "$container" >/dev/null

start_container
test "$(state_hash)" = "$before"
docker exec "$container" node --input-type=module --eval '
  const { runAuthSmoke } = await import("/smoke/auth-smoke.mjs");
  await runAuthSmoke("restore");
'
docker stop --time 35 "$container" >/dev/null
test "$(docker inspect --format '{{.State.ExitCode}}' "$container")" = "0"

# A hard-killed container leaves metadata with a PID that can exist again in
# the next PID namespace. Recovery must follow the kernel lock, not that PID.
docker rm "$container" >/dev/null
start_container
docker kill --signal KILL "$container" >/dev/null
test "$(docker inspect --format '{{.State.ExitCode}}' "$container")" = "137"
docker rm "$container" >/dev/null
start_container kicktipp-agent-smoke-recreated
test "$(state_hash)" = "$before"
docker stop --time 35 "$container" >/dev/null
test "$(docker inspect --format '{{.State.ExitCode}}' "$container")" = "0"

echo "Docker smoke test passed (including SIGKILL and changed hostname)"
