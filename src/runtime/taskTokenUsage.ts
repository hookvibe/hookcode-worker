export interface TaskTokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const toNonNegativeInt = (value: unknown): number | null => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const num = Math.floor(value);
  return num >= 0 ? num : null;
};

const parseJsonLine = (line: string): Record<string, unknown> | null => {
  const trimmed = String(line ?? '').trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return null;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

export const extractCodexExecTokenUsageDeltaFromLine = (line: string): TaskTokenUsage | null => {
  const parsed = parseJsonLine(line);
  if (!parsed || parsed.type !== 'turn.completed' || !isRecord(parsed.usage)) return null;

  const input = toNonNegativeInt(parsed.usage.input_tokens);
  const output = toNonNegativeInt(parsed.usage.output_tokens);
  if (input === null && output === null) return null;

  const inputTokens = input ?? 0;
  const outputTokens = output ?? 0;
  if (inputTokens === 0 && outputTokens === 0) return null;
  return { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens };
};

export const extractClaudeCodeExecTokenUsageDeltaFromLine = (line: string): TaskTokenUsage | null => {
  const parsed = parseJsonLine(line);
  if (!parsed || parsed.type !== 'result' || !isRecord(parsed.usage)) return null;

  const input = toNonNegativeInt(parsed.usage.input_tokens);
  const output = toNonNegativeInt(parsed.usage.output_tokens);
  if (input === null && output === null) return null;

  const inputTokens = input ?? 0;
  const outputTokens = output ?? 0;
  if (inputTokens === 0 && outputTokens === 0) return null;
  return { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens };
};

export const extractGeminiCliExecTokenUsageDeltaFromLine = (line: string): TaskTokenUsage | null => {
  const parsed = parseJsonLine(line);
  if (!parsed || parsed.type !== 'result' || !isRecord(parsed.stats)) return null;

  const input = toNonNegativeInt(parsed.stats.input_tokens);
  const output = toNonNegativeInt(parsed.stats.output_tokens);
  if (input === null && output === null) return null;

  const inputTokens = input ?? 0;
  const outputTokens = output ?? 0;
  if (inputTokens === 0 && outputTokens === 0) return null;
  return { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens };
};

export const addTaskTokenUsage = (prev: TaskTokenUsage | undefined, delta: TaskTokenUsage): TaskTokenUsage => {
  const prevInput = typeof prev?.inputTokens === 'number' && Number.isFinite(prev.inputTokens) ? prev.inputTokens : 0;
  const prevOutput = typeof prev?.outputTokens === 'number' && Number.isFinite(prev.outputTokens) ? prev.outputTokens : 0;
  const nextInput = prevInput + delta.inputTokens;
  const nextOutput = prevOutput + delta.outputTokens;
  return { inputTokens: nextInput, outputTokens: nextOutput, totalTokens: nextInput + nextOutput };
};
