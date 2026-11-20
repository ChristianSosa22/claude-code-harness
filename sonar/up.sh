#!/usr/bin/env bash
# Starts the local SonarQube server. If the container exists, it starts it; if not, it creates it from the config.
# Then it waits until api/system/status is UP. It never removes a container or a volume.
# Usage: sonar/up.sh
set -euo pipefail

# shellcheck source=lib.sh
source "$(cd "$(dirname "$0")" && pwd)/lib.sh"
require_tools jq curl docker

container="$(cfg '.server.container')"
image="$(cfg '.server.image')"
bind="$(cfg '.server.bind')"
port="$(sonar_port)"

if docker ps -a --format '{{.Names}}' | grep -qx "$container"; then
  if docker ps --format '{{.Names}}' | grep -qx "$container"; then
    echo "Container $container already running"
  else
    echo "Starting existing container $container"
    docker start "$container" > /dev/null
  fi
else
  echo "Creating container $container from $image"
  volume_args=()
  while IFS= read -r volume; do
    volume_args+=(-v "$volume")
  done < <(cfg '.server.volumes[]')
  docker run -d --name "$container" \
    -p "$bind:$port:9000" \
    -e SONAR_ES_BOOTSTRAP_CHECKS_DISABLE=true \
    "${volume_args[@]}" \
    "$image" > /dev/null
fi

wait_for_sonar
echo "SonarQube UP, version $(curl -sS "$(sonar_host_url)/api/server/version")"
echo "URL: $(sonar_host_url)"
