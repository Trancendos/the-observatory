/**
 * The Observatory — Main Entry Point
 * Analytics, insights, trend analysis, and alerting for the Trancendos mesh.
 * Architecture: Trancendos Industry 6.0 / 2060 Standard
 */

import { logger } from './utils/logger';
import { createServer } from './api/server';
import { analyticsEngine } from './analytics/analytics-engine';

const PORT = parseInt(process.env.PORT || '3012', 10);
const HOST = process.env.HOST || '0.0.0.0';
const METRICS_INTERVAL_MS = parseInt(process.env.METRICS_INTERVAL_MS || '30000', 10);

async function bootstrap(): Promise<void> {
  logger.info({ service: 'the-observatory', port: PORT }, 'The Observatory bootstrapping — Prometheus awakening...');

  const stats = analyticsEngine.getStats();
  logger.info({ alertRules: stats.alertRules }, 'Analytics engine verified');

  const app = createServer();
  const server = app.listen(PORT, HOST, () => {
    logger.info({ host: HOST, port: PORT }, 'The Observatory listening — all-seeing eye active');
  });

  // Periodic system metrics collection
  setInterval(() => {
    const mem = process.memoryUsage();
    analyticsEngine.ingest([
      { name: 'memory.heapUsedMb', type: 'gauge', value: Math.round(mem.heapUsed/1024/1024), labels: { service: 'the-observatory' }, timestamp: new Date() },
      { name: 'memory.heapUsedPercent', type: 'gauge', value: Math.round((mem.heapUsed/mem.heapTotal)*100), labels: { service: 'the-observatory' }, timestamp: new Date() },
      { name: 'process.uptime', type: 'counter', value: Math.round(process.uptime()), labels: { service: 'the-observatory' }, timestamp: new Date() },
    ]);
  }, METRICS_INTERVAL_MS);

  const shutdown = (signal: string) => {
    logger.info({ signal }, 'Shutdown signal received');
    server.close(() => { logger.info('The Observatory shutdown complete'); process.exit(0); });
    setTimeout(() => process.exit(1), 10_000);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('uncaughtException', (err) => { logger.error({ err }, 'Uncaught exception'); shutdown('uncaughtException'); });
  process.on('unhandledRejection', (reason) => { logger.error({ reason }, 'Unhandled rejection'); });
}

bootstrap().catch((err) => { logger.error({ err }, 'Bootstrap failed'); process.exit(1); });