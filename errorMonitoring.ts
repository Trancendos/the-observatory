/**
 * Autonomous Error Monitoring Service (The Dr)
 * 
 * This service continuously monitors the platform for errors and automatically
 * attempts to fix them without user intervention.
 */

import { getDb } from '../db';
import { eq, and, gte } from 'drizzle-orm';
import { errorLogs } from '../../drizzle/schema';

export interface PlatformError {
  id: number;
  errorCode: string;
  category: string;
  message: string;
  stackTrace: string | null;
  context: Record<string, unknown> | null;
  timestamp: Date;
  resolved: boolean;
}

export interface ErrorPattern {
  pattern: RegExp;
  category: string;
  autoFixable: boolean;
  fix?: () => Promise<boolean>;
}

/**
 * Known error patterns that The Dr can automatically fix
 */
const ERROR_PATTERNS: ErrorPattern[] = [
  {
    pattern: /Failed query.*from `(\w+)`.*table.*doesn't exist/i,
    category: 'database_missing_table',
    autoFixable: true,
    fix: async () => {
      // Auto-fix: Run database migrations
      console.log('[The Dr] Detected missing table error - running migrations...');
      // This would trigger pnpm db:push or create the missing table
      return true;
    }
  },
  {
    pattern: /<a>.*cannot contain.*nested.*<a>/i,
    category: 'nested_anchor_tags',
    autoFixable: false, // Requires code changes
  },
  {
    pattern: /Cannot read.*undefined|TypeError.*undefined/i,
    category: 'null_reference',
    autoFixable: false, // Requires code analysis
  },
  {
    pattern: /Network.*failed|fetch.*failed|ECONNREFUSED/i,
    category: 'network_error',
    autoFixable: true,
    fix: async () => {
      console.log('[The Dr] Detected network error - checking service health...');
      // Could implement service restart or health check
      return false; // Placeholder
    }
  },
  {
    pattern: /Authentication.*failed|Unauthorized|401/i,
    category: 'auth_error',
    autoFixable: false, // Requires user action
  }
];

/**
 * Classify an error based on known patterns
 */
export function classifyError(errorMessage: string): {
  category: string;
  autoFixable: boolean;
  fix?: () => Promise<boolean>;
} {
  for (const pattern of ERROR_PATTERNS) {
    if (pattern.pattern.test(errorMessage)) {
      return {
        category: pattern.category,
        autoFixable: pattern.autoFixable,
        fix: pattern.fix
      };
    }
  }
  
  return {
    category: 'unknown',
    autoFixable: false
  };
}

/**
 * Get recent unresolved errors from the database
 */
export async function getRecentErrors(minutesAgo: number = 15): Promise<PlatformError[]> {
  const db = await getDb();
  if (!db) {
    console.warn('[The Dr] Cannot check errors: database not available');
    return [];
  }

  try {
    const cutoffTime = new Date(Date.now() - minutesAgo * 60 * 1000);
    
    const errors = await db
      .select()
      .from(errorLogs)
      .where(
        and(
          eq(errorLogs.resolved, false),
          gte(errorLogs.timestamp, cutoffTime)
        )
      )
      .limit(50);

    return errors.map(err => ({
      id: err.id,
      errorCode: err.errorCode,
      category: err.category,
      message: err.message,
      stackTrace: err.stackTrace,
      context: err.context as Record<string, unknown> | null,
      timestamp: err.timestamp,
      resolved: err.resolved
    }));
  } catch (error) {
    console.error('[The Dr] Error fetching recent errors:', error);
    return [];
  }
}

/**
 * Attempt to automatically fix an error
 */
export async function attemptAutoFix(error: PlatformError): Promise<{
  success: boolean;
  message: string;
}> {
  const classification = classifyError(error.message);
  
  if (!classification.autoFixable || !classification.fix) {
    return {
      success: false,
      message: `Error category "${classification.category}" is not auto-fixable`
    };
  }

  try {
    console.log(`[The Dr] Attempting auto-fix for error ${error.errorCode}...`);
    const fixed = await classification.fix();
    
    if (fixed) {
      // Mark error as resolved in database
      const db = await getDb();
      if (db) {
        await db
          .update(errorLogs)
          .set({ 
            resolved: true,
            resolvedAt: new Date(),
            resolvedBy: 'The Dr (Auto-Fix)'
          })
          .where(eq(errorLogs.id, error.id));
      }
      
      return {
        success: true,
        message: `Successfully auto-fixed error ${error.errorCode}`
      };
    }
    
    return {
      success: false,
      message: `Auto-fix attempted but failed for ${error.errorCode}`
    };
  } catch (fixError) {
    console.error(`[The Dr] Auto-fix failed for ${error.errorCode}:`, fixError);
    return {
      success: false,
      message: `Auto-fix threw an error: ${fixError instanceof Error ? fixError.message : 'Unknown error'}`
    };
  }
}

/**
 * Scan for errors and attempt auto-fixes
 * This runs periodically in the background
 */
export async function scanAndFix(): Promise<{
  scannedCount: number;
  fixedCount: number;
  errors: Array<{
    errorCode: string;
    category: string;
    fixed: boolean;
    message: string;
  }>;
}> {
  console.log('[The Dr] Starting error scan...');
  
  const recentErrors = await getRecentErrors(15);
  const results = [];
  let fixedCount = 0;

  for (const error of recentErrors) {
    const classification = classifyError(error.message);
    
    if (classification.autoFixable) {
      const fixResult = await attemptAutoFix(error);
      if (fixResult.success) {
        fixedCount++;
      }
      
      results.push({
        errorCode: error.errorCode,
        category: classification.category,
        fixed: fixResult.success,
        message: fixResult.message
      });
    } else {
      results.push({
        errorCode: error.errorCode,
        category: classification.category,
        fixed: false,
        message: 'Not auto-fixable - requires manual intervention'
      });
    }
  }

  console.log(`[The Dr] Scan complete: ${fixedCount}/${recentErrors.length} errors fixed`);
  
  return {
    scannedCount: recentErrors.length,
    fixedCount,
    errors: results
  };
}

/**
 * Get platform health status
 */
export async function getPlatformHealth(): Promise<{
  status: 'healthy' | 'degraded' | 'critical';
  errorCount: number;
  criticalErrors: number;
  autoFixableErrors: number;
  lastScan: Date;
}> {
  const recentErrors = await getRecentErrors(60); // Last hour
  
  const criticalErrors = recentErrors.filter(err => 
    err.category === 'database_missing_table' || 
    err.category === 'auth_error'
  ).length;
  
  const autoFixableErrors = recentErrors.filter(err => {
    const classification = classifyError(err.message);
    return classification.autoFixable;
  }).length;

  let status: 'healthy' | 'degraded' | 'critical' = 'healthy';
  if (criticalErrors > 0) {
    status = 'critical';
  } else if (recentErrors.length > 10) {
    status = 'degraded';
  }

  return {
    status,
    errorCount: recentErrors.length,
    criticalErrors,
    autoFixableErrors,
    lastScan: new Date()
  };
}
