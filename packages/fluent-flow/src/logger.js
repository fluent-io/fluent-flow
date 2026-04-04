import pino from 'pino';

const DEFAULT_LOG_LEVEL = 'info';
const level = process.env.LOG_LEVEL || DEFAULT_LOG_LEVEL;
const otelEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;

let logger;

if (otelEndpoint) {
  // Send logs to SigNoz/OpenTelemetry collector via OTLP
  const transport = pino.transport({
    targets: [
      {
        target: 'pino-opentelemetry-transport',
        options: {
          resourceAttributes: {
            'service.name': process.env.OTEL_SERVICE_NAME || 'fluent-flow',
          },
        },
      },
      // Also log to stdout
      { target: 'pino/file', options: { destination: 1 } },
    ],
  });
  logger = pino({ level }, transport);
} else {
  logger = pino({ level });
}

export default logger;
