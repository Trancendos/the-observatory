/**
 * The Observatory — Analytics Engine
 *
 * System-wide analytics, trend analysis, and insights for the Trancendos mesh.
 * Inspired by Prometheus (Void Guardian) — monitors all agents and services.
 *
 * Migrated from: agents/pillars/Prometheus.ts (757 lines)
 * Zero-cost: All analysis is rule-based, no LLM API calls.
 *
 * Architecture: Trancendos Industry 6.0 / 2060 Standard
 */

import { v4 as uuidv4 } from 'uuid';
import { logger } from '../utils/logger';

// ============================================================================
// TYPES
// ============================================================================

export type MetricType = 'counter' | 'gauge' | 'histogram' | 'summary';
export type AlertSeverity = 'info' | 'warning' | 'error' | 'critical';
export type TrendDirection = 'up' | 'down' | 'stable' | 'volatile';

export interface Metric {
  id: string;
  name: string;
  type: MetricType;
  value: number;
  labels: Record<string, string>;
  timestamp: Date;
  unit?: string;
}

export interface MetricSeries {
  name: string;
  labels: Record<string, string>;
  points: Array<{ timestamp: Date; value: number }>;
  trend: TrendDirection;
  min: number;
  max: number;
  avg: number;
  latest: number;
}

export interface Alert {
  id: string;
  name: string;
  severity: AlertSeverity;
  message: string;
  metric?: string;
  threshold?: number;
  currentValue?: number;
  labels: Record<string, string>;
  status: 'firing' | 'resolved' | 'silenced';
  firedAt: Date;
  resolvedAt?: Date;
}

export interface AlertRule {
  id: string;
  name: string;
  metric: string;
  condition: 'gt' | 'lt' | 'eq' | 'gte' | 'lte';
  threshold: number;
  severity: AlertSeverity;
  message: string;
  enabled: boolean;
  cooldownMs: number;
  lastFired?: Date;
}

export interface InsightReport {
  id: string;
  generatedAt: Date;
  period: { start: Date; end: Date };
  summary: string;
  topMetrics: MetricSeries[];
  activeAlerts: Alert[];
  trends: TrendAnalysis[];
  recommendations: string[];
  healthScore: number;
}

export interface TrendAnalysis {
  metric: string;
  direction: TrendDirection;
  changePercent: number;
  significance: 'low' | 'medium' | 'high';
  description: string;
}

export interface ObservatoryStats {
  totalMetrics: number;
  totalAlerts: number;
  activeAlerts: number;
  resolvedAlerts: number;
  alertRules: number;
  insightReports: number;
  metricsIngested: number;
}

// ============================================================================
// ANALYTICS ENGINE
// ============================================================================

export class AnalyticsEngine {
  private metrics: Map<string, Metric[]> = new Map();   // name -> time series
  private alerts: Map<string, Alert> = new Map();
  private alertRules: Map<string, AlertRule> = new Map();
  private insightReports: InsightReport[] = [];
  private metricsIngested = 0;

  constructor() {
    this.seedDefaultAlertRules();
    logger.info({ rules: this.alertRules.size }, 'AnalyticsEngine initialised');
  }

  // --------------------------------------------------------------------------
  // METRICS INGESTION
  // --------------------------------------------------------------------------

  ingest(metrics: Omit<Metric, 'id'>[]): void {
    for (const m of metrics) {
      const metric: Metric = { ...m, id: uuidv4() };
      const key = this.metricKey(m.name, m.labels);
      const series = this.metrics.get(key) || [];
      series.push(metric);
      // Keep last 1000 points per series
      if (series.length > 1000) series.splice(0, series.length - 1000);
      this.metrics.set(key, series);
      this.metricsIngested++;
    }

    // Evaluate alert rules after ingestion
    this.evaluateAlertRules();
  }

