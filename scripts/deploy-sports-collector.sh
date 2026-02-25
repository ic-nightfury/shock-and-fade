#!/bin/bash
# Deploy Sports Tick Collector to Helsinki Server
# Server: 65.108.219.235

set -e

SERVER="65.108.219.235"
REMOTE_DIR="/root/poly_arbitrage"
SERVICE_NAME="polymarket-sports-collector"

echo "=== Deploying Sports Tick Collector to Helsinki ($SERVER) ==="

# Step 1: Sync code to server (excluding unnecessary files)
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
  ../../ root@$SERVER:$REMOTE_DIR/

# Step 2: Install dependencies on server
echo "Step 2: Installing dependencies..."
ssh root@$SERVER "cd $REMOTE_DIR && npm install --omit=dev"

# Step 3: Create data directories
echo "Step 3: Creating data directories..."
ssh root@$SERVER "mkdir -p $REMOTE_DIR/sports_tick_data/logs"

# Step 4: Copy systemd service file
echo "Step 4: Copying systemd service file..."
scp ./systemd/polymarket-sports-collector.service root@$SERVER:/etc/systemd/system/

# Step 5: Reload systemd and enable service
echo "Step 5: Setting up systemd service..."
ssh root@$SERVER "systemctl daemon-reload && systemctl enable $SERVICE_NAME"

# Step 6: Start service
echo "Step 6: Starting service..."
ssh root@$SERVER "systemctl restart $SERVICE_NAME"

# Step 7: Check service status
echo "Step 7: Checking service status..."
ssh root@$SERVER "systemctl status $SERVICE_NAME --no-pager"

echo ""
echo "=== Deployment Complete ==="
echo ""
echo "Useful commands:"
echo "  Check status:  ssh root@$SERVER 'systemctl status $SERVICE_NAME'"
echo "  View logs:     ssh root@$SERVER 'tail -f $REMOTE_DIR/sports_tick_data/logs/sports_collector.log'"
echo "  Stop service:  ssh root@$SERVER 'systemctl stop $SERVICE_NAME'"
echo "  Start service: ssh root@$SERVER 'systemctl start $SERVICE_NAME'"
echo "  View data:     ssh root@$SERVER 'ls -la $REMOTE_DIR/sports_tick_data/'"
echo ""
