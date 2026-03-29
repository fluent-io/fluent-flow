// tracing.cjs - OpenTelemetry setup for SigNoz
const { NodeSDK } = require('@opentelemetry/sdk-node');
const { getNodeAutoInstrumentations } = require('@opentelemetry/auto-instrumentations-node');
const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-http');

const baseEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT || 'http://signoz-otel-collector:4318';
const tracesEndpoint = baseEndpoint.endsWith('/v1/traces') ? baseEndpoint : baseEndpoint + '/v1/traces';

const sdk = new NodeSDK({
  serviceName: process.env.OTEL_SERVICE_NAME || 'fluent-flow',
  traceExporter: new OTLPTraceExporter({
    url: tracesEndpoint,
  }),
  instrumentations: [
    getNodeAutoInstrumentations({
      '@opentelemetry/instrumentation-fs': { enabled: false },
    }),
  ],
});

sdk.start();

process.on('SIGTERM', () => {
  sdk.shutdown()
    .then(() => console.log('Tracing terminated'))
    .catch((error) => console.log('Error terminating tracing', error))
    .finally(() => process.exit(0));
});
