#!/bin/bash
# Deploy Sports Split-Sell Strategy to Finland Server (US-400)
# Server: 65.21.146.43 (Finland - Live Trading)
#
# Usage:
#   ./deploy-sports-sss.sh [--start]
#
# Options:
#   --start    Start the service after deployment
#
# IMPORTANT: This deploys to LIVE TRADING server. Use with caution!

set -e

SERVER="65.21.146.43"
REMOTE_DIR="/root/poly_arbitrage"
SERVICE_NAME="polymarket-sports-sss"
LOCAL_DIR="$(dirname "$0")/../.."

# Parse arguments
START_SERVICE=false
for arg in "$@"; do
  case $arg in
    --start)
      START_SERVICE=true
      shift
      ;;
  esac
done

echo "=================================================================="
echo "   DEPLOYING SPORTS SPLIT-SELL STRATEGY TO FINLAND SERVER"
echo "   Server: $SERVER"
echo "   Service: $SERVICE_NAME"
echo "=================================================================="
echo ""
echo "⚠️  WARNING: This is a LIVE TRADING server!"
echo "    Real money will be at risk once the service is started."
echo ""
read -p "Continue with deployment? (y/N) " -n 1 -r
echo
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    echo "Deployment cancelled."
    exit 1
fi

cd "$LOCAL_DIR"

# Step 1: Sync code to server (excluding unnecessary files)
echo ""
echo "Step 1: Syncing code to server..."
rsync -avz --progress \
  --exclude 'node_modules' \
  --exclude '.git' \
  --exclude '*.log' \
  --exclude '.env' \
  --exclude '.env.*' \
  --exclude 'tick_data*' \
  --exclude 'sports_tick_data' \
  --exclude 'dist' \
  --exclude '*.jsonl' \
  --exclude 'sss_positions.json' \
  --exclude 'sss_paper_*.json' \
  ./ root@$SERVER:$REMOTE_DIR/

# Step 2: Install dependencies on server
echo ""
echo "Step 2: Installing dependencies..."
ssh root@$SERVER "cd $REMOTE_DIR && npm install --omit=dev"

# Step 3: Create log directory
echo ""
echo "Step 3: Creating log directory..."
ssh root@$SERVER "mkdir -p $REMOTE_DIR/logs"

# Step 4: Copy systemd service file
echo ""
echo "Step 4: Copying systemd service file..."
scp ./scripts/systemd/polymarket-sports-sss.service root@$SERVER:/etc/systemd/system/

# Step 5: Reload systemd and enable service
echo ""
echo "Step 5: Setting up systemd service..."
ssh root@$SERVER "systemctl daemon-reload && systemctl enable $SERVICE_NAME"

# Step 6: Verify .env file exists
echo ""
echo "Step 6: Verifying environment file..."
ENV_EXISTS=$(ssh root@$SERVER "test -f $REMOTE_DIR/.env && echo 'yes' || echo 'no'")
if [ "$ENV_EXISTS" = "no" ]; then
    echo "⚠️  WARNING: .env file not found on server!"
    echo "   Please copy the .env file manually:"
    echo "   scp .env root@$SERVER:$REMOTE_DIR/.env"
    echo ""
    echo "   Required variables:"
    echo "   - POLYMARKET_PRIVATE_KEY"
    echo "   - POLYMARKET_FUNDER"
    echo ""
    START_SERVICE=false
else
    echo "✅ .env file found"
fi

# Step 7: Start service (if requested)
if [ "$START_SERVICE" = true ]; then
    echo ""
    echo "Step 7: Starting service..."
    echo "⚠️  WARNING: Starting LIVE TRADING service!"
    read -p "Confirm start? (y/N) " -n 1 -r
    echo
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        ssh root@$SERVER "systemctl restart $SERVICE_NAME"
        echo "Service started."
    else
        echo "Service NOT started."
    fi
else
    echo ""
    echo "Step 7: Skipping service start (use --start flag to auto-start)"
fi

# Step 8: Check service status
echo ""
echo "Step 8: Checking service status..."
ssh root@$SERVER "systemctl status $SERVICE_NAME --no-pager || true"

echo ""
echo "=================================================================="
echo "   DEPLOYMENT COMPLETE"
echo "=================================================================="
echo ""
echo "Useful commands:"
echo "  Check status:  ssh root@$SERVER 'systemctl status $SERVICE_NAME'"
echo "  View logs:     ssh root@$SERVER 'tail -f $REMOTE_DIR/logs/sss_live.log'"
echo "  Stop service:  ssh root@$SERVER 'systemctl stop $SERVICE_NAME'"
echo "  Start service: ssh root@$SERVER 'systemctl start $SERVICE_NAME'"
echo "  Dashboard:     http://$SERVER:3030 (if dashboard enabled)"
echo ""
echo "⚠️  IMPORTANT: Before starting live trading:"
echo "  1. Ensure .env has valid POLYMARKET_PRIVATE_KEY and POLYMARKET_FUNDER"
echo "  2. Start with small bet size (--bet-size 1 or 5)"
echo "  3. Run paper trading for 20+ games first"
echo ""
