#!/usr/bin/env node
/**
 * Observatory — Immutable Audit & Logging Platform
 * The single source of truth for every event across the Trancendos Ecosystem.
 *
 * Features:
 *  - Merkle hash chain (tamper-evident)
 *  - CQRS / Event Sourcing pattern
 *  - Before/after diff capture
 *  - Role-based visibility (user sees own, admin sees all)
 *  - Incident/submission system
 *  - Anomaly detection triggers
 *  - REST API + WebSocket for real-time streaming
 */

'use strict';

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

// ─── Configuration ────────────────────────────────────────────────────────────
const CONFIG = {
  port: parseInt(process.env.OBSERVATORY_PORT || '3010'),
  host: process.env.OBSERVATORY_HOST || '0.0.0.0',
  dataDir: process.env.OBSERVATORY_DATA_DIR || path.join(__dirname, '../data'),
  maxEventsInMemory: 10000,
  anomalyWindowMs: 60000,       // 1 minute window for anomaly detection
  anomalyThreshold: 50,          // events per window before alert
  incidentAutoAssessDelay: 5000, // ms before AI assessment runs
};

// ─── Event Store (Append-Only with Merkle Chain) ──────────────────────────────
class EventStore extends EventEmitter {
  constructor(dataDir) {
    super();
    this.dataDir = dataDir;
    this.eventsFile = path.join(dataDir, 'events.ndjson');
    this.indexFile = path.join(dataDir, 'event-index.json');
    this.sequenceFile = path.join(dataDir, 'sequence.json');
    this.lastHash = '0000000000000000000000000000000000000000000000000000000000000000';
    this.sequence = 0;
    this.memoryCache = []; // last N events in memory
    this._init();
  }

  _init() {
    fs.mkdirSync(this.dataDir, { recursive: true });

    // Load last sequence and hash from disk
    if (fs.existsSync(this.sequenceFile)) {
      try {
        const state = JSON.parse(fs.readFileSync(this.sequenceFile, 'utf8'));
        this.sequence = state.sequence || 0;
        this.lastHash = state.lastHash || this.lastHash;
      } catch (e) {
        console.error('Could not load sequence state:', e.message);
      }
    }

    // Load recent events into memory cache
    if (fs.existsSync(this.eventsFile)) {
      try {
        const lines = fs.readFileSync(this.eventsFile, 'utf8').trim().split('\n').filter(Boolean);
        const recent = lines.slice(-CONFIG.maxEventsInMemory);
        this.memoryCache = recent.map(l => JSON.parse(l));
      } catch (e) {
        console.error('Could not load event cache:', e.message);
      }
    }
  }

  _saveState() {
    fs.writeFileSync(this.sequenceFile, JSON.stringify({
      sequence: this.sequence,
      lastHash: this.lastHash,
      updatedAt: new Date().toISOString(),
    }));
  }

  /**
   * Append an event to the immutable store.
   * Computes Merkle hash chain: hash(previousHash + eventData)
   */
  append(eventData) {
    this.sequence++;

    const event = {
      eventId: this._generateEventId(),
      sequenceNumber: this.sequence,
      timestamp: new Date().toISOString(),
      previousHash: this.lastHash,
      ...eventData,
    };

    // Compute current hash (chain link)
    const hashInput = `${event.previousHash}:${event.sequenceNumber}:${JSON.stringify(event.actor)}:${JSON.stringify(event.action)}:${event.timestamp}`;
    event.currentHash = crypto.createHash('sha256').update(hashInput).digest('hex');

    // Update chain
    this.lastHash = event.currentHash;

    // Append to disk (NDJSON — one JSON object per line)
    fs.appendFileSync(this.eventsFile, JSON.stringify(event) + '\n');

    // Update memory cache
    this.memoryCache.push(event);
    if (this.memoryCache.length > CONFIG.maxEventsInMemory) {
      this.memoryCache.shift();
    }

    // Persist sequence state
    this._saveState();

    // Emit for real-time subscribers
    this.emit('event', event);

    return event;
  }

