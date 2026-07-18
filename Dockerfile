FROM oven/bun:1-debian

RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    git \
    ca-certificates \
    fonts-liberation \
    fonts-noto-color-emoji \
    && rm -rf /var/lib/apt/lists/*

# Use the distro Chromium instead of Puppeteer's bundled download
ENV PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

WORKDIR /app

COPY package.json ./
RUN bun install

COPY . .

RUN chmod +x docker-entrypoint.sh

EXPOSE 9000

ENTRYPOINT ["/app/docker-entrypoint.sh"]
CMD ["bun", "run", "server"]