  ingestOne(name: string, value: number, type: MetricType = 'gauge', labels: Record<string, string> = {}, unit?: string): void {
    this.ingest([{ name, type, value, labels, timestamp: new Date(), unit }]);
  }

  // --------------------------------------------------------------------------
  // METRIC QUERIES
  // --------------------------------------------------------------------------

  getMetricSeries(name: string, labels?: Record<string, string>): MetricSeries | null {
    const key = this.metricKey(name, labels || {});
    const points = this.metrics.get(key);
    if (!points || points.length === 0) return null;

    const values = points.map(p => p.value);
    const trend = this.calculateTrend(values);

    return {
      name,
      labels: labels || {},
      points: points.map(p => ({ timestamp: p.timestamp, value: p.value })),
      trend,
      min: Math.min(...values),
      max: Math.max(...values),
      avg: values.reduce((a, b) => a + b, 0) / values.length,
      latest: values[values.length - 1],
    };
  }

  queryMetrics(namePattern?: string, since?: Date): Metric[] {
    const results: Metric[] = [];
    for (const series of this.metrics.values()) {
      for (const m of series) {
        if (namePattern && !m.name.includes(namePattern)) continue;
        if (since && m.timestamp < since) continue;
        results.push(m);
      }
    }
    return results.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
  }

  getLatestMetrics(): Record<string, number> {
    const result: Record<string, number> = {};
    for (const [key, series] of this.metrics.entries()) {
      if (series.length > 0) {
        result[key] = series[series.length - 1].value;
      }
    }
    return result;
  }

  // --------------------------------------------------------------------------
  // ALERT RULES
  // --------------------------------------------------------------------------

  addAlertRule(rule: Omit<AlertRule, 'id'>): AlertRule {
    const full: AlertRule = { ...rule, id: uuidv4() };
    this.alertRules.set(full.id, full);
    logger.info({ ruleId: full.id, name: full.name }, 'Alert rule added');
    return full;
  }

  updateAlertRule(id: string, updates: Partial<AlertRule>): AlertRule | null {
    const rule = this.alertRules.get(id);
    if (!rule) return null;
    Object.assign(rule, updates);
    return rule;
  }

  deleteAlertRule(id: string): boolean { return this.alertRules.delete(id); }
  getAlertRules(): AlertRule[] { return Array.from(this.alertRules.values()); }

  private evaluateAlertRules(): void {
    for (const rule of this.alertRules.values()) {
      if (!rule.enabled) continue;

      // Cooldown check
      if (rule.lastFired && Date.now() - rule.lastFired.getTime() < rule.cooldownMs) continue;

      const series = this.getMetricSeries(rule.metric);
      if (!series) continue;

      const value = series.latest;
      const triggered = this.evaluateCondition(value, rule.condition, rule.threshold);

      if (triggered) {
        const existingAlert = Array.from(this.alerts.values()).find(
          a => a.name === rule.name && a.status === 'firing',
        );
        if (!existingAlert) {
          const alert: Alert = {
            id: uuidv4(),
            name: rule.name,
            severity: rule.severity,
            message: rule.message.replace('{value}', value.toFixed(2)).replace('{threshold}', rule.threshold.toString()),
            metric: rule.metric,
            threshold: rule.threshold,
            currentValue: value,
            labels: {},
            status: 'firing',
            firedAt: new Date(),
          };
          this.alerts.set(alert.id, alert);
          rule.lastFired = new Date();
          logger.warn({ alertId: alert.id, name: alert.name, severity: alert.severity, value }, 'Alert fired');
        }
      } else {
        // Auto-resolve firing alerts for this rule
        for (const alert of this.alerts.values()) {
          if (alert.name === rule.name && alert.status === 'firing') {
            alert.status = 'resolved';
            alert.resolvedAt = new Date();
          }
        }
      }
    }
  }

