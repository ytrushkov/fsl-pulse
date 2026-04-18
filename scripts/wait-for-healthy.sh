#!/usr/bin/env bash
# wait-for-healthy.sh — poll docker compose service health; exit 1 after timeout
# Usage: ./scripts/wait-for-healthy.sh service1 service2 ...
set -euo pipefail

TIMEOUT=90
INTERVAL=3
services=("$@")

if [[ ${#services[@]} -eq 0 ]]; then
  echo "Usage: $0 <service> [service...]" >&2
  exit 1
fi

deadline=$(( SECONDS + TIMEOUT ))

echo "Waiting for services to be healthy: ${services[*]}"

while true; do
  all_healthy=true
  for svc in "${services[@]}"; do
    status=$(docker compose ps --format json "$svc" 2>/dev/null \
      | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('Health','unknown'))" \
      2>/dev/null || echo "unknown")
    if [[ "$status" != "healthy" ]]; then
      all_healthy=false
      echo "  $svc: $status"
    fi
  done

  if $all_healthy; then
    echo "All services healthy."
    exit 0
  fi

  if (( SECONDS >= deadline )); then
    echo "ERROR: Timed out after ${TIMEOUT}s waiting for: ${services[*]}" >&2
    docker compose ps >&2
    exit 1
  fi

  sleep "$INTERVAL"
done
