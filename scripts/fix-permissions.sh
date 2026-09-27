#!/bin/bash
# ===========================================================================
# ConvAI MVP — Permission Fixer
# 
# Use this script on your VPS if you want to keep logs/data in the local 
# directory instead of using Docker named volumes.
# ===========================================================================

# UID/GID defined in Dockerfile
APP_UID=1001
APP_GID=1001

echo "🛡️ Fixing permissions for logs and data directories..."

# Ensure directories exist
mkdir -p logs data

# Change ownership to the app user UID
sudo chown -R $APP_UID:$APP_GID logs data

# Grant write permissions
sudo chmod -R 775 logs data

echo "✅ Permissions fixed. You can now run: docker-compose up -d"