  private evaluateCondition(value: number, condition: AlertRule['condition'], threshold: number): boolean {
    switch (condition) {
      case 'gt': return value > threshold;
      case 'lt': return value < threshold;
      case 'eq': return value === threshold;
      case 'gte': return value >= threshold;
      case 'lte': return value <= threshold;
    }
  }

  // --------------------------------------------------------------------------
  // ALERTS
  // --------------------------------------------------------------------------

  getAlerts(status?: Alert['status']): Alert[] {
    const all = Array.from(this.alerts.values());
    return status ? all.filter(a => a.status === status) : all;
  }

  resolveAlert(id: string): boolean {
    const alert = this.alerts.get(id);
    if (!alert || alert.status !== 'firing') return false;
    alert.status = 'resolved';
    alert.resolvedAt = new Date();
    return true;
  }

  silenceAlert(id: string): boolean {
    const alert = this.alerts.get(id);
    if (!alert) return false;
    alert.status = 'silenced';
    return true;
  }

  // --------------------------------------------------------------------------
  // INSIGHTS
  // --------------------------------------------------------------------------

  generateInsightReport(period?: { start: Date; end: Date }): InsightReport {
    const now = new Date();
    const start = period?.start || new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const end = period?.end || now;

    const topMetrics: MetricSeries[] = [];
    for (const [key] of this.metrics.entries()) {
      const [name] = key.split('|');
      const series = this.getMetricSeries(name);
      if (series) topMetrics.push(series);
    }

    const trends = this.analyzeTrends(topMetrics);
    const activeAlerts = this.getAlerts('firing');
    const healthScore = this.calculateHealthScore(activeAlerts, trends);

    const report: InsightReport = {
      id: uuidv4(),
      generatedAt: now,
      period: { start, end },
      summary: this.buildSummary(healthScore, activeAlerts.length, trends),
      topMetrics: topMetrics.slice(0, 10),
      activeAlerts,
      trends,
      recommendations: this.buildInsightRecommendations(activeAlerts, trends),
      healthScore,
    };

    this.insightReports.push(report);
    logger.info({ reportId: report.id, healthScore, activeAlerts: activeAlerts.length }, 'Insight report generated');
    return report;
  }

  getInsightReports(): InsightReport[] {
    return [...this.insightReports].sort((a, b) => b.generatedAt.getTime() - a.generatedAt.getTime());
  }

  // --------------------------------------------------------------------------
  // STATS
  // --------------------------------------------------------------------------

  getStats(): ObservatoryStats {
    const alerts = Array.from(this.alerts.values());
    return {
      totalMetrics: this.metrics.size,
      totalAlerts: alerts.length,
      activeAlerts: alerts.filter(a => a.status === 'firing').length,
      resolvedAlerts: alerts.filter(a => a.status === 'resolved').length,
      alertRules: this.alertRules.size,
      insightReports: this.insightReports.length,
      metricsIngested: this.metricsIngested,
    };
  }

  // --------------------------------------------------------------------------
  // PRIVATE HELPERS
  // --------------------------------------------------------------------------

  private metricKey(name: string, labels: Record<string, string>): string {
    const labelStr = Object.entries(labels).sort().map(([k, v]) => `${k}=${v}`).join(',');
    return labelStr ? `${name}|${labelStr}` : name;
  }

  private calculateTrend(values: number[]): TrendDirection {
    if (values.length < 2) return 'stable';
    const recent = values.slice(-10);
    const older = values.slice(-20, -10);
    if (older.length === 0) return 'stable';

    const recentAvg = recent.reduce((a, b) => a + b, 0) / recent.length;
    const olderAvg = older.reduce((a, b) => a + b, 0) / older.length;
    const changePercent = olderAvg !== 0 ? ((recentAvg - olderAvg) / olderAvg) * 100 : 0;

    if (Math.abs(changePercent) < 5) return 'stable';
    if (changePercent > 20) return 'volatile';
    return changePercent > 0 ? 'up' : 'down';
  }