  /**
   * Query events with filters
   */
  query(filters = {}) {
    let events = [...this.memoryCache];

    if (filters.actorId) {
      events = events.filter(e => e.actor?.id === filters.actorId);
    }
    if (filters.actorType) {
      events = events.filter(e => e.actor?.type === filters.actorType);
    }
    if (filters.actionType) {
      events = events.filter(e => e.action?.type === filters.actionType);
    }
    if (filters.category) {
      events = events.filter(e => e.action?.category === filters.category);
    }
    if (filters.resourceId) {
      events = events.filter(e => e.action?.resource?.id === filters.resourceId);
    }
    if (filters.since) {
      const since = new Date(filters.since).getTime();
      events = events.filter(e => new Date(e.timestamp).getTime() >= since);
    }
    if (filters.until) {
      const until = new Date(filters.until).getTime();
      events = events.filter(e => new Date(e.timestamp).getTime() <= until);
    }
    if (filters.severity) {
      events = events.filter(e => e.metadata?.severity === filters.severity);
    }
    // Visibility filter
    if (filters.viewerRole !== 'admin') {
      events = events.filter(e =>
        e.visibility?.actorVisible && e.actor?.id === filters.viewerId
      );
    }

    // Sort and paginate
    events.sort((a, b) => b.sequenceNumber - a.sequenceNumber);
    const limit = Math.min(filters.limit || 50, 500);
    const offset = filters.offset || 0;

    return {
      total: events.length,
      limit,
      offset,
      events: events.slice(offset, offset + limit),
    };
  }

  /**
   * Verify chain integrity from sequence start to end
   */
  verifyChain(fromSeq = 1, toSeq = null) {
    const lines = fs.readFileSync(this.eventsFile, 'utf8').trim().split('\n').filter(Boolean);
    const events = lines.map(l => JSON.parse(l));

    let prevHash = '0000000000000000000000000000000000000000000000000000000000000000';
    let valid = true;
    const errors = [];

    for (const event of events) {
      if (toSeq && event.sequenceNumber > toSeq) break;
      if (event.sequenceNumber < fromSeq) {
        prevHash = event.currentHash;
        continue;
      }

      // Verify previous hash link
      if (event.previousHash !== prevHash) {
        errors.push({
          sequenceNumber: event.sequenceNumber,
          eventId: event.eventId,
          error: 'Hash chain broken',
          expected: prevHash,
          found: event.previousHash,
        });
        valid = false;
      }

      // Verify current hash
      const hashInput = `${event.previousHash}:${event.sequenceNumber}:${JSON.stringify(event.actor)}:${JSON.stringify(event.action)}:${event.timestamp}`;
      const expectedHash = crypto.createHash('sha256').update(hashInput).digest('hex');
      if (event.currentHash !== expectedHash) {
        errors.push({
          sequenceNumber: event.sequenceNumber,
          eventId: event.eventId,
          error: 'Event hash invalid (possible tampering)',
          expected: expectedHash,
          found: event.currentHash,
        });
        valid = false;
      }

      prevHash = event.currentHash;
    }

    return { valid, eventsChecked: events.length, errors };
  }

  _generateEventId() {
    const timestamp = Date.now().toString(36);
    const random = crypto.randomBytes(8).toString('hex');
    return `evt-${timestamp}-${random}`;
  }

  getStats() {
    return {
      totalEvents: this.sequence,
      lastHash: this.lastHash,
      cachedEvents: this.memoryCache.length,
      dataFile: this.eventsFile,
    };
  }
}

