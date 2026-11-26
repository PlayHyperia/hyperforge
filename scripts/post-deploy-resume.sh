#!/usr/bin/env bash
#
# Post-deploy script: Exit maintenance mode after successful deployment
#
# This script:
# 1. Calls the maintenance API to resume operations
# 2. Re-enables duel scheduling and betting
#
# Required environment variables:
# - SERVER_URL: Base URL of the Hyperia server (e.g., https://api.hyperia.game)
# - ADMIN_CODE: Admin API authentication code
#

set -euo pipefail

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

log_info() { echo -e "${GREEN}[INFO]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }

# Validate required environment variables
if [[ -z "${SERVER_URL:-}" ]]; then
  log_error "SERVER_URL environment variable is required"
  exit 1
fi

if [[ -z "${ADMIN_CODE:-}" ]]; then
  log_error "ADMIN_CODE environment variable is required"
  exit 1
fi

# Wait for server to be healthy after deployment
log_info "Waiting for server to be ready..."
MAX_RETRIES=30
RETRY_DELAY=10

for i in $(seq 1 $MAX_RETRIES); do
  # Try to hit a health endpoint
  HTTP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" "${SERVER_URL}/health" --max-time 10 || echo "000")

  if [[ "$HTTP_STATUS" == "200" ]]; then
    log_info "Server is healthy!"
    break
  fi

  if [[ $i -eq $MAX_RETRIES ]]; then
    log_warn "Server health check failed after ${MAX_RETRIES} attempts, attempting maintenance exit anyway"
  else
    log_info "Server not ready (status: ${HTTP_STATUS}), retrying in ${RETRY_DELAY}s... (${i}/${MAX_RETRIES})"
    sleep $RETRY_DELAY
  fi
done

log_info "Exiting maintenance mode on ${SERVER_URL}..."

# Call the maintenance API to exit maintenance mode
RESPONSE=$(curl -s -X POST \
  "${SERVER_URL}/admin/maintenance/exit" \
  -H "Content-Type: application/json" \
  -H "x-admin-code: ${ADMIN_CODE}" \
  --data '{}' \
  --max-time 30)

# Check if curl succeeded
if [[ $? -ne 0 ]]; then
  log_error "Failed to reach server at ${SERVER_URL}"
  log_warn "Server may still be in maintenance mode - manual intervention may be required"
  exit 1
fi

# Parse response
SUCCESS=$(echo "$RESPONSE" | jq -r '.success // false')
IS_ACTIVE=$(echo "$RESPONSE" | jq -r '.status.active // true')

if [[ "$SUCCESS" != "true" ]]; then
  log_error "Failed to exit maintenance mode"
  echo "$RESPONSE" | jq .
  exit 1
fi

if [[ "$IS_ACTIVE" == "false" ]]; then
  log_info "Maintenance mode exited successfully!"
  log_info "Duel scheduling and betting have resumed"
  exit 0
else
  log_warn "Unexpected: maintenance mode still active after exit request"
  echo "$RESPONSE" | jq .
  exit 1
fi
