#!/bin/bash
if command -v pm2 >/dev/null 2>&1 && pm2 list | grep -q droidcam-nvr; then
  pm2 stop droidcam-nvr
  pm2 delete droidcam-nvr
else
  if [ -f data/nvr.pid ]; then kill $(cat data/nvr.pid) 2>/dev/null; rm data/nvr.pid; echo "Stopped"; else pkill -f "node src/server.js" && echo "Stopped"; fi
fi
# kill ffmpeg recorders gracefully
pkill -TERM ffmpeg 2>/dev/null; sleep 2; pkill -KILL ffmpeg 2>/dev/null || true
echo "Stopped"
