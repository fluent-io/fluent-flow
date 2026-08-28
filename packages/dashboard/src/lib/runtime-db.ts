import type * as FluentFlowDb from '@fluent-flow/db';

export type FluentFlowDbModule = typeof FluentFlowDb;

export function loadDb(): Promise<FluentFlowDbModule> {
  // Static @fluent-flow/db imports instantiate the Drizzle pool while Next.js
  // collects route/page data during `next build`; deployments provide
  // DATABASE_URL at runtime, so build-time module evaluation must stay lazy.
  return import('@fluent-flow/db');
}
