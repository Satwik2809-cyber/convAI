#!/bin/sh

# ===========================================================================
# ConvAI MVP — Client Entrypoint
# ===========================================================================

BACKEND_URL=${BACKEND_URL:-"http://localhost:3000/api/chat"}
API_KEY=${API_KEY:-"change-me-in-production"}

echo "🔧 Injecting runtime configuration..."
echo "📍 BACKEND_URL: $BACKEND_URL"

cat <<EOF > /usr/share/nginx/html/config.js
window.APP_CONFIG = {
  BACKEND_URL: "$BACKEND_URL",
  API_KEY: "$API_KEY"
};
EOF

exec nginx -g "daemon off;"