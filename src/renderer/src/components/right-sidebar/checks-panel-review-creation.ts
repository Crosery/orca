import type {
  HostedReviewCreationBlockedReason,
  HostedReviewCreationEligibility,
  HostedReviewLookupOutcome
} from '../../../../shared/hosted-review'
import { normalizeHostedReviewBaseRef } from '../../../../shared/hosted-review-refs'
import type { ChecksPanelReviewLookup } from './checks-panel-review-lookup-authority'

export function resolveChecksPanelHostedReviewBaseRef(input: {
  worktreeBaseRef?: string | null
  repoBaseRef?: string | null
}): string | null {
  const worktreeBaseRef = normalizeChecksPanelHostedReviewBaseRef(input.worktreeBaseRef)
  return worktreeBaseRef || normalizeChecksPanelHostedReviewBaseRef(input.repoBaseRef)
}

function normalizeChecksPanelHostedReviewBaseRef(ref: string | null | undefined): string | null {
  const normalizedRef = ref ? normalizeHostedReviewBaseRef(ref) : ''
  return normalizedRef || null
}

/**
 * Confirmed-only composer gate shared with mobile. Keeps the existing
 * `canCreate` / `needs_push` semantics and additionally hard-blocks on positive
 * unresolved review evidence, a current hard refresh error, or `existing_review`
 * so Create / Push & Create never appears when review existence is ambiguous or
 * a review already exists. Phase 1 adds no provisional or draft-preserve path.
 */
export function shouldOpenChecksPanelCreateComposer(input: {
  activeReview: unknown | null
  isFolder: boolean
  branch: string
  hostedReviewCreation: HostedReviewCreationEligibility | null
  reviewLookup?: ChecksPanelReviewLookup
  hasHardRefreshError?: boolean
}): boolean {
  if (input.activeReview || input.isFolder || !input.branch) {
    return false
  }
  // Positive unresolved evidence and a hard refresh error both mean the panel
  // cannot prove no review exists; fail closed rather than offering Create.
  if (input.reviewLookup === 'positive_unresolved' || input.hasHardRefreshError === true) {
    return false
  }
  const eligibility = input.hostedReviewCreation
  if (!eligibility || eligibility.blockedReason === 'existing_review') {
    return false
  }
  return eligibility.canCreate === true || eligibility.blockedReason === 'needs_push'
}

const CONFIRMED_ELIGIBILITY_MAX_AGE_MS = 5 * 60_000

const HARD_REFRESH_ERROR_TYPES = new Set([
  'auth',
  'permission',
  'repo_unavailable',
  'gh_unavailable'
])

export function isChecksPanelHardRefreshErrorType(errorType: string | undefined): boolean {
  return errorType != null && HARD_REFRESH_ERROR_TYPES.has(errorType)
}

export type ChecksPanelConfirmedReadiness = {
  confirmed: boolean
  /** The confirmed path is Push & Create rather than plain Create. */
  needsPush: boolean
}

export type ChecksPanelConfirmedReadinessInput = {
  /** The eligibility result's context key equals the panel's current context. */
  contextKeyMatches: boolean
  eligibility: Pick<
    HostedReviewCreationEligibility,
    'canCreate' | 'blockedReason' | 'reviewLookupOutcome'
  > | null
  /** Wall-clock time the eligibility result settled. */
  eligibilityCompletedAt?: number
  /** Wall-clock time the eligibility request that produced the result started. */
  eligibilityRequestStartedAt?: number
  reviewLookup: ChecksPanelReviewLookup
  /**
   * Observation time of the most recent hard refresh error for this context, or
   * undefined when no hard error is current.
   */
  hardErrorObservedAt?: number
  /**
   * Whether the Git snapshot used for the eligibility still matches current HEAD,
   * branch, upstream/ahead/behind/dirty, base, and execution-host fields.
   */
  gitSnapshotMatches: boolean
  now: number
}

const NOT_CONFIRMED: ChecksPanelConfirmedReadiness = { confirmed: false, needsPush: false }

/**
 * A hard error is cleared only by an eligibility request that started strictly
 * after the error was observed, completed for the same exact context with a
 * `found` / `not_found` lookup outcome, with no newer hard error since. A late
 * `unavailable` fallback or an already-in-flight request cannot clear it.
 */
function isChecksPanelHardErrorCleared(input: ChecksPanelConfirmedReadinessInput): boolean {
  if (input.hardErrorObservedAt === undefined) {
    return true
  }
  const startedAt = input.eligibilityRequestStartedAt
  if (startedAt === undefined || !(startedAt > input.hardErrorObservedAt)) {
    return false
  }
  if (!input.contextKeyMatches) {
    return false
  }
  const outcome: HostedReviewLookupOutcome | undefined = input.eligibility?.reviewLookupOutcome
  return outcome === 'found' || outcome === 'not_found'
}

/**
 * Confirmed readiness for the exact context. Any failed check drops confirmed
 * immediately; transient refresh failures never appear here (the caller only
 * passes a hard error observation, never a transient one).
 */
export function computeChecksPanelConfirmedReadiness(
  input: ChecksPanelConfirmedReadinessInput
): ChecksPanelConfirmedReadiness {
  const eligibility = input.eligibility
  if (!input.contextKeyMatches || !eligibility) {
    return NOT_CONFIRMED
  }
  const eligible = eligibility.canCreate === true || eligibility.blockedReason === 'needs_push'
  if (!eligible) {
    return NOT_CONFIRMED
  }
  if (
    input.reviewLookup === 'positive_unresolved' ||
    eligibility.blockedReason === 'existing_review'
  ) {
    return NOT_CONFIRMED
  }
  if (!isChecksPanelHardErrorCleared(input)) {
    return NOT_CONFIRMED
  }
  if (
    input.eligibilityCompletedAt === undefined ||
    input.now - input.eligibilityCompletedAt > CONFIRMED_ELIGIBILITY_MAX_AGE_MS ||
    !input.gitSnapshotMatches
  ) {
    return NOT_CONFIRMED
  }
  return { confirmed: true, needsPush: eligibility.blockedReason === 'needs_push' }
}

// Re-exported for callers that need the blocker type alongside the gate.
export type { HostedReviewCreationBlockedReason }
