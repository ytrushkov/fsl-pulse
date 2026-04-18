#!/usr/bin/env bash
# generate-openapi.sh — export OpenAPI schema from running API
set -euo pipefail

API_URL=${API_URL:-http://localhost:8000}
OUT=${1:-openapi.json}

echo "Fetching OpenAPI schema from $API_URL/openapi.json..."
curl -sf "$API_URL/openapi.json" -o "$OUT"
echo "Written to $OUT"
