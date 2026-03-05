/**
 * The Observatory — REST API Server
 * Metrics ingestion, alert management, trend analysis, insight reports
 */

import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import { logger } from '../utils/logger';
import { analyticsEngine } from '../analytics/analytics-engine';

export function createServer(): express.Application {
  const app = express();
  app.use(helmet()); app.use(cors()); app.use(express.json({ limit: '2mb' }));
  app.use(morgan('combined', { stream: { write: (m: string) => logger.info({ http: m.trim() }, 'HTTP') } }));

  app.get('/health', (_req, res) => {
    const stats = analyticsEngine.getStats();
    res.json({ status: 'healthy', service: 'the-observatory', uptime: process.uptime(), timestamp: new Date().toISOString(), ...stats });
  });

  app.get('/metrics', (_req, res) => {
    const mem = process.memoryUsage();
    res.json({ service: 'the-observatory', uptime: process.uptime(),
      memory: { heapUsedMb: Math.round(mem.heapUsed/1024/1024), rssMb: Math.round(mem.rss/1024/1024) },
      stats: analyticsEngine.getStats() });
  });

  // Metrics ingestion
  app.post('/api/v1/metrics', (req, res) => {
    try {
      const { metrics } = req.body;
      if (!Array.isArray(metrics)) return res.status(400).json({ error: 'metrics array required' });
      analyticsEngine.ingest(metrics.map(m => ({ ...m, timestamp: new Date(m.timestamp || Date.now()) })));
      return res.status(202).json({ ingested: metrics.length });
    } catch (err) { return res.status(500).json({ error: String(err) }); }
  });

  app.post('/api/v1/metrics/single', (req, res) => {
    try {
      const { name, value, type, labels, unit } = req.body;
      if (!name || value === undefined) return res.status(400).json({ error: 'name and value required' });
      analyticsEngine.ingestOne(name, value, type, labels, unit);
      return res.status(202).json({ ingested: 1 });
    } catch (err) { return res.status(500).json({ error: String(err) }); }
  });

  app.get('/api/v1/metrics', (req, res) => {
    const metrics = analyticsEngine.queryMetrics(
      req.query.name as string,
      req.query.since ? new Date(req.query.since as string) : undefined,
    );
    res.json({ count: metrics.length, metrics });
  });

  app.get('/api/v1/metrics/latest', (_req, res) => res.json(analyticsEngine.getLatestMetrics()));

  app.get('/api/v1/metrics/:name/series', (req, res) => {
    const series = analyticsEngine.getMetricSeries(req.params.name);
    if (!series) return res.status(404).json({ error: 'Metric series not found' });
    return res.json(series);
  });

  // Alert rules
  app.get('/api/v1/alert-rules', (_req, res) => res.json({ rules: analyticsEngine.getAlertRules() }));
  app.post('/api/v1/alert-rules', (req, res) => {
    try {
      const rule = analyticsEngine.addAlertRule(req.body);
      res.status(201).json(rule);
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });
  app.put('/api/v1/alert-rules/:id', (req, res) => {
    const updated = analyticsEngine.updateAlertRule(req.params.id, req.body);
    if (!updated) return res.status(404).json({ error: 'Rule not found' });
    return res.json(updated);
  });
  app.delete('/api/v1/alert-rules/:id', (req, res) => {
    const deleted = analyticsEngine.deleteAlertRule(req.params.id);
    res.json({ deleted });
  });

  // Alerts
  app.get('/api/v1/alerts', (req, res) => {
    const alerts = analyticsEngine.getAlerts(req.query.status as 'firing' | undefined);
    res.json({ count: alerts.length, alerts });
  });
  app.post('/api/v1/alerts/:id/resolve', (req, res) => {
    const ok = analyticsEngine.resolveAlert(req.params.id);
    if (!ok) return res.status(404).json({ error: 'Alert not found or not firing' });
    return res.json({ resolved: true });
  });
  app.post('/api/v1/alerts/:id/silence', (req, res) => {
    const ok = analyticsEngine.silenceAlert(req.params.id);
    if (!ok) return res.status(404).json({ error: 'Alert not found' });
    return res.json({ silenced: true });
  });

  // Insights
  app.get('/api/v1/insights', (_req, res) => res.json({ reports: analyticsEngine.getInsightReports() }));
  app.post('/api/v1/insights', (req, res) => {
    try {
      const { since, until } = req.body;
      const report = analyticsEngine.generateInsightReport(
        since && until ? { start: new Date(since), end: new Date(until) } : undefined,
      );
      res.status(201).json(report);
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  app.get('/api/v1/stats', (_req, res) => res.json(analyticsEngine.getStats()));

  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    logger.error({ err }, 'Unhandled error');
    res.status(500).json({ error: err.message });
  });
  app.use((_req, res) => res.status(404).json({ error: 'Not found' }));
  return app;
}