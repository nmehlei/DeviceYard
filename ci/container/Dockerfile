# syntax=docker/dockerfile:1
FROM node:22-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392 AS base
ARG TARGETARCH
RUN test "$TARGETARCH" = amd64

FROM base AS build
WORKDIR /build
COPY package*.json ./
COPY shared/package.json shared/package.json
COPY cli/package.json cli/package.json
RUN npm ci --no-audit --no-fund
COPY dashboard/package*.json dashboard/
RUN npm --prefix dashboard ci --no-audit --no-fund
COPY tsconfig.json entry.ts LICENSE ./
COPY src src
COPY shared shared
COPY cli cli
COPY vendor vendor
COPY dashboard dashboard
COPY ci/build.cjs ci/check-boundary.cjs ci/notices.cjs ci/
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build -- --webpack && node ci/notices.cjs

FROM base AS dependencies
WORKDIR /build
COPY package*.json ./
COPY shared/package.json shared/package.json
COPY cli/package.json cli/package.json
RUN npm ci --omit=dev --no-audit --no-fund

FROM base AS tooling
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl unzip && rm -rf /var/lib/apt/lists/*
COPY ci/container/toolchain.json /toolchain.json
RUN node -e 'const t=require("/toolchain.json");require("node:child_process").execFileSync("curl",["--fail","--location","--retry","3",t.maestro.url,"-o","/tmp/maestro.zip"],{stdio:"inherit"});const b=require("node:fs").readFileSync("/tmp/maestro.zip");if(require("node:crypto").createHash("sha256").update(b).digest("hex")!==t.maestro.sha256)throw Error("Maestro checksum mismatch")' 
RUN unzip -q /tmp/maestro.zip -d /opt && chmod +x /opt/maestro/bin/maestro

FROM base AS runtime
ARG SOURCE_REVISION=unknown
LABEL org.opencontainers.image.title="DeviceYard Community" \
      org.opencontainers.image.source="https://github.com/nmehlei/DeviceYard" \
      org.opencontainers.image.licenses="AGPL-3.0-only" \
      org.opencontainers.image.revision="$SOURCE_REVISION"
RUN apt-get update && apt-get install -y --no-install-recommends adb openjdk-17-jre-headless ca-certificates tini tar \
    && rm -rf /var/lib/apt/lists/* \
    && usermod --login deviceyard --home /home/deviceyard node \
    && groupmod --new-name deviceyard node \
    && mkdir -p /data /home/deviceyard/.android /opt/deviceyard/notices \
    && chown -R 1000:1000 /data /home/deviceyard
ENV NODE_ENV=production HOME=/home/deviceyard DATA_DIR=/data PORT=8080 \
    PATH=/opt/maestro/bin:$PATH MAESTRO_CLI_NO_ANALYTICS=1 MAESTRO_CLI_ANALYSIS_NOTIFICATION_DISABLED=true
WORKDIR /opt/deviceyard
COPY --from=build /build/dist ./dist
COPY --from=dependencies /build/node_modules ./node_modules
COPY --from=dependencies /build/shared/package.json ./shared/package.json
COPY --from=dependencies /build/cli/package.json ./cli/package.json
COPY package.json LICENSE THIRD_PARTY_NOTICES.md ./
COPY --from=tooling /opt/maestro /opt/maestro
COPY --from=build /build/docs/licenses/dependencies.json ./notices/dependencies.json
COPY ci/container/toolchain.json ./notices/toolchain.json
COPY ci/container/notices.cjs ci/container/validate-config.cjs ci/container/entrypoint.sh ./container/
RUN node container/notices.cjs && chmod 755 container/entrypoint.sh
USER 1000:1000
RUN node --version && java -version && adb version && maestro --version \
    && rm -rf /home/deviceyard/.maestro
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e 'fetch("http://127.0.0.1:"+(process.env.PORT||8080)+"/login",{signal:AbortSignal.timeout(4000)}).then(r=>process.exit(r.status===200?0:1)).catch(()=>process.exit(1))'
ENTRYPOINT ["/usr/bin/tini", "-g", "--", "/opt/deviceyard/container/entrypoint.sh"]
CMD ["node", "/opt/deviceyard/dist/entry.js"]
