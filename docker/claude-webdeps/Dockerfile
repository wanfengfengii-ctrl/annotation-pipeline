FROM node:22.22.1-bookworm-slim@sha256:4f77a690f2f8946ab16fe1e791a3ac0667ae1c3575c3e4d0d4589e9ed5bfaf3d AS node_runtime
FROM adminfather/benzhi-claude-code@sha256:f77014d9e56cd3db2ac96627a286814cb1aa9f0b4bb807bea98a01383c9bc4d8

# User-authorized CLI upgrade. Retain the original entrypoint, clean home,
# gateway/model/context defaults, workspace rule and non-root runtime user.
USER root
COPY --from=node_runtime /usr/local/bin/node /usr/local/bin/node
RUN npm install --global --registry=https://registry.npmjs.org --no-audit --no-fund @anthropic-ai/claude-code@2.1.266 \
    && node -e "const fs=require('fs'); const p=require('/usr/local/lib/node_modules/@anthropic-ai/claude-code/package.json'); if(p.version!=='2.1.266'||process.versions.node!=='22.22.1')throw Error('Runtime version mismatch'); fs.accessSync('/usr/local/bin/claude',fs.constants.X_OK)" \
    && echo '846acdc2e4dd9e4a70c79d88e1f225ba42962949a704ab37a8a290ec4417ccb7  /usr/local/bin/entrypoint.sh' | sha256sum --check \
    && npm cache clean --force

LABEL annotation.pipeline.base-image="adminfather/benzhi-claude-code:20260909-isolated-git" \
      annotation.pipeline.base-digest="sha256:f77014d9e56cd3db2ac96627a286814cb1aa9f0b4bb807bea98a01383c9bc4d8" \
      annotation.pipeline.claude-version="2.1.266" \
      annotation.pipeline.node-version="22.22.1" \
      annotation.pipeline.image-policy="2026-09-10.claude-upgrade1"
USER node
WORKDIR /workspace

# Prepare generic web tooling before any measured Claude session exists.
# Each question keeps a fresh home/container; no prompts, memory or answers cached.
USER root
COPY requirements.txt requirements.lock /opt/annotation/
ENV VIRTUAL_ENV=/opt/annotation/python
ENV PATH="/opt/annotation/python/bin:${PATH}"
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/annotation/browsers
RUN apt-get update \
    && apt-get install --yes --no-install-recommends python3-pip python3-venv ffmpeg \
    && python3 -m venv /opt/annotation/python \
    && python3 -m pip install --no-cache-dir -r /opt/annotation/requirements.lock \
    && python3 -m playwright install --with-deps chromium \
    && npm install --prefix /opt/annotation/node --no-audit --no-fund playwright@1.62.0 \
    && python3 -m pip freeze --all > /opt/annotation/python.lock \
    && sha256sum /opt/annotation/requirements.txt /opt/annotation/requirements.lock /opt/annotation/python.lock /opt/annotation/node/package-lock.json > /opt/annotation/dependencies.sha256 \
    && chown -R node:node /opt/annotation \
    && rm -rf /var/lib/apt/lists/*
ENV NODE_PATH=/opt/annotation/node/node_modules
LABEL annotation.pipeline.image-policy="2026-09-10.webdeps1"
USER node
WORKDIR /workspace
RUN python3 -c "import flask,fastapi,pytest,httpx,playwright; import tempfile,venv; p=tempfile.mkdtemp(); venv.create(p,with_pip=True)" \
    && python3 -c "from playwright.sync_api import sync_playwright; p=sync_playwright().start(); b=p.chromium.launch(headless=True,args=['--no-sandbox']); page=b.new_page(); page.set_content('<button>ready</button>'); page.get_by_role('button').click(); b.close(); p.stop()"

# Debian's docker-clean hook hard-codes /var/cache/apt even when callers choose
# a writable apt cache. Keep its original config as build evidence, outside apt's
# config directory; runtime jobs never need to clean system package caches.
USER root
RUN if [ -f /etc/apt/apt.conf.d/docker-clean ]; then mv /etc/apt/apt.conf.d/docker-clean /opt/annotation/apt-docker-clean.build-only; fi \
    && install -d -m 0700 -o node -g node /home/node/.cache/annotation /home/node/.cache/annotation/npm /home/node/.cache/annotation/pip /home/node/.cache/annotation/xdg
ENV npm_config_cache=/home/node/.cache/annotation/npm
ENV PIP_CACHE_DIR=/home/node/.cache/annotation/pip
ENV XDG_CACHE_HOME=/home/node/.cache/annotation/xdg
LABEL annotation.pipeline.image-policy="2026-09-10.webdeps-cache2"
USER node
RUN python3 -c "import os,tempfile; [tempfile.TemporaryFile(dir=os.environ[k]).close() for k in ('npm_config_cache','PIP_CACHE_DIR','XDG_CACHE_HOME')]" \
    && npm cache verify \
    && python3 -m pip cache info
