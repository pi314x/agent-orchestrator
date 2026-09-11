import type { Db } from '../db/sqlite.js';
import { OrchestratorError } from '../errors.js';

export const BUDGET_SCOPES = ['global', 'agent', 'job'] as const;
export type BudgetScope = (typeof BUDGET_SCOPES)[number];

export type BudgetRecord = {
  scope: BudgetScope;
  scopeId?: string;
  maxCostUsd?: number;
  maxTokens?: number;
  maxCalls?: number;
  maxConcurrent?: number;
  createdAt: string;
  updatedAt: string;
};

export type BudgetSpend = {
  costUsd: number;
  tokens: number;
  calls: number;
};

export interface SetBudgetInput {
  scope: BudgetScope;
  scopeId?: string;
  maxCostUsd?: number;
  maxTokens?: number;
  maxCalls?: number;
  maxConcurrent?: number;
}

type BudgetRow = {
  id: string;
  scope: string;
  scope_id: string;
  max_cost_usd: number | null;
  max_tokens: number | null;
  max_calls: number | null;
  max_concurrent: number | null;
  created_at: string;
  updated_at: string;
};

function toRecord(row: BudgetRow): BudgetRecord {
  return {
    scope: row.scope as BudgetScope,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.scope_id !== '' && { scopeId: row.scope_id }),
    ...(row.max_cost_usd !== null && { maxCostUsd: row.max_cost_usd }),
    ...(row.max_tokens !== null && { maxTokens: row.max_tokens }),
    ...(row.max_calls !== null && { maxCalls: row.max_calls }),
    ...(row.max_concurrent !== null && { maxConcurrent: row.max_concurrent })
  };
}

/**
 * Caps are checked before work starts, not only at submit time, so a long
 * fan-out cannot overshoot between the first and last call.
 */
export class BudgetTracker {
  constructor(private readonly db: Db) {}

  set(input: SetBudgetInput): BudgetRecord {
    const scopeId = input.scopeId ?? '';
    const now = new Date().toISOString();

    this.db
      .prepare(
        `INSERT INTO budgets (id, scope, scope_id, max_cost_usd, max_tokens, max_calls, max_concurrent, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (scope, scope_id) DO UPDATE SET
           max_cost_usd = excluded.max_cost_usd,
           max_tokens = excluded.max_tokens,
           max_calls = excluded.max_calls,
           max_concurrent = excluded.max_concurrent,
           updated_at = excluded.updated_at`
      )
      .run(
        `${input.scope}:${scopeId}`,
        input.scope,
        scopeId,
        input.maxCostUsd ?? null,
        input.maxTokens ?? null,
        input.maxCalls ?? null,
        input.maxConcurrent ?? null,
        now,
        now
      );

    const found = this.get(input.scope, input.scopeId);
    if (found === undefined) throw new Error('budget write did not persist');
    return found;
  }

  get(scope: BudgetScope, scopeId?: string): BudgetRecord | undefined {
    const row = this.db
      .prepare('SELECT * FROM budgets WHERE scope = ? AND scope_id = ?')
      .get(scope, scopeId ?? '') as BudgetRow | undefined;
    return row === undefined ? undefined : toRecord(row);
  }

  list(): BudgetRecord[] {
    const rows = this.db.prepare('SELECT * FROM budgets ORDER BY scope, scope_id').all() as BudgetRow[];
    return rows.map(toRecord);
  }

  /** Spend is derived from recorded job usage, so there is no counter to drift. */
  spend(scope: BudgetScope, scopeId?: string): BudgetSpend {
    const where = scope === 'global' ? '1 = 1' : scope === 'agent' ? 'agent_id = ?' : 'id = ?';
    const params = scope === 'global' ? [] : [scopeId ?? ''];

    const rows = this.db
      .prepare(`SELECT usage FROM jobs WHERE ${where} AND usage IS NOT NULL`)
      .all(...params) as { usage: string }[];

    let costUsd = 0;
    let tokens = 0;

    for (const row of rows) {
      const usage = JSON.parse(row.usage) as {
        costUsd?: number;
        inputTokens?: number;
        outputTokens?: number;
      };
      costUsd += usage.costUsd ?? 0;
      tokens += (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
    }

    return { costUsd, tokens, calls: rows.length };
  }

  /**
   * Throws when starting one more unit of work would break a cap. Called from
   * the scheduler before every run, for each scope that applies.
   */
  assertWithinBudget(scope: BudgetScope, scopeId?: string): void {
    const budget = this.get(scope, scopeId);
    if (budget === undefined) return;

    const spent = this.spend(scope, scopeId);
    const label = scope === 'global' ? 'global' : `${scope} ${scopeId ?? ''}`;

    if (budget.maxCostUsd !== undefined && spent.costUsd >= budget.maxCostUsd) {
      throw new OrchestratorError(
        'BUDGET_EXCEEDED',
        `The ${label} cost budget of $${budget.maxCostUsd} is exhausted ($${spent.costUsd.toFixed(4)} spent).`,
        'Raise it with budget_set, or wait for the period to reset.'
      );
    }
    if (budget.maxTokens !== undefined && spent.tokens >= budget.maxTokens) {
      throw new OrchestratorError(
        'BUDGET_EXCEEDED',
        `The ${label} token budget of ${budget.maxTokens} is exhausted (${spent.tokens} used).`,
        'Raise it with budget_set.'
      );
    }
    if (budget.maxCalls !== undefined && spent.calls >= budget.maxCalls) {
      throw new OrchestratorError(
        'BUDGET_EXCEEDED',
        `The ${label} call budget of ${budget.maxCalls} is exhausted.`,
        'Raise it with budget_set.'
      );
    }
  }

  /** Per-scope concurrency cap, checked against jobs currently running. */
  maxConcurrentFor(scope: BudgetScope, scopeId?: string): number | undefined {
    return this.get(scope, scopeId)?.maxConcurrent;
  }
}
