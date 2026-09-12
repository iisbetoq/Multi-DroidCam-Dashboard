#!/bin/bash
set -e
git pull
npm install --omit=dev
./stop.sh || true
./start.sh
echo "Updated"
