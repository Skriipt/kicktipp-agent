#!/usr/bin/env bash
set -euo pipefail

# Disposable fixtures only. No host ports and no external network access.
image="kicktipp-agent:ha-smoke"
container="kicktipp-ha-smoke-$$"
config_volume="kicktipp-ha-smoke-config-$$"
data_volume="kicktipp-ha-smoke-data-$$"
fixture_dir="$(mktemp -d)"

cleanup() {
  docker rm -f "$container" >/dev/null 2>&1 || true
  docker volume rm "$config_volume" "$data_volume" >/dev/null 2>&1 || true
  rm -rf "$fixture_dir"
}
trap cleanup EXIT

chmod 755 "$fixture_dir"
node --input-type=module --eval 'import crypto from "node:crypto"; process.stdout.write(crypto.randomBytes(32).toString("hex"));' >"$fixture_dir/token"
chmod 644 "$fixture_dir/token"

KICKTIPP_PROFILE=fixture-profile KICKTIPP_AUTH_HOSTNAME=fixture-auth-identity \
KICKTIPP_AUTH_CONFIG_VOLUME="$config_volume" \
docker compose -f compose.ha.yaml config --format json | node --input-type=module --eval '
  import fs from "node:fs";
  const config = JSON.parse(fs.readFileSync(0, "utf8"));
  const service = config.services["ha-api"];
  if (
    config.name !== "kicktipp-ha"
    || Object.keys(config.services).length !== 1
    || service.hostname !== "fixture-auth-identity"
    || service.user !== "node"
    || service.environment.KICKTIPP_PROFILE !== "fixture-profile"
    || service.environment.KICKTIPP_PROFILE_LOCK !== "fixture-profile"
    || service.environment.KICKTIPP_READ_ONLY !== "1"
    || service.ports[0].host_ip !== "127.0.0.1"
    || service.ports[0].target !== 8787
    || !service.read_only
    || !config.volumes["auth-config"].external
  ) throw new Error("HA Compose isolation contract mismatch");
'

docker build --tag "$image" .
docker volume create "$config_volume" >/dev/null
docker volume create "$data_volume" >/dev/null

# Provision encrypted fake credentials under a known hostname and user.
docker run --rm --network none --hostname fixture-auth-identity \
  --env KICKTIPP_PROFILE=fixture-profile \
  --mount "type=volume,source=$config_volume,target=/config" \
  "$image" node --input-type=module --eval '
    const { saveAuth, saveCommunity } = await import("./dist/config.js");
    await saveAuth({ email: "fixture@example.invalid", password: "fixture-password" });
    saveCommunity("fixture-pool");
  '

# A different hostname must fail before a listener is opened.
if docker run --rm --network none --hostname wrong-auth-identity \
  --env KICKTIPP_PROFILE=fixture-profile \
  --env KICKTIPP_HA_TOKEN_FILE=/run/secrets/token \
  --mount "type=volume,source=$config_volume,target=/config" \
  --mount "type=bind,source=$fixture_dir/token,target=/run/secrets/token,readonly" \
  "$image" node dist/ha-server.js; then
  echo "HA accepted encrypted credentials under the wrong identity" >&2
  exit 1
fi

docker run --detach --init --network none --name "$container" \
  --hostname fixture-auth-identity --read-only --cap-drop ALL \
  --security-opt no-new-privileges:true \
  --env KICKTIPP_PROFILE=fixture-profile \
  --env KICKTIPP_READ_ONLY=1 \
  --env KICKTIPP_HA_TOKEN_FILE=/run/secrets/token \
  --mount "type=volume,source=$config_volume,target=/config" \
  --mount "type=volume,source=$data_volume,target=/data" \
  --mount "type=bind,source=$fixture_dir/token,target=/run/secrets/token,readonly" \
  "$image" node dist/ha-server.js >/dev/null

ready=false
for _ in $(seq 1 40); do
  if docker exec "$container" node --input-type=module --eval '
    import fs from "node:fs";
    const token = fs.readFileSync("/run/secrets/token", "utf8");
    const url = "http://127.0.0.1:8787/v1/health";
    if ((await fetch(url)).status !== 401) process.exit(1);
    const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!response.ok || (await response.json()).profile !== "fixture-profile") process.exit(1);
  ' >/dev/null 2>&1; then
    ready=true
    break
  fi
  sleep 0.25
done
if [ "$ready" != true ]; then
  docker logs "$container"
  exit 1
fi
test "$(docker exec "$container" id -un)" = "node"
docker stop --time 35 "$container" >/dev/null
test "$(docker inspect --format '{{.State.ExitCode}}' "$container")" = "0"
echo "HA Docker smoke test passed (isolated fixtures, no published port)"
