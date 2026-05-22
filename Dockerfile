# Tahap 1: Pembangunan (Build)
FROM node:20-slim AS builder
WORKDIR /app

# Salin package.json dan bun.lock untuk instalasi dependensi
COPY package.json bun.lock* ./

# Pasang Bun secara global dan install dependencies
RUN npm install -g bun && bun install --frozen-lockfile

# Salin source code dan jalankan build (webpack — stabil di Cloud Build vs turbopack)
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN bun run build

# Tahap 2: Runtime Server
FROM node:20-slim AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=8080
ENV HOSTNAME="0.0.0.0"

# 1. Install System Dependencies: FFmpeg & Python3 (untuk yt-dlp)
RUN apt-get update && apt-get install -y \
    ffmpeg \
    python3 \
    curl \
    && rm -rf /var/lib/apt/lists/*

# 2. Unduh dan install yt-dlp versi terbaru secara global
RUN curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp \
    && chmod a+rx /usr/local/bin/yt-dlp

# 3. Salin hasil build Next.js Standalone
COPY --from=builder /app/public ./public
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static

# Buka port 8080 (port default Cloud Run)
EXPOSE 8080

# Jalankan Next.js server menggunakan standalone build
CMD ["node", "server.js"]
