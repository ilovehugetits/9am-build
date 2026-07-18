#!/bin/sh
set -e

# The container has no SSH keys; clone git@github.com URLs over HTTPS with the token
if [ -n "$GITHUB_TOKEN" ]; then
  git config --global url."https://x-access-token:${GITHUB_TOKEN}@github.com/".insteadOf "git@github.com:"
fi
git config --global --add safe.directory '*'

# Credentials live on a mounted volume so logins/signCount survive redeploys.
# The app reads/writes these at the project root, so link them into place.
if [ -d /data ]; then
  ln -sf /data/passkey-credential.json /app/passkey-credential.json
  ln -sf /data/auth-state.json /app/auth-state.json
  mkdir -p /data/repos
  rm -rf /app/repos
  ln -sfn /data/repos /app/repos
fi

exec "$@"
