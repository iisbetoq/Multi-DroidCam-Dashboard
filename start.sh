#!/bin/bash
DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"
export PORT=8080
export HOST=0.0.0.0
export DB_PATH=./data/nvr.db
if command -v pm2 >/dev/null 2>&1; then
  pm2 start src/server.js --name droidcam-nvr --update-env
  pm2 save
else
  nohup node src/server.js > data/nvr.log 2>&1 &
  echo $! > data/nvr.pid
  echo "Started pid $(cat data/nvr.pid) - log data/nvr.log"
fi
echo "Dashboard: http://$(hostname -I | awk '{print $1}'):8080"
