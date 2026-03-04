/**
 * Observatory Event Schema Definitions
 * Canonical schema for all events flowing through the Trancendos Ecosystem.
 */

'use strict';

// ─── Action Types ─────────────────────────────────────────────────────────────
const ACTION_TYPES = {
  // Auth
  LOGIN: 'LOGIN',
  LOGOUT: 'LOGOUT',
  LOGIN_FAILED: 'LOGIN_FAILED',
  SESSION_EXPIRED: 'SESSION_EXPIRED',
  PASSWORD_CHANGED: 'PASSWORD_CHANGED',
  MFA_ENABLED: 'MFA_ENABLED',
  MFA_DISABLED: 'MFA_DISABLED',

  // CRUD
  CREATE: 'CREATE',
  READ: 'READ',
  UPDATE: 'UPDATE',
  DELETE: 'DELETE',

  // Workflow
  SUBMIT: 'SUBMIT',
  APPROVE: 'APPROVE',
  REJECT: 'REJECT',
  PUBLISH: 'PUBLISH',
  UNPUBLISH: 'UNPUBLISH',
  ARCHIVE: 'ARCHIVE',

  // System
  DEPLOY: 'DEPLOY',
  ROLLBACK: 'ROLLBACK',
  SCALE: 'SCALE',
  RESTART: 'RESTART',
  CONFIG_CHANGE: 'CONFIG_CHANGE',

  // Security
  ANOMALY_DETECTED: 'ANOMALY_DETECTED',
  CVE_DETECTED: 'CVE_DETECTED',
  CVE_REMEDIATED: 'CVE_REMEDIATED',
  CVE_ROLLED_BACK: 'CVE_ROLLED_BACK',
  THREAT_DETECTED: 'THREAT_DETECTED',
  SAMPLE_SUBMITTED: 'SAMPLE_SUBMITTED',
  SAMPLE_ANALYSED: 'SAMPLE_ANALYSED',

  // Knowledge
  ARTICLE_GENERATED: 'ARTICLE_GENERATED',
  ARTICLE_VALIDATED: 'ARTICLE_VALIDATED',
  ARTICLE_APPROVED: 'ARTICLE_APPROVED',
  ARTICLE_REJECTED: 'ARTICLE_REJECTED',
  MODULE_GENERATED: 'MODULE_GENERATED',
  MODULE_APPROVED: 'MODULE_APPROVED',

  // AI
  AI_COMMENT: 'AI_COMMENT',
  AI_EDIT: 'AI_EDIT',
  AI_ASSESS: 'ASSESS',
  AI_GENERATE: 'AI_GENERATE',
};

// ─── Categories ───────────────────────────────────────────────────────────────
const CATEGORIES = {
  AUTH: 'auth',
  MICROSERVICE: 'microservice',
  KB: 'kb',
  WIKI: 'wiki',
  ACADEMY: 'academy',
  CRYPTEX: 'cryptex',
  ICEBOX: 'icebox',
  INCIDENT: 'incident',
  ADMIN: 'admin',
  SECURITY: 'security',
  SYSTEM: 'system',
};

// ─── Actor Types ──────────────────────────────────────────────────────────────
const ACTOR_TYPES = {
  USER: 'user',
  ADMIN: 'admin',
  AI: 'ai',
  SYSTEM: 'system',
  WORKFLOW: 'workflow',
};

// ─── Severity Levels ──────────────────────────────────────────────────────────
const SEVERITY = {
  CRITICAL: 'CRITICAL',
  HIGH: 'HIGH',
  MEDIUM: 'MEDIUM',
  LOW: 'LOW',
  INFO: 'INFO',
};

