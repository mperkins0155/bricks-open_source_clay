import { useRef, useState } from 'react';
import { useDataStore } from '@/stores/useDataStore';
import { toast } from '@/hooks/use-toast';
import { runAIAgents } from '@/lib/aiAgents';
import {
  getEnrichmentSettings,
  mapWithConcurrency,
  withRetry,
  looksLikeErrorResult,
  isRetryableResult,
  type ConcurrencyProgress,
} from '@/lib/enrichment/runner';
import {
  acquireRateToken,
  penalizeProvider,
  detectFormulaProvider,
} from '@/lib/enrichment/rateLimiter';

export interface UseFormulaExecutionReturn {
  executingColumn: string | null;
  executingCells: Set<string>;
  progress: ConcurrencyProgress | null;
  executeFormula: (column: string) => Promise<void>;
  executeFailedCells: (column: string) => Promise<void>;
  cancelExecution: () => void;
  executeCellFormula: (rowIndex: number, column: string) => Promise<void>;
}

const isAbort = (e: unknown): boolean =>
  e instanceof DOMException ? e.name === 'AbortError' : e instanceof Error && e.name === 'AbortError';

/**
 * Custom hook for managing formula execution on columns and individual cells.
 *
 * Column runs use bounded concurrency (so we don't detonate provider rate
 * limits), per-row retry with exponential backoff + server Retry-After,
 * optional skip of already-enriched cells, cancellation, and live progress.
 * Soft "Error:" string results returned by generated formulas are correctly
 * counted as failures.
 */
export const useFormulaExecution = (): UseFormulaExecutionReturn => {
  const { rows, getFormula, updateCell, setLoading, executeFormulaOnCell } = useDataStore();
  const [executingColumn, setExecutingColumn] = useState<string | null>(null);
  const [executingCells, setExecutingCells] = useState<Set<string>>(new Set());
  const [progress, setProgress] = useState<ConcurrencyProgress | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const runRowFormula = async (formula: string, row: Record<string, string>): Promise<string> => {
    const asyncFunction = new Function(
      'row',
      'runAIAgents',
      `return (async () => {\n${formula}\n})();`,
    );
    const result = await asyncFunction(row, runAIAgents);
    return result !== null && result !== undefined ? String(result) : '';
  };

  const cancelExecution = () => {
    abortRef.current?.abort();
  };

  /**
   * Shared column runner. `onlyFailed` restricts the run to empty / errored
   * cells (used by "retry failed"); otherwise honors the skip-filled setting.
   */
  const runColumn = async (column: string, opts: { onlyFailed: boolean }) => {
    const formula = getFormula(column);
    if (!formula.trim()) {
      toast({
        title: 'No Formula',
        description: `Column "${column}" doesn't have a formula defined.`,
        variant: 'destructive',
      });
      return;
    }

    const settings = getEnrichmentSettings();
    const controller = new AbortController();
    abortRef.current = controller;

    // Build the working set: every row, tagged with whether it should run.
    const targets = rows
      .map((row, index) => ({ row, index }))
      .filter(({ row }) => {
        const existing = row[column];
        const filled = existing && existing.trim() && !looksLikeErrorResult(existing);
        if (opts.onlyFailed) return !filled; // only empty / errored cells
        return !(settings.skipFilled && filled); // skip-filled honors setting
      });

    const totalSkipped = rows.length - targets.length;
    const providerKey = detectFormulaProvider(formula);

    if (targets.length === 0) {
      toast({
        title: opts.onlyFailed ? 'Nothing to Retry' : 'Nothing to Enrich',
        description: opts.onlyFailed
          ? `All cells in "${column}" already have values.`
          : `All ${rows.length} cells are already enriched. Toggle "skip already-enriched" off to re-run.`,
      });
      return;
    }

    setExecutingColumn(column);
    setLoading(true);
    setProgress({ completed: 0, total: targets.length, succeeded: 0, failed: 0, skipped: totalSkipped });

    try {
      const results = await mapWithConcurrency(
        targets,
        async ({ row, index }) => {
          // Pace requests per provider so we don't burst into a 429.
          await acquireRateToken(providerKey, controller.signal);
          const value = await withRetry(() => runRowFormula(formula, row), {
            maxRetries: settings.maxRetries,
            signal: controller.signal,
            shouldRetryResult: (v) => typeof v === 'string' && isRetryableResult(v),
            // A rate-limit on one row pauses the whole provider bucket.
            onRetry: (_attempt, delayMs) => penalizeProvider(providerKey, delayMs),
          });
          if (looksLikeErrorResult(value)) {
            updateCell(index, column, value);
            throw new Error(value);
          }
          updateCell(index, column, value);
          return true;
        },
        {
          concurrency: settings.concurrency,
          signal: controller.signal,
          onProgress: (p) => setProgress({ ...p, skipped: totalSkipped }),
        },
      );

      if (controller.signal.aborted) {
        const done = results.filter(Boolean).length;
        toast({
          title: 'Enrichment Stopped',
          description: `Cancelled after ${done}/${targets.length} rows. Already-processed cells are kept.`,
          variant: 'destructive',
        });
        return;
      }

      const failures = results.filter((r) => !r.ok).length;
      const succeeded = results.filter((r) => r.ok).length;

      // Mark failed cells that never got any value written.
      results.forEach((r, i) => {
        if (!r.ok && !targets[i].row[column]) updateCell(targets[i].index, column, 'ERROR');
      });

      const parts = [`${succeeded} enriched`];
      if (totalSkipped > 0) parts.push(`${totalSkipped} skipped`);
      if (failures > 0) parts.push(`${failures} failed`);

      toast({
        title: failures === 0 ? 'Enrichment Complete' : 'Enrichment Finished With Errors',
        description: parts.join(' · ') + (failures > 0 ? ' · use "Retry failed" to re-run them.' : '.'),
        variant: failures === 0 ? 'default' : 'destructive',
      });
    } catch (error) {
      if (isAbort(error)) return;
      console.error('Error executing formula:', error);
      toast({
        title: 'Execution Error',
        description: error instanceof Error ? error.message : 'Failed to execute formula.',
        variant: 'destructive',
      });
    } finally {
      abortRef.current = null;
      setExecutingColumn(null);
      setLoading(false);
      setProgress(null);
    }
  };

  const executeFormula = (column: string) => runColumn(column, { onlyFailed: false });
  const executeFailedCells = (column: string) => runColumn(column, { onlyFailed: true });

  /**
   * Execute formula on a single cell, with retry on transient failure.
   */
  const executeCellFormula = async (rowIndex: number, column: string) => {
    const cellKey = `${rowIndex}-${column}`;
    setExecutingCells((prev) => new Set(prev).add(cellKey));
    const settings = getEnrichmentSettings();

    try {
      await withRetry(() => executeFormulaOnCell(rowIndex, column, { runAIAgents }), {
        maxRetries: settings.maxRetries,
      });
      toast({
        title: 'Cell Updated',
        description: `Cell ${column} in row ${rowIndex + 1} has been updated.`,
      });
    } catch (error) {
      console.error('Error executing cell formula:', error);
      toast({
        title: 'Execution Error',
        description: error instanceof Error ? error.message : 'Failed to execute formula on this cell.',
        variant: 'destructive',
      });
    } finally {
      setExecutingCells((prev) => {
        const newSet = new Set(prev);
        newSet.delete(cellKey);
        return newSet;
      });
    }
  };

  return {
    executingColumn,
    executingCells,
    progress,
    executeFormula,
    executeFailedCells,
    cancelExecution,
    executeCellFormula,
  };
};
