#!/bin/bash
set -e
echo "=== DroidCam NVR Installer (Armbian ARM64) ==="
if ! command -v node >/dev/null 2>&1; then
  echo "Installing Node.js 20..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi
if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "Installing FFmpeg..."
  sudo apt-get update && sudo apt-get install -y ffmpeg
fi
echo "Installing deps..."
npm install --omit=dev
mkdir -p data recordings
echo "Setting permissions..."
chmod +x start.sh stop.sh update.sh
echo "Installing systemd service..."
sudo cp droidcam-nvr.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable droidcam-nvr.service
echo "Done. Start with: sudo systemctl start droidcam-nvr  or ./start.sh"
echo "Dashboard: http://$(hostname -I | awk '{print $1}'):8080"
