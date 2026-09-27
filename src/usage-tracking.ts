import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

// Anthropic reports three input components that must never be re-added twice:
// inputTokens is the inclusive total (plain + cache creation + cache read), while the
// component columns keep the provider's raw numbers. A missing component stays NULL.
export type UsageAttempt = {
  id: string;
  requestId: string;
  startedAt: number;
  finishedAt: number | null;
  channelId: string;
  channelName: string;
  model: string;
  kind: string;
  outcome: 'pending' | 'success' | 'failed' | 'cancelled' | 'interrupted';
  status: number | null;
  reason: string | null;
  inputTokens: number | null;
  uncachedInputTokens: number | null;
  cacheCreationInputTokens: number | null;
  cacheReadInputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
};

export type AnthropicUsageObservation = Readonly<{
  inputTokens?: unknown;
  outputTokens?: unknown;
  cacheCreationInputTokens?: unknown;
  cacheReadInputTokens?: unknown;
  terminalFailure?: string;
}>;

export type UsageContext = AsyncLocalStorage<{
  requestId: string;
  write: (row: UsageAttempt) => void;
  current?: ReturnType<typeof beginUsageAttempt>;
}>;

function readCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export function createUsageContext(): UsageContext {
  return new AsyncLocalStorage();
}

export function beginUsageAttempt(
  context: UsageContext,
  channel: { id: string; name: string },
  model: string,
  kind: string,
  signal: AbortSignal,
) {
  const store = context.getStore();
  store?.current?.finish();
  const row: UsageAttempt = {
    id: randomUUID(),
    requestId: store?.requestId ?? randomUUID(),
    startedAt: Date.now(),
    finishedAt: null,
    channelId: channel.id,
    channelName: channel.name,
    model,
    kind,
    outcome: 'pending',
    status: null,
    reason: null,
    inputTokens: null,
    uncachedInputTokens: null,
    cacheCreationInputTokens: null,
    cacheReadInputTokens: null,
    outputTokens: null,
    totalTokens: null,
  };
  let finished = false;
  let terminalFailure: string | undefined;
  const observed = { input: null as number | null, creation: null as number | null, read: null as number | null, output: null as number | null };

  function derive(): void {
    row.uncachedInputTokens = observed.input;
    row.cacheCreationInputTokens = observed.creation;
    row.cacheReadInputTokens = observed.read;
    row.outputTokens = observed.output;
    row.inputTokens = observed.input !== null && observed.creation !== null && observed.read !== null
      ? observed.input + observed.creation + observed.read
      : null;
    row.totalTokens = row.inputTokens !== null && row.outputTokens !== null ? row.inputTokens + row.outputTokens : null;
  }

  const attempt = {
    row,
    observe(usage: AnthropicUsageObservation | undefined, status?: number) {
      if (finished) return;
      if (status !== undefined) row.status = status;
      if (usage?.terminalFailure) terminalFailure = usage.terminalFailure;
      if (!usage) return;
      const input = readCount(usage.inputTokens);
      if (input !== null) observed.input = input;
      const creation = readCount(usage.cacheCreationInputTokens);
      if (creation !== null) observed.creation = creation;
      const read = readCount(usage.cacheReadInputTokens);
      if (read !== null) observed.read = read;
      const output = readCount(usage.outputTokens);
      if (output !== null) observed.output = output;
      derive();
    },
    result(outcome: UsageAttempt['outcome'], reason?: string) {
      if (finished) return;
      row.outcome = outcome;
      row.reason = reason ?? null;
    },
    finish() {
      if (finished) return;
      finished = true;
      const abort = signal.reason as { kind?: string; phase?: string } | undefined;
      if (row.outcome !== 'success' && abort?.kind === 'client_disconnect') {
        row.outcome = 'cancelled';
        row.reason = 'client_disconnect';
      } else if (row.outcome !== 'success' && abort?.kind === 'timeout') {
        row.outcome = 'failed';
        row.reason = `timeout:${abort.phase ?? 'unknown'}`;
      } else if (row.outcome === 'pending') {
        row.outcome = 'failed';
        row.reason = 'unfinished_attempt';
      }
      if (terminalFailure && row.outcome === 'success') {
        row.outcome = 'failed';
        row.reason = terminalFailure;
      }
      row.finishedAt = Date.now();
      derive();
      store?.write(row);
    },
  };
  if (store) {
    store.current = attempt;
    store.write(row);
  }
  return attempt;
}
