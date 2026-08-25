type Level = 'info' | 'warn' | 'error';

/**
 * Minimal structured (single-line JSON) logger. Keeping logs machine-parseable
 * from day one means we can trace a request end-to-end via `requestId` later.
 */
function emit(level: Level, message: string, meta: Record<string, unknown> = {}): void {
  const entry = { ts: new Date().toISOString(), level, message, ...meta };
  const line = JSON.stringify(entry);
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

export const logger = {
  info: (message: string, meta?: Record<string, unknown>) => emit('info', message, meta),
  warn: (message: string, meta?: Record<string, unknown>) => emit('warn', message, meta),
  error: (message: string, meta?: Record<string, unknown>) => emit('error', message, meta),
};