// ─── Schema Validator ─────────────────────────────────────────────────────────
class EventSchemaValidator {
  validate(eventData) {
    const errors = [];

    // Required: actor
    if (!eventData.actor) {
      errors.push('actor is required');
    } else {
      if (!eventData.actor.type) errors.push('actor.type is required');
      if (!eventData.actor.id) errors.push('actor.id is required');
      if (!Object.values(ACTOR_TYPES).includes(eventData.actor.type)) {
        errors.push(`actor.type must be one of: ${Object.values(ACTOR_TYPES).join(', ')}`);
      }
    }

    // Required: action
    if (!eventData.action) {
      errors.push('action is required');
    } else {
      if (!eventData.action.type) errors.push('action.type is required');
      if (!eventData.action.category) errors.push('action.category is required');
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }

  /**
   * Build a standardised event payload
   */
  build(params) {
    const { actor, action, diff, metadata, visibility } = params;

    return {
      actor: {
        type: actor.type || ACTOR_TYPES.SYSTEM,
        id: actor.id || 'unknown',
        name: actor.name || actor.id || 'Unknown',
        role: actor.role || 'user',
        sessionId: actor.sessionId || null,
        ipAddress: actor.ipAddress || null,
      },
      action: {
        type: action.type,
        category: action.category,
        resource: action.resource ? {
          type: action.resource.type,
          id: action.resource.id,
          name: action.resource.name || action.resource.id,
        } : null,
        description: action.description || null,
      },
      diff: diff ? {
        before: diff.before || null,
        after: diff.after || null,
        changedFields: diff.changedFields || [],
      } : null,
      metadata: {
        platform: metadata?.platform || 'trancendos',
        environment: metadata?.environment || process.env.NODE_ENV || 'development',
        correlationId: metadata?.correlationId || null,
        severity: metadata?.severity || SEVERITY.INFO,
        tags: metadata?.tags || [],
        ...metadata,
      },
      visibility: {
        adminVisible: visibility?.adminVisible !== false,
        actorVisible: visibility?.actorVisible !== false,
        publicVisible: visibility?.publicVisible === true,
      },
    };
  }
}

// ─── Pre-built Event Builders ─────────────────────────────────────────────────
const Events = {
  userLogin: (actorId, actorName, ipAddress, success = true) => ({
    actor: { type: ACTOR_TYPES.USER, id: actorId, name: actorName, ipAddress },
    action: { type: success ? ACTION_TYPES.LOGIN : ACTION_TYPES.LOGIN_FAILED, category: CATEGORIES.AUTH },
    metadata: { severity: success ? SEVERITY.INFO : SEVERITY.MEDIUM },
    visibility: { adminVisible: true, actorVisible: true, publicVisible: false },
  }),

  userLogout: (actorId, actorName) => ({
    actor: { type: ACTOR_TYPES.USER, id: actorId, name: actorName },
    action: { type: ACTION_TYPES.LOGOUT, category: CATEGORIES.AUTH },
    metadata: { severity: SEVERITY.INFO },
    visibility: { adminVisible: true, actorVisible: true, publicVisible: false },
  }),

  resourceCreated: (actor, resourceType, resourceId, resourceName, data) => ({
    actor,
    action: { type: ACTION_TYPES.CREATE, category: CATEGORIES.MICROSERVICE, resource: { type: resourceType, id: resourceId, name: resourceName } },
    diff: { before: null, after: data, changedFields: Object.keys(data || {}) },
    metadata: { severity: SEVERITY.INFO },
    visibility: { adminVisible: true, actorVisible: true, publicVisible: false },
  }),

  resourceUpdated: (actor, resourceType, resourceId, before, after) => ({
    actor,
    action: { type: ACTION_TYPES.UPDATE, category: CATEGORIES.MICROSERVICE, resource: { type: resourceType, id: resourceId } },
    diff: {
      before,
      after,
      changedFields: Object.keys(after || {}).filter(k => JSON.stringify(before?.[k]) !== JSON.stringify(after?.[k])),
    },
    metadata: { severity: SEVERITY.INFO },
    visibility: { adminVisible: true, actorVisible: true, publicVisible: false },
  }),

  resourceDeleted: (actor, resourceType, resourceId, resourceName, snapshot) => ({
    actor,
    action: { type: ACTION_TYPES.DELETE, category: CATEGORIES.MICROSERVICE, resource: { type: resourceType, id: resourceId, name: resourceName } },
    diff: { before: snapshot, after: null, changedFields: ['*'] },
    metadata: { severity: SEVERITY.MEDIUM },
    visibility: { adminVisible: true, actorVisible: true, publicVisible: false },
  }),

  adminConfigChange: (adminId, adminName, configKey, before, after) => ({
    actor: { type: ACTOR_TYPES.ADMIN, id: adminId, name: adminName, role: 'admin' },
    action: { type: ACTION_TYPES.CONFIG_CHANGE, category: CATEGORIES.ADMIN, resource: { type: 'config', id: configKey } },
    diff: { before, after, changedFields: [configKey] },
    metadata: { severity: SEVERITY.HIGH },
    visibility: { adminVisible: true, actorVisible: false, publicVisible: false },
  }),

  cveDetected: (cveId, severity, affectedPackage, repo) => ({
    actor: { type: ACTOR_TYPES.SYSTEM, id: 'cryptex', name: 'Cryptex CVE Scanner' },
    action: { type: ACTION_TYPES.CVE_DETECTED, category: CATEGORIES.CRYPTEX, resource: { type: 'cve', id: cveId } },
    metadata: { severity: severity === 'CRITICAL' ? SEVERITY.CRITICAL : SEVERITY.HIGH, cveId, affectedPackage, repo },
    visibility: { adminVisible: true, actorVisible: false, publicVisible: false },
  }),

  cveRemediated: (cveId, snapshotId, runId) => ({
    actor: { type: ACTOR_TYPES.SYSTEM, id: 'cryptex', name: 'Cryptex Auto-Manager' },
    action: { type: ACTION_TYPES.CVE_REMEDIATED, category: CATEGORIES.CRYPTEX, resource: { type: 'cve', id: cveId } },
    metadata: { severity: SEVERITY.INFO, snapshotId, runId },
    visibility: { adminVisible: true, actorVisible: false, publicVisible: false },
  }),

  cveRolledBack: (cveId, snapshotId, reason) => ({
    actor: { type: ACTOR_TYPES.SYSTEM, id: 'cryptex', name: 'Cryptex Rollback Engine' },
    action: { type: ACTION_TYPES.CVE_ROLLED_BACK, category: CATEGORIES.CRYPTEX, resource: { type: 'cve', id: cveId } },
    metadata: { severity: SEVERITY.HIGH, snapshotId, reason },
    visibility: { adminVisible: true, actorVisible: false, publicVisible: false },
  }),

  sampleSubmitted: (submitterId, sampleHash, sampleType) => ({
    actor: { type: ACTOR_TYPES.USER, id: submitterId },
    action: { type: ACTION_TYPES.SAMPLE_SUBMITTED, category: CATEGORIES.ICEBOX, resource: { type: 'sample', id: sampleHash } },
    metadata: { severity: SEVERITY.INFO, sampleType },
    visibility: { adminVisible: true, actorVisible: true, publicVisible: false },
  }),

  articleGenerated: (aiAgentId, articleId, articleTitle, source) => ({
    actor: { type: ACTOR_TYPES.AI, id: aiAgentId, name: 'KB Author AI' },
    action: { type: ACTION_TYPES.ARTICLE_GENERATED, category: CATEGORIES.KB, resource: { type: 'article', id: articleId, name: articleTitle } },
    metadata: { severity: SEVERITY.INFO, source },
    visibility: { adminVisible: true, actorVisible: false, publicVisible: false },
  }),

  articleApproved: (adminId, adminName, articleId, articleTitle) => ({
    actor: { type: ACTOR_TYPES.ADMIN, id: adminId, name: adminName, role: 'admin' },
    action: { type: ACTION_TYPES.ARTICLE_APPROVED, category: CATEGORIES.KB, resource: { type: 'article', id: articleId, name: articleTitle } },
    metadata: { severity: SEVERITY.INFO },
    visibility: { adminVisible: true, actorVisible: false, publicVisible: false },
  }),

  moduleApproved: (adminId, adminName, moduleId, moduleTitle) => ({
    actor: { type: ACTOR_TYPES.ADMIN, id: adminId, name: adminName, role: 'admin' },
    action: { type: ACTION_TYPES.MODULE_APPROVED, category: CATEGORIES.ACADEMY, resource: { type: 'module', id: moduleId, name: moduleTitle } },
    metadata: { severity: SEVERITY.INFO },
    visibility: { adminVisible: true, actorVisible: false, publicVisible: false },
  }),

  deploymentEvent: (service, version, environment, deployedBy) => ({
    actor: { type: ACTOR_TYPES.WORKFLOW, id: 'github-actions', name: 'GitHub Actions' },
    action: { type: ACTION_TYPES.DEPLOY, category: CATEGORIES.SYSTEM, resource: { type: 'service', id: service, name: service } },
    metadata: { severity: SEVERITY.INFO, version, environment, deployedBy },
    visibility: { adminVisible: true, actorVisible: false, publicVisible: false },
  }),
};

module.exports = {
  ACTION_TYPES,
  CATEGORIES,
  ACTOR_TYPES,
  SEVERITY,
  EventSchemaValidator,
  Events,
};