// OpenTelemetry tracing (infrastructure checklist §3). Load it first: `node --import ./src/server/telemetry.ts ...`.
// Off unless OTEL_EXPORTER_OTLP_ENDPOINT (or OTEL_EXPORTER_OTLP_TRACES_ENDPOINT) is set. Everything else comes from the
// standard OTEL_* variables (OTEL_SERVICE_NAME, OTEL_RESOURCE_ATTRIBUTES, OTEL_EXPORTER_OTLP_PROTOCOL, ...).
// Traced: incoming HTTP requests, outgoing HTTP and fetch calls, and Postgres queries.
import { register } from 'node:module';

let sdk: { shutdown(): Promise<void> } | undefined;

if (process.env.OTEL_EXPORTER_OTLP_ENDPOINT || process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT) {
  // ES modules are patched through import-in-the-middle, whose hook must be registered before they load.
  register('@opentelemetry/instrumentation/hook.mjs', import.meta.url);
  process.env.OTEL_SERVICE_NAME ??= 'pair41';
  const { NodeSDK } = await import('@opentelemetry/sdk-node');
  const { HttpInstrumentation } = await import('@opentelemetry/instrumentation-http');
  const { PgInstrumentation } = await import('@opentelemetry/instrumentation-pg');
  const { UndiciInstrumentation } = await import('@opentelemetry/instrumentation-undici');
  const instance = new NodeSDK({
    instrumentations: [
      new HttpInstrumentation({
        ignoreIncomingRequestHook: (req) => req.url === '/live' || req.url === '/ready',
      }),
      new PgInstrumentation(),
      new UndiciInstrumentation(),
    ],
  });
  instance.start();
  sdk = instance;
}

/** Flushes and stops tracing; part of graceful shutdown. */
export async function shutdownTelemetry(): Promise<void> {
  await sdk?.shutdown();
}
