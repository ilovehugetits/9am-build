FROM oven/bun:1-debian

RUN apt-get update && apt-get install -y --no-install-recommends \
    git ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install

# Install Playwright's Chromium + OS dependencies.
RUN bunx playwright install --with-deps chromium

COPY . .

RUN chmod +x docker-entrypoint.sh

# The container runs as root, so the Chromium sandbox must be disabled here
# (the app keeps it enabled everywhere CHROMIUM_NO_SANDBOX is unset).
ENV CHROMIUM_NO_SANDBOX=1

EXPOSE 9000

ENTRYPOINT ["/app/docker-entrypoint.sh"]
CMD ["bun", "run", "server"]
