#!/bin/bash

echo "=== Environment Variables ==="
env | grep -E "(GEMINI|YOUTUBE|NODE|PORT)" || echo "No relevant env vars found"

echo -e "\n=== Node.js Version ==="
node --version

echo -e "\n=== yt-dlp Version ==="
yt-dlp --version

echo -e "\n=== FFmpeg Version ==="
ffmpeg -version | head -n 1

echo -e "\n=== Connectivity Test ==="
curl -I https://www.youtube.com/watch?v=CeOXx-XTYek --connect-timeout 10 || echo "Failed to connect to YouTube"

echo -e "\n=== Python Version ==="
python3 --version

echo -e "\n=== Pip List ==="
python3 -m pip list | grep -E "(yt-dlp|requests)"