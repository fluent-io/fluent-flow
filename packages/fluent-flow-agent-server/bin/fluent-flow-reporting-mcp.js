#!/usr/bin/env node
import { runReportingMcpHelper } from '../src/reporting-mcp.js';
import { createLogger } from '../src/logger.js';
import { safeError } from '../src/safe-error.js';

try {
  if (!await runReportingMcpHelper()) throw new Error('Reporting helper shutdown failed');
} catch (error) {
  let message = safeError(error);
  for (const value of [process.env.FLUENT_FLOW_REPORTING_CREDENTIAL, process.env.FLUENT_FLOW_REPORTING_CAPTURE_KEY, process.env.FLUENT_FLOW_REPORTING_WORKSPACE, process.env.FLUENT_FLOW_REPORTING_URL]) {
    if (value) message = message.split(value).join('[REDACTED]');
  }
  createLogger(false, 'info', process.stderr).error('Reporting helper failed', { event: 'reporting_helper_failed', error: message });
  process.exitCode = 1;
}