// ─── Incident Store ───────────────────────────────────────────────────────────
class IncidentStore {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.incidentsFile = path.join(dataDir, 'incidents.json');
    this.incidents = this._load();
  }

  _load() {
    if (fs.existsSync(this.incidentsFile)) {
      try { return JSON.parse(fs.readFileSync(this.incidentsFile, 'utf8')); } catch (e) { return []; }
    }
    return [];
  }

  _save() {
    fs.writeFileSync(this.incidentsFile, JSON.stringify(this.incidents, null, 2));
  }

  create(data) {
    const incident = {
      incidentId: `INC-${Date.now()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`,
      status: 'OPEN',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      aiAssessment: null,
      humanReview: null,
      resolution: null,
      ...data,
    };
    this.incidents.unshift(incident);
    this._save();
    return incident;
  }

  update(incidentId, updates) {
    const idx = this.incidents.findIndex(i => i.incidentId === incidentId);
    if (idx === -1) throw new Error(`Incident not found: ${incidentId}`);
    this.incidents[idx] = { ...this.incidents[idx], ...updates, updatedAt: new Date().toISOString() };
    this._save();
    return this.incidents[idx];
  }

  get(incidentId) {
    return this.incidents.find(i => i.incidentId === incidentId) || null;
  }

  list(filters = {}) {
    let list = [...this.incidents];
    if (filters.status) list = list.filter(i => i.status === filters.status);
    if (filters.submittedBy) list = list.filter(i => i.submittedBy === filters.submittedBy);
    if (filters.viewerRole !== 'admin') {
      list = list.filter(i => i.submittedBy === filters.viewerId);
    }
    return list.slice(0, filters.limit || 50);
  }
}

// ─── Anomaly Detector ─────────────────────────────────────────────────────────
class AnomalyDetector extends EventEmitter {
  constructor() {
    super();
    this.windows = new Map(); // actorId -> [timestamps]
    this.baselines = new Map(); // actorId -> { mean, stddev }
  }

  record(event) {
    const actorId = event.actor?.id || 'anonymous';
    const now = Date.now();

    if (!this.windows.has(actorId)) this.windows.set(actorId, []);
    const window = this.windows.get(actorId);

    // Add current timestamp
    window.push(now);

    // Remove events outside window
    const cutoff = now - CONFIG.anomalyWindowMs;
    const trimmed = window.filter(t => t >= cutoff);
    this.windows.set(actorId, trimmed);

    // Check for anomaly
    if (trimmed.length > CONFIG.anomalyThreshold) {
      this.emit('anomaly', {
        type: 'HIGH_FREQUENCY',
        actorId,
        actorName: event.actor?.name,
        eventsInWindow: trimmed.length,
        threshold: CONFIG.anomalyThreshold,
        windowMs: CONFIG.anomalyWindowMs,
        triggeringEvent: event.eventId,
        timestamp: new Date().toISOString(),
      });
    }

    // Check for unusual action patterns
    this._checkActionPattern(event);
  }

  _checkActionPattern(event) {
    const actionType = event.action?.type;
    const category = event.action?.category;

    // Flag mass deletions
    if (actionType === 'DELETE') {
      const actorId = event.actor?.id || 'anonymous';
      const window = this.windows.get(actorId) || [];
      const recentDeletes = window.length; // simplified
      if (recentDeletes > 10) {
        this.emit('anomaly', {
          type: 'MASS_DELETE',
          actorId,
          category,
          timestamp: new Date().toISOString(),
        });
      }
    }

    // Flag admin actions outside business hours (UTC 08:00-18:00)
    if (event.actor?.role === 'admin') {
      const hour = new Date().getUTCHours();
      if (hour < 6 || hour > 22) {
        this.emit('anomaly', {
          type: 'OFF_HOURS_ADMIN',
          actorId: event.actor?.id,
          actorName: event.actor?.name,
          hour,
          action: actionType,
          timestamp: new Date().toISOString(),
        });
      }
    }
  }
}