  private analyzeTrends(series: MetricSeries[]): TrendAnalysis[] {
    return series.map(s => {
      const changePercent = s.avg !== 0 ? ((s.latest - s.avg) / s.avg) * 100 : 0;
      return {
        metric: s.name,
        direction: s.trend,
        changePercent: Math.round(changePercent * 10) / 10,
        significance: Math.abs(changePercent) > 20 ? 'high' : Math.abs(changePercent) > 10 ? 'medium' : 'low',
        description: `${s.name} is ${s.trend} (${changePercent > 0 ? '+' : ''}${changePercent.toFixed(1)}% vs average)`,
      };
    });
  }

  private calculateHealthScore(activeAlerts: Alert[], trends: TrendAnalysis[]): number {
    let score = 100;
    for (const alert of activeAlerts) {
      if (alert.severity === 'critical') score -= 25;
      else if (alert.severity === 'error') score -= 15;
      else if (alert.severity === 'warning') score -= 7;
      else score -= 2;
    }
    const volatileTrends = trends.filter(t => t.direction === 'volatile').length;
    score -= volatileTrends * 5;
    return Math.max(0, score);
  }

  private buildSummary(healthScore: number, activeAlerts: number, trends: TrendAnalysis[]): string {
    const grade = healthScore >= 90 ? 'excellent' : healthScore >= 70 ? 'good' : healthScore >= 50 ? 'degraded' : 'critical';
    return `System health is ${grade} (score: ${healthScore}/100). ${activeAlerts} active alert(s). ${trends.filter(t => t.direction !== 'stable').length} metric(s) trending.`;
  }

  private buildInsightRecommendations(activeAlerts: Alert[], trends: TrendAnalysis[]): string[] {
    const recs: string[] = [];
    const criticalAlerts = activeAlerts.filter(a => a.severity === 'critical');
    if (criticalAlerts.length > 0) recs.push(`Immediately address ${criticalAlerts.length} critical alert(s): ${criticalAlerts.map(a => a.name).join(', ')}`);
    const upTrends = trends.filter(t => t.direction === 'up' && t.significance === 'high');
    if (upTrends.length > 0) recs.push(`Monitor rapidly increasing metrics: ${upTrends.map(t => t.metric).join(', ')}`);
    if (activeAlerts.length === 0) recs.push('All systems nominal — continue monitoring');
    return recs;
  }

  private seedDefaultAlertRules(): void {
    const defaults: Omit<AlertRule, 'id'>[] = [
      { name: 'High Memory Usage', metric: 'memory.heapUsedPercent', condition: 'gt', threshold: 85, severity: 'warning', message: 'Memory usage at {value}% (threshold: {threshold}%)', enabled: true, cooldownMs: 300_000 },
      { name: 'Critical Memory Usage', metric: 'memory.heapUsedPercent', condition: 'gt', threshold: 95, severity: 'critical', message: 'CRITICAL: Memory usage at {value}% (threshold: {threshold}%)', enabled: true, cooldownMs: 60_000 },
      { name: 'High Error Rate', metric: 'http.errorRate', condition: 'gt', threshold: 5, severity: 'error', message: 'HTTP error rate at {value}% (threshold: {threshold}%)', enabled: true, cooldownMs: 120_000 },
      { name: 'Low Zero-Cost Compliance', metric: 'finance.zeroCostCompliance', condition: 'lt', threshold: 100, severity: 'critical', message: 'Zero-cost compliance at {value}% (threshold: {threshold}%)', enabled: true, cooldownMs: 60_000 },
      { name: 'Agent Offline', metric: 'agent.healthyCount', condition: 'lt', threshold: 1, severity: 'critical', message: 'No healthy agents detected (count: {value})', enabled: true, cooldownMs: 30_000 },
    ];
    for (const rule of defaults) this.addAlertRule(rule);
  }
}

export const analyticsEngine = new AnalyticsEngine();