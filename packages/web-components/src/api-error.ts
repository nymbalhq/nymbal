/** The code of an SDK `NymbalApiError`, read by its shape so the element carries none of the SDK's runtime. */
export function apiErrorCode(err: unknown): string | undefined {
  if (!(err instanceof Error) || err.name !== 'NymbalApiError') return undefined
  const { code } = err as Error & { code?: unknown }
  return typeof code === 'string' ? code : undefined
}
