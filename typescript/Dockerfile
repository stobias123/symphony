# syntax=docker/dockerfile:1.7

FROM node:22-bookworm-slim AS build

WORKDIR /app/typescript

RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential ca-certificates python3 \
    && rm -rf /var/lib/apt/lists/*

COPY typescript/package.json typescript/package-lock.json ./
COPY typescript/web/package.json typescript/web/package-lock.json ./web/

RUN npm ci \
    && npm --prefix web ci

COPY typescript/tsconfig.json ./
COPY typescript/src ./src
COPY typescript/web ./web

RUN npx tsc \
    && chmod +x dist/index.js \
    && npm --prefix web run build \
    && npm prune --omit=dev

FROM debian:bookworm-slim

ARG NODE_MAJOR=22
ARG CODEX_CLI_VERSION=0.114.0

ENV HOME=/home/symphony \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8 \
    PATH=/opt/symphony/bin:/usr/local/bin:${PATH}

RUN groupadd -g 1000 symphony \
    && useradd -u 1000 -g symphony -d /home/symphony -s /bin/bash symphony

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       bash ca-certificates curl git gnupg openssh-client \
    && mkdir -p /etc/apt/keyrings \
    && curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
       | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg \
    && echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_${NODE_MAJOR}.x nodistro main" \
       > /etc/apt/sources.list.d/nodesource.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends nodejs \
    && npm install -g "@openai/codex@${CODEX_CLI_VERSION}" \
    && npx playwright install --with-deps chromium \
    && rm -rf /var/lib/apt/lists/*

RUN mkdir -p /home/symphony /opt/symphony/bin /opt/symphony/dist /data /etc/symphony \
    && chown -R 1000:1000 /home/symphony /opt/symphony /data /etc/symphony

COPY --from=build --chown=1000:1000 /app/typescript/node_modules /opt/symphony/node_modules
COPY --from=build --chown=1000:1000 /app/typescript/package.json /opt/symphony/package.json
COPY --from=build --chown=1000:1000 /app/typescript/dist /opt/symphony/dist

RUN cat <<'EOF' >/opt/symphony/bin/container-entrypoint.sh
#!/usr/bin/env bash
set -euo pipefail

: "${HOME:=/home/symphony}"
: "${SYMPHONY_WORKFLOW_PATH:=/etc/symphony/WORKFLOW.md}"
: "${SYMPHONY_LOGS_ROOT:=/data/logs}"
: "${SYMPHONY_WORKSPACE_ROOT:=/data/workspaces}"

SSH_SOURCE_DIR="/var/run/symphony-ssh"
SSH_DEST_DIR="${HOME}/.ssh"

if [[ ! -f "${SYMPHONY_WORKFLOW_PATH}" ]]; then
  echo "Workflow file not found at ${SYMPHONY_WORKFLOW_PATH}" >&2
  exit 1
fi

if [[ -z "${OPENAI_API_KEY:-}" ]]; then
  echo "OPENAI_API_KEY is required" >&2
  exit 1
fi

if [[ ! -f "${SSH_SOURCE_DIR}/id_ed25519" ]]; then
  echo "SSH private key not found at ${SSH_SOURCE_DIR}/id_ed25519" >&2
  exit 1
fi

mkdir -p "${HOME}/.codex" "${SSH_DEST_DIR}" "${SYMPHONY_LOGS_ROOT}" "${SYMPHONY_WORKSPACE_ROOT}"
chmod 700 "${SSH_DEST_DIR}"

cp "${SSH_SOURCE_DIR}/id_ed25519" "${SSH_DEST_DIR}/id_ed25519"
chmod 600 "${SSH_DEST_DIR}/id_ed25519"

touch "${SSH_DEST_DIR}/known_hosts"
chmod 600 "${SSH_DEST_DIR}/known_hosts"

strict_host_key_checking="accept-new"
if [[ -f "${SSH_SOURCE_DIR}/known_hosts" ]]; then
  cp "${SSH_SOURCE_DIR}/known_hosts" "${SSH_DEST_DIR}/known_hosts"
  chmod 600 "${SSH_DEST_DIR}/known_hosts"
  strict_host_key_checking="yes"
fi

cat > "${SSH_DEST_DIR}/config" <<CONFIG
Host *
  IdentityFile ${SSH_DEST_DIR}/id_ed25519
  IdentitiesOnly yes
  StrictHostKeyChecking ${strict_host_key_checking}
  UserKnownHostsFile ${SSH_DEST_DIR}/known_hosts
CONFIG
chmod 600 "${SSH_DEST_DIR}/config"

printf '%s' "${OPENAI_API_KEY}" | codex login --with-api-key >/dev/null

exec env -u OPENAI_API_KEY node /opt/symphony/dist/index.js \
  --logs-root "${SYMPHONY_LOGS_ROOT}" \
  "${SYMPHONY_WORKFLOW_PATH}"
EOF

RUN chmod +x /opt/symphony/bin/container-entrypoint.sh

USER symphony
WORKDIR /home/symphony

ENTRYPOINT ["/opt/symphony/bin/container-entrypoint.sh"]
