/**
 * A failed statement's error with none of its bound values. drizzle's query error puts every parameter (a password
 * hash, an email) in its message and on `params`, and a logger prints both; what is kept is the statement, whose values
 * are placeholders, and the driver's own message. Any other error is returned as it is. The error is recognised by its
 * shape, so one thrown through another copy of drizzle is caught too.
 */
export function withoutQueryParams(err: unknown): unknown {
  if (!(err instanceof Error) || !('params' in err) || !('query' in err)) return err
  const reason = err.cause instanceof Error ? err.cause.message : 'no reason given'
  return new Error(`Failed query: ${String(err.query)}: ${reason}`)
}
