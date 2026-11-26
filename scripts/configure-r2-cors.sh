#!/bin/bash
# Configure CORS for Hyperia R2 asset buckets
#
# Prerequisites:
#   - Wrangler CLI installed: npm install -g wrangler
#   - Logged in to Cloudflare: wrangler login
#
# Usage:
#   ./scripts/configure-r2-cors.sh [production|staging]

set -e

ENV="${1:-production}"

if [ "$ENV" = "production" ]; then
  BUCKET="hyperia-assets"
elif [ "$ENV" = "staging" ]; then
  BUCKET="hyperia-assets-staging"
else
  echo "Usage: $0 [production|staging]"
  exit 1
fi

echo "Configuring CORS for R2 bucket: $BUCKET"

# Create CORS configuration JSON (wrangler R2 API format)
CORS_CONFIG=$(cat <<'EOF'
{
  "rules": [
    {
      "allowed": {
        "origins": [
          "https://hyperia.gg",
          "https://www.hyperia.gg",
          "https://hyperbet.win",
          "https://www.hyperbet.win",
          "https://hyperia.bet",
          "https://www.hyperia.bet",
          "https://hyperia-production.up.railway.app",
          "https://*.hyperia.pages.dev",
          "https://*.hyperia-betting.pages.dev",
          "https://*.hyperbet.pages.dev",
          "https://*.hyperbet-solana.pages.dev",
          "http://localhost:3333",
          "http://localhost:5555",
          "http://127.0.0.1:3333",
          "http://127.0.0.1:5555"
        ],
        "methods": ["GET", "HEAD"],
        "headers": ["*"]
      },
      "exposed": ["Content-Length", "Content-Type", "ETag"],
      "maxAge": 86400
    }
  ]
}
EOF
)

# Write to temp file (wrangler requires a file)
TEMP_FILE=$(mktemp)
echo "$CORS_CONFIG" > "$TEMP_FILE"

# Apply CORS configuration
echo "Applying CORS configuration..."
wrangler r2 bucket cors set "$BUCKET" --file "$TEMP_FILE"

# Clean up
rm "$TEMP_FILE"

echo "CORS configured successfully for $BUCKET"
echo ""
echo "Allowed origins:"
echo "  - https://hyperia.gg"
echo "  - https://www.hyperia.gg"
echo "  - https://hyperbet.win"
echo "  - https://www.hyperbet.win"
echo "  - https://hyperia.bet"
echo "  - https://www.hyperia.bet"
echo "  - https://hyperia-production.up.railway.app"
echo "  - https://*.hyperia.pages.dev"
echo "  - https://*.hyperia-betting.pages.dev"
echo "  - https://*.hyperbet.pages.dev"
echo "  - https://*.hyperbet-solana.pages.dev"
echo "  - http://localhost:*"
