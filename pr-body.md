## Wave 3 — The Observatory: Analytics Engine Platform Module

Implements The Observatory as a standalone service — metrics ingestion, trend analysis, threshold alerting, and insight reporting for the Trancendos mesh.

### What's Included

**AnalyticsEngine** (`src/analytics/analytics-engine.ts`)
- `ingest(metrics[])` / `ingestOne(name, value, type, labels)` — metric ingestion
- `getMetricSeries(name, labels)` — returns MetricSeries with trend, min, max, avg, latest
- Trend calculation: stable/up/down/volatile based on recent vs older averages
- `queryMetrics(namePattern, since)` — filtered metric queries
- `addAlertRule()` / `evaluateAlertRules()` — threshold-based alerting with cooldown
- `generateInsightReport()` — health score (0-100), trends, recommendations

**5 Default Alert Rules**
- High memory usage (>80%)
- Critical memory usage (>95%)
- High error rate (>10%)
- Low zero-cost compliance (<100%)
- Agent offline detection

**REST API** (`src/api/server.ts`)
- POST `/metrics/ingest` — ingest metric batch
- GET `/metrics/query` — query metrics by pattern
- GET `/metrics/series/:name` — get metric time series
- GET `/metrics/latest` — latest values for all metrics
- CRUD `/alert-rules` — manage alert rules
- GET/PATCH `/alerts` — list and resolve/silence alerts
- GET `/insights` — generate insight report
- GET `/stats`, `/health`, `/metrics`

**Bootstrap** (`src/index.ts`)
- Port 3012
- Periodic system metrics collection every 30s (memory, uptime, CPU)
- Pino structured logging
- Graceful shutdown (SIGTERM/SIGINT)

### Architecture
- Zero-cost mandate compliant
- Strict TypeScript ES2022
- Express + Helmet + CORS + Morgan
- Pino structured logging

### Part of Wave 3 — Platform Modules
Trancendos Industry 6.0 / 2060 Standard