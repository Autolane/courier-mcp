// One way to say why something failed, for the CLI and the proxy alike.

/** An error's message, with its cause's in parentheses: fetch says only "fetch failed" and keeps the reason in `cause`. */
export function describeError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = error.cause;
  if (!(cause instanceof Error)) return error.message;
  // A dual-stack connect failure is an AggregateError with no message; the reason is in its first inner error.
  const inner = cause instanceof AggregateError ? (cause.errors[0] as (Error & { code?: string }) | undefined) : undefined;
  const reason = cause.message || inner?.message || inner?.code || (cause as Error & { code?: string }).code || cause.name;
  return `${error.message} (${reason})`;
}

/** Text from a server, safe to print: control characters (an escape sequence, a newline) are dropped. */
// eslint-disable-next-line no-control-regex
export const plain = (text: string): string => text.replace(/[\x00-\x1f\x7f]/g, '');
