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
