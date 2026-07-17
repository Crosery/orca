import type { PRRefreshErrorType } from '../../shared/types'

/**
 * Sanitization boundary for GitHub PR-refresh failures. Maps a raw runner/CLI
 * error to a stable {@link PRRefreshErrorType}; the renderer turns that into
 * classified copy so raw stderr / env values never reach the UI.
 *
 * Classification order (see docs/design/pr-panel-refresh-guidance.md):
 * HTTP 429 / secondary rate limit → primary rate limit → network → permission →
 * repo_unavailable → gh_unavailable → auth → unknown. GitHub returns 403 OR 429
 * for both primary and secondary limits, so the http-403 permission branch must
 * run only after the rate-limit checks.
 */
export function classifyPRRefreshError(err: unknown): PRRefreshErrorType {
  const message = err instanceof Error ? err.message : String(err)
  const lower = message.toLowerCase()
  const code =
    err && typeof err === 'object' && 'code' in err
      ? String((err as { code?: unknown }).code ?? '').toLowerCase()
      : ''

  // Rate limits first: a 429 is always a rate-limit signal; secondary limits also
  // arrive as abuse-mechanism phrasing or a 403/429 carrying Retry-After, none of
  // which contain "rate limit".
  const isHttp429 = lower.includes('http 429') || lower.includes('429 too many requests')
  const isHttp403 = lower.includes('http 403')
  const hasRetryAfter = lower.includes('retry-after')
  if (
    isHttp429 ||
    lower.includes('secondary rate limit') ||
    lower.includes('abuse detection') ||
    lower.includes('abuse-rate-limits') ||
    lower.includes('you have triggered an abuse') ||
    ((isHttp403 || isHttp429) && hasRetryAfter) ||
    lower.includes('api rate limit exceeded') ||
    lower.includes('rate limit')
  ) {
    return 'rate_limited'
  }
  if (
    lower.includes('timeout') ||
    lower.includes('etimedout') ||
    lower.includes('econnreset') ||
    lower.includes('econnrefused') ||
    lower.includes('no such host') ||
    lower.includes('network') ||
    lower.includes('could not resolve host')
  ) {
    return 'network'
  }
  if (isHttp403 || lower.includes('resource not accessible')) {
    return 'permission'
  }
  if (lower.includes('http 404') || lower.includes('could not resolve to a repository')) {
    return 'repo_unavailable'
  }
  // gh CLI launch failure: prefer the structured spawn error code over a broad
  // substring so a repo path merely containing "gh" is not misclassified.
  if (
    code === 'enoent' ||
    lower.includes('spawn gh enoent') ||
    lower.includes('gh: command not found') ||
    lower.includes("'gh' is not recognized")
  ) {
    return 'gh_unavailable'
  }
  return /auth|login|credential/i.test(message) ? 'auth' : 'unknown'
}

/** Stable, non-destructive fallback message for a classified refresh error. */
export function safePRRefreshErrorMessage(errorType: PRRefreshErrorType): string {
  switch (errorType) {
    case 'rate_limited':
      return 'GitHub rate limit is low. Try again after the limit resets.'
    case 'auth':
      return 'GitHub authentication is unavailable. Check your gh login.'
    case 'network':
      return 'GitHub is unreachable right now. Check your network and try again.'
    case 'permission':
      return 'GitHub did not allow access to this pull request.'
    case 'repo_unavailable':
      return 'The GitHub repository is unavailable or cannot be resolved.'
    case 'gh_unavailable':
      return 'GitHub CLI is unavailable.'
    case 'unknown':
      return 'GitHub pull request refresh failed.'
  }
}
