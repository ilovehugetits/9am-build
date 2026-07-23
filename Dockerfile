FROM oven/bun:1-debian

# Node is required for the Playwright browser runner (Bun cannot drive
# Playwright's pipe transport). Install Node 22 alongside Bun.
RUN apt-get update && apt-get install -y --no-install-recommends \
    git ca-certificates curl gnupg \
    && mkdir -p /etc/apt/keyrings \
    && curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg \
    && echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main" > /etc/apt/sources.list.d/nodesource.list \
    && apt-get update && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install

# Install Playwright's Chromium + OS dependencies (used by the Node runner).
RUN bunx playwright install --with-deps chromium

COPY . .

RUN chmod +x docker-entrypoint.sh

# The container runs as root, so the Chromium sandbox must be disabled here
# (the app keeps it enabled everywhere CHROMIUM_NO_SANDBOX is unset).
ENV CHROMIUM_NO_SANDBOX=1

EXPOSE 9000

ENTRYPOINT ["/app/docker-entrypoint.sh"]
CMD ["bun", "run", "server"]