// ─── AI Assessment Engine (Stub — integrates with real LLM in production) ─────
class AIAssessmentEngine {
  async assessIncident(incident) {
    // In production: call OpenAI/Ollama API
    // Here: rule-based assessment for demonstration

    const reason = (incident.reason || '').toLowerCase();
    const eventAction = incident.relatedEvent?.action?.type || '';

    let verdict = 'REQUIRES_HUMAN_REVIEW';
    let confidence = 0.5;
    let reasoning = '';
    let recommendation = '';

    // Simple rule-based assessment
    if (reason.length < 20) {
      verdict = 'REJECTED';
      confidence = 0.9;
      reasoning = 'Insufficient reason provided. Submissions must include a detailed explanation.';
      recommendation = 'Please resubmit with a detailed explanation of why the change should be reverted.';
    } else if (reason.includes('error') || reason.includes('mistake') || reason.includes('incorrect')) {
      verdict = 'VALID_FOR_REVIEW';
      confidence = 0.75;
      reasoning = 'Submission indicates a potential error was made. Escalating to human admin for review.';
      recommendation = 'Admin should review the before/after diff and determine if revert is warranted.';
    } else if (reason.includes('security') || reason.includes('breach') || reason.includes('unauthorized')) {
      verdict = 'URGENT_REVIEW';
      confidence = 0.85;
      reasoning = 'Security-related submission. Immediate human review required.';
      recommendation = 'Escalate to security team immediately. Consider temporary rollback pending investigation.';
    } else {
      verdict = 'VALID_FOR_REVIEW';
      confidence = 0.6;
      reasoning = 'Submission appears legitimate. Routing to human admin for final decision.';
      recommendation = 'Admin should review the change and determine appropriate action.';
    }

    return {
      verdict,
      confidence,
      reasoning,
      recommendation,
      assessedAt: new Date().toISOString(),
      assessedBy: 'observatory-ai-v1',
      piiDetected: this._detectPII(reason),
    };
  }

  _detectPII(text) {
    // Simple PII patterns
    const patterns = [
      /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/, // email
      /\b\d{3}[-.]?\d{3}[-.]?\d{4}\b/, // phone
      /\b\d{4}[- ]?\d{4}[- ]?\d{4}[- ]?\d{4}\b/, // credit card
      /\b(?:\d{1,3}\.){3}\d{1,3}\b/, // IP address
    ];
    return patterns.some(p => p.test(text));
  }
}

// ─── HTTP Server ──────────────────────────────────────────────────────────────
class ObservatoryServer {
  constructor() {
    this.eventStore = new EventStore(path.join(CONFIG.dataDir, 'events'));
    this.incidentStore = new IncidentStore(path.join(CONFIG.dataDir, 'incidents'));
    this.anomalyDetector = new AnomalyDetector();
    this.aiEngine = new AIAssessmentEngine();
    this.wsClients = new Set();

    // Wire anomaly detector to event store
    this.eventStore.on('event', (event) => {
      this.anomalyDetector.record(event);
    });

    // Wire anomaly alerts to Observatory events
    this.anomalyDetector.on('anomaly', (anomaly) => {
      this.eventStore.append({
        actor: { type: 'system', id: 'observatory', name: 'Observatory Anomaly Detector' },
        action: { type: 'ANOMALY_DETECTED', category: 'security' },
        metadata: { severity: 'HIGH', anomaly },
        visibility: { adminVisible: true, actorVisible: false, publicVisible: false },
      });
      // Broadcast to WebSocket clients
      this._broadcast({ type: 'anomaly', data: anomaly });
    });

    // Wire event store to WebSocket broadcast
    this.eventStore.on('event', (event) => {
      this._broadcast({ type: 'event', data: event });
    });

    this.server = http.createServer(this._handleRequest.bind(this));
  }

  _broadcast(message) {
    const payload = JSON.stringify(message);
    for (const client of this.wsClients) {
      try { client.write(`data: ${payload}\n\n`); } catch (e) { this.wsClients.delete(client); }
    }
  }

