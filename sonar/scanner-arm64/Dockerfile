# Native linux/arm64 sonar-scanner for Apple Silicon hosts. Every tag of sonarsource/sonar-scanner-cli is amd64 only,
# so on an arm64 host it runs under emulation and a scan takes about twice as long.
# Same scanner CLI as the official image (8.1.0.6389). The engine JRE still comes from the server (JRE provisioning).
# Node.js is the version that the JS/TS plugin embeds for linux-x64 (24.19.0): the plugin embeds no linux-arm64 build,
# so it takes `node` from PATH here.
FROM node:24.19.0-bookworm-slim@sha256:a9f5f7c91a432850b2a8a7797adf5eadb6c733ceed61167806cee7ea7fbc29df

ARG SCANNER_VERSION=8.1.0.6389
ARG SCANNER_SHA256=5e1c9328f4e261838de778c9e586ee608cca45ff7f0538108642219214628ba5

# git: the text and secrets sensor and the SCM sensor call the git CLI, as in the official image.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl git unzip \
  && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL -o /tmp/scanner.zip \
    "https://binaries.sonarsource.com/Distribution/sonar-scanner-cli/sonar-scanner-cli-${SCANNER_VERSION}-linux-aarch64.zip" \
  && echo "${SCANNER_SHA256}  /tmp/scanner.zip" | sha256sum -c - \
  && unzip -q /tmp/scanner.zip -d /opt \
  && mv "/opt/sonar-scanner-${SCANNER_VERSION}-linux-aarch64" /opt/sonar-scanner \
  && rm /tmp/scanner.zip

# HOME and the git config live in /tmp: scan.sh runs the container as the host uid, which has no home in the image.
ENV PATH=/opt/sonar-scanner/bin:$PATH \
    HOME=/tmp \
    XDG_CONFIG_HOME=/tmp \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8
WORKDIR /usr/src
# scan.sh sets the host uid with -u. This default keeps a direct run of the image off root.
USER node
ENTRYPOINT ["sonar-scanner"]
