import { describe, expect, it } from 'vitest'
import {
  classifyPRRefreshError,
  safePRRefreshErrorMessage
} from './pr-refresh-error-classification'

describe('classifyPRRefreshError', () => {
  it('classifies an HTTP 429 as rate_limited even without a rate-limit body', () => {
    expect(classifyPRRefreshError(new Error('HTTP 429 Too Many Requests'))).toBe('rate_limited')
  })

  it('classifies secondary rate limit markers as rate_limited, not permission', () => {
    for (const message of [
      'You have exceeded a secondary rate limit',
      'abuse detection mechanism triggered',
      'abuse-rate-limits',
      'you have triggered an abuse detection mechanism'
    ]) {
      expect(classifyPRRefreshError(new Error(message))).toBe('rate_limited')
    }
  })

  it('classifies a 403 carrying Retry-After as rate_limited, not permission', () => {
    expect(classifyPRRefreshError(new Error('HTTP 403 Forbidden; Retry-After: 60'))).toBe(
      'rate_limited'
    )
  })

  it('classifies the primary breaker language as rate_limited', () => {
    expect(classifyPRRefreshError(new Error('API rate limit exceeded for user'))).toBe(
      'rate_limited'
    )
  })

  it('classifies a plain 403 resource denial as permission', () => {
    expect(
      classifyPRRefreshError(new Error('HTTP 403: Resource not accessible by integration'))
    ).toBe('permission')
  })

  it('classifies network failures', () => {
    for (const message of ['ETIMEDOUT', 'could not resolve host github.com', 'network is down']) {
      expect(classifyPRRefreshError(new Error(message))).toBe('network')
    }
  })

  it('classifies 404 / could not resolve repository as repo_unavailable', () => {
    expect(classifyPRRefreshError(new Error('HTTP 404 Not Found'))).toBe('repo_unavailable')
    expect(
      classifyPRRefreshError(new Error('Could not resolve to a Repository with the name'))
    ).toBe('repo_unavailable')
  })

  it('classifies an ENOENT spawn failure as gh_unavailable', () => {
    const err = Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' })
    expect(classifyPRRefreshError(err)).toBe('gh_unavailable')
    expect(classifyPRRefreshError(new Error("'gh' is not recognized as an internal command"))).toBe(
      'gh_unavailable'
    )
  })

  it('classifies auth failures after rate-limit and permission checks', () => {
    expect(classifyPRRefreshError(new Error('authentication failed: bad credentials'))).toBe('auth')
  })

  it('falls back to unknown', () => {
    expect(classifyPRRefreshError(new Error('something unexpected happened'))).toBe('unknown')
  })
})

describe('safePRRefreshErrorMessage', () => {
  it('returns non-empty copy for every classified type without leaking raw errors', () => {
    for (const type of [
      'rate_limited',
      'auth',
      'network',
      'permission',
      'repo_unavailable',
      'gh_unavailable',
      'unknown'
    ] as const) {
      const message = safePRRefreshErrorMessage(type)
      expect(message.length).toBeGreaterThan(0)
      expect(message).not.toContain('ENOENT')
    }
  })
})
