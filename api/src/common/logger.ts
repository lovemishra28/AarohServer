type Level = 'info' | 'warn' | 'error';

/**
 * Minimal structured (single-line JSON) logger. Keeping logs machine-parseable
 * from day one means we can trace a request end-to-end via `requestId` later.
 *
 * The first argument is an **event name** — a stable, greppable snake_case token
 * like `db_ping_failed`, not a human sentence — so it gets its own `event` field.
 * Free-form text belongs in `meta`. That is why `message` is deliberately *not*
 * a reserved key: passing an error's `.message` through is the most common thing
 * a call site does, and when `message` doubled as the event name it silently
 * overwrote it, so failures logged without the token you would alert on.
 */
function emit(level: Level, event: string, meta: Record<string, unknown> = {}): void {
  const ts = new Date().toISOString();
  const entry: Record<string, unknown> = { ts, level, event, ...meta };
  // If `meta` carried a reserved key it just overwrote ours, so put ours back.
  // Assigning an existing key keeps its original position: `ts` stays first.
  Object.assign(entry, { ts, level, event });

  const line = JSON.stringify(entry);
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

export const logger = {
  info: (event: string, meta?: Record<string, unknown>) => emit('info', event, meta),
  warn: (event: string, meta?: Record<string, unknown>) => emit('warn', event, meta),
  error: (event: string, meta?: Record<string, unknown>) => emit('error', event, meta),
};
