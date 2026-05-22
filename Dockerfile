# Tahap 1: Pembangunan (Build)
FROM node:22-slim AS builder
WORKDIR /app

# Salin package.json dan bun.lock untuk instalasi dependensi
COPY package.json bun.lock* ./

# Pasang Bun secara global dan install dependencies
RUN npm install -g bun && bun install

# Salin source code dan jalankan build
COPY . .
RUN bun run build

# Tahap 2: Runtime Server
FROM node:22-slim AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=8080
ENV HOSTNAME="0.0.0.0"

# 1. Install System Dependencies: FFmpeg (and tools for yt-dlp)
RUN apt-get update && apt-get install -y \
    ffmpeg \
    curl \
    wget \
    && rm -rf /var/lib/apt/lists/*

# 2. Install yt-dlp via pip
RUN curl -L -o /usr/local/bin/yt-dlp https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp && chmod +x /usr/local/bin/yt-dlp

# 3. Salin hasil build Next.js Standalone

# 3. Salin hasil build Next.js Standalone
COPY --from=builder /app/public ./public
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static

# Buka port 8080 (port default Cloud Run)
EXPOSE 8080

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD curl -f http://localhost:8080/ || exit 1

# Jalankan Next.js server menggunakan standalone build
CMD ["node", "server.js"]
