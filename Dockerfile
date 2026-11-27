# Pair41 server image: one image for every environment, all config from environment variables.
# Node runs the TypeScript source directly (type stripping, Node 22.18+), so there is no build step.
# The image trusts the AWS RDS certificate authorities as well (infra/rds-ca-bundle.pem, a copy of
# https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem, through NODE_EXTRA_CA_CERTS), so with
# PAIR41_DATABASE_SSL=true the app and `pair41 migrate` check the database's certificate. Particle41/quark-p41's pattern.

FROM node:22-slim AS deps
RUN apt-get update \
    && apt-get install -y --no-install-recommends g++ make python3 \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm_config_nodedir=/usr/local npm ci --omit=dev && npm cache clean --force

FROM node:22-slim
ENV NODE_ENV=production \
    PORT=8080 \
    HOST=0.0.0.0 \
    OTEL_SERVICE_NAME=pair41 \
    NODE_EXTRA_CA_CERTS=/etc/ssl/certs/rds-ca-bundle.pem
COPY infra/rds-ca-bundle.pem /etc/ssl/certs/rds-ca-bundle.pem
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY bin ./bin
COPY src ./src
# The base image's node user, as a numeric UID and GID for Kubernetes runAsNonRoot.
USER 1000:1000
EXPOSE 8080
# Exec form, so SIGTERM reaches Node (graceful shutdown). Tracing loads first; it is off unless
# OTEL_EXPORTER_OTLP_ENDPOINT is set. Migrations are a separate command: node src/cli/main.ts migrate
CMD ["node", "--import", "./src/server/telemetry.ts", "src/server/main.ts"]