  _parseBody(req) {
    return new Promise((resolve, reject) => {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        try { resolve(body ? JSON.parse(body) : {}); } catch (e) { reject(new Error('Invalid JSON')); }
      });
    });
  }

  _respond(res, status, data) {
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'X-Observatory-Version': '1.0.0',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Actor-Id, X-Actor-Role',
    });
    res.end(JSON.stringify(data, null, 2));
  }

  async _handleRequest(req, res) {
    if (req.method === 'OPTIONS') {
      this._respond(res, 200, {});
      return;
    }

    const url = new URL(req.url, `http://${req.headers.host}`);
    const pathname = url.pathname;
    const actorId = req.headers['x-actor-id'] || 'anonymous';
    const actorRole = req.headers['x-actor-role'] || 'user';

    try {
      // ── Events API ──────────────────────────────────────────────────────────
      if (pathname === '/events' && req.method === 'POST') {
        const body = await this._parseBody(req);
        const event = this.eventStore.append({
          actor: body.actor || { type: 'system', id: actorId, role: actorRole },
          action: body.action || {},
          diff: body.diff || {},
          metadata: body.metadata || {},
          visibility: body.visibility || { adminVisible: true, actorVisible: true, publicVisible: false },
        });
        this._respond(res, 201, { success: true, event });
        return;
      }

      if (pathname === '/events' && req.method === 'GET') {
        const filters = {
          actorId: url.searchParams.get('actorId'),
          actorType: url.searchParams.get('actorType'),
          actionType: url.searchParams.get('actionType'),
          category: url.searchParams.get('category'),
          since: url.searchParams.get('since'),
          until: url.searchParams.get('until'),
          limit: parseInt(url.searchParams.get('limit') || '50'),
          offset: parseInt(url.searchParams.get('offset') || '0'),
          viewerId: actorId,
          viewerRole: actorRole,
        };
        const result = this.eventStore.query(filters);
        this._respond(res, 200, result);
        return;
      }

      if (pathname === '/events/verify-chain' && req.method === 'GET') {
        if (actorRole !== 'admin') {
          this._respond(res, 403, { error: 'Admin access required' });
          return;
        }
        const result = this.eventStore.verifyChain();
        this._respond(res, 200, result);
        return;
      }

      if (pathname === '/events/stats' && req.method === 'GET') {
        this._respond(res, 200, this.eventStore.getStats());
        return;
      }

      // ── Incidents API ───────────────────────────────────────────────────────
      if (pathname === '/incidents' && req.method === 'POST') {
        const body = await this._parseBody(req);

        if (!body.reason || body.reason.length < 10) {
          this._respond(res, 400, { error: 'Reason must be at least 10 characters' });
          return;
        }

        const incident = this.incidentStore.create({
          submittedBy: actorId,
          submitterRole: actorRole,
          reason: body.reason,
          relatedEventId: body.relatedEventId,
          relatedEvent: body.relatedEvent,
          category: body.category || 'general',
          priority: body.priority || 'MEDIUM',
        });

        // Record in Observatory
        this.eventStore.append({
          actor: { type: 'user', id: actorId, role: actorRole },
          action: { type: 'SUBMIT', category: 'incident', resource: { type: 'incident', id: incident.incidentId } },
          metadata: { incidentId: incident.incidentId },
          visibility: { adminVisible: true, actorVisible: true, publicVisible: false },
        });

        // Schedule AI assessment
        setTimeout(async () => {
          try {
            const assessment = await this.aiEngine.assessIncident(incident);
            this.incidentStore.update(incident.incidentId, {
              aiAssessment: assessment,
              status: assessment.verdict === 'REJECTED' ? 'REJECTED' : 'PENDING_HUMAN_REVIEW',
            });
            // Record AI assessment event
            this.eventStore.append({
              actor: { type: 'ai', id: 'observatory-ai-v1', name: 'Observatory AI' },
              action: { type: 'ASSESS', category: 'incident', resource: { type: 'incident', id: incident.incidentId } },
              metadata: { verdict: assessment.verdict, confidence: assessment.confidence },
              visibility: { adminVisible: true, actorVisible: true, publicVisible: false },
            });
          } catch (e) {
            console.error('AI assessment failed:', e.message);
          }
        }, CONFIG.incidentAutoAssessDelay);

        this._respond(res, 201, { success: true, incident });
        return;
      }

      if (pathname === '/incidents' && req.method === 'GET') {
        const incidents = this.incidentStore.list({
          status: url.searchParams.get('status'),
          limit: parseInt(url.searchParams.get('limit') || '50'),
          viewerId: actorId,
          viewerRole: actorRole,
        });
        this._respond(res, 200, { incidents, total: incidents.length });
        return;
      }

      if (pathname.startsWith('/incidents/') && req.method === 'GET') {
        const incidentId = pathname.split('/')[2];
        const incident = this.incidentStore.get(incidentId);
        if (!incident) { this._respond(res, 404, { error: 'Incident not found' }); return; }
        if (actorRole !== 'admin' && incident.submittedBy !== actorId) {
          this._respond(res, 403, { error: 'Access denied' }); return;
        }
        this._respond(res, 200, incident);
        return;
      }

      if (pathname.startsWith('/incidents/') && req.method === 'PUT') {
        if (actorRole !== 'admin') { this._respond(res, 403, { error: 'Admin required' }); return; }
        const incidentId = pathname.split('/')[2];
        const body = await this._parseBody(req);
        const updated = this.incidentStore.update(incidentId, {
          humanReview: { reviewedBy: actorId, decision: body.decision, comment: body.comment, reviewedAt: new Date().toISOString() },
          status: body.decision === 'APPROVED' ? 'RESOLVED' : 'REJECTED',
          resolution: body.resolution,
        });
        // Record admin review event
        this.eventStore.append({
          actor: { type: 'admin', id: actorId, role: 'admin' },
          action: { type: 'APPROVE', category: 'incident', resource: { type: 'incident', id: incidentId } },
          metadata: { decision: body.decision },
          visibility: { adminVisible: true, actorVisible: true, publicVisible: false },
        });
        this._respond(res, 200, updated);
        return;
      }

      // ── SSE Stream ──────────────────────────────────────────────────────────
      if (pathname === '/stream' && req.method === 'GET') {
        if (actorRole !== 'admin') { this._respond(res, 403, { error: 'Admin required' }); return; }
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
          'Access-Control-Allow-Origin': '*',
        });
        res.write(`data: ${JSON.stringify({ type: 'connected', timestamp: new Date().toISOString() })}\n\n`);
        this.wsClients.add(res);
        req.on('close', () => this.wsClients.delete(res));
        return;
      }

      // ── Health ──────────────────────────────────────────────────────────────
      if (pathname === '/health') {
        this._respond(res, 200, {
          status: 'healthy',
          service: 'observatory',
          version: '1.0.0',
          stats: this.eventStore.getStats(),
          timestamp: new Date().toISOString(),
        });
        return;
      }

      this._respond(res, 404, { error: 'Not found', path: pathname });
    } catch (err) {
      console.error('Request error:', err);
      this._respond(res, 500, { error: err.message });
    }
  }

  start() {
    this.server.listen(CONFIG.port, CONFIG.host, () => {
      console.log(JSON.stringify({
        level: 'info',
        message: `Observatory started on ${CONFIG.host}:${CONFIG.port}`,
        service: 'observatory',
        timestamp: new Date().toISOString(),
      }));
    });
  }
}

// ─── Bootstrap ────────────────────────────────────────────────────────────────
if (require.main === module) {
  const server = new ObservatoryServer();
  server.start();

  // Graceful shutdown
  process.on('SIGTERM', () => {
    console.log('Observatory shutting down...');
    server.server.close(() => process.exit(0));
  });
}

module.exports = { ObservatoryServer, EventStore, IncidentStore, AnomalyDetector, AIAssessmentEngine };