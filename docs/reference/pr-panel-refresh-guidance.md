# PR panel refresh guidance

## Goal

When Orca cannot refresh hosted-review status, the Checks panel must explain what failed, why that matters, and what the user can do next. A failed lookup must not erase a Create PR composer that was already legitimately open for the exact current context.

This design changes renderer guidance and gating. It does not weaken the creation boundary: the main process must still revalidate review existence, branch and remote state, base, provider authentication, and execution context before it calls a provider create API.

### Success criteria

Phase 1 is successful when:

1. The empty state never shows “No {reviewLabel} found” unless an accepted no-review result exists for the exact context.
2. Classified GitHub refresh failures show stable, non-destructive copy and a working Retry (with truthful auto-retry time when known).
3. A composer that was open under confirmed readiness stays open across transient refresh failures without inventing new Create affordances.
4. Positive unresolved review evidence never offers Create / Push & Create.

Phase 2 is successful only after Phase 1 is shipped and observed: draft preservation during transient outages without a live Create submit.

### Evidence premise

This change is justified by current product bugs already visible in code, not by unmeasured telemetry:

- `paused` refresh status renders “No pull request found”.
- `skipped` and missing refresh state render “No {reviewLabel} found”.
- Typed `PRRefreshOutcome` error kinds exist in main but are dropped before empty-state copy.
- Ambiguous GitHub hosted-review + null PR cache is a Boolean gate that collapses distinct states.

Optional follow-up: log per-`errorType` empty-state impressions and composer-preserve events. That telemetry is not a Phase 1 gate.

## Scope

### In scope

- GitHub PR refresh outcome classification surfaced in the Checks empty state.
- Provider-neutral branch blockers used by hosted-review creation (`no_upstream`, `needs_sync`, `auth_required`, `needs_push`, safety blockers).
- Shared empty-state honesty for the **no-review claim** on every provider (never say “No merge request found” without accepted no-review evidence), even when GitLab/Bitbucket/etc. lack typed refresh error rows.
- Composer visibility rules that share `shouldOpenChecksPanelCreateComposer` with mobile: keep mobile parity (see [Mobile parity](#mobile-parity)).

### Out of scope

- Full GitLab/Bitbucket/Azure DevOps/Gitea refresh error classification tables (Phase 1 uses provider-neutral unknown/unavailable copy for those).
- New visual containers, design tokens, or keyboard shortcuts.
- Shipping runtime-scoped provider recovery handlers that do not already exist (omit the button).

### Definitions

- **“Offer Create PR”** means keep or open the existing composer and expose its existing submit action as **enabled**. It does not mean Orca has proved no PR exists outside an accepted no-review result, and it does not add a second Create button outside the composer.
- **“Preserve draft”** means keep composer field state (title, body, base, draft flag) in memory for the exact context without enabling Create submit.
- **“Accepted”** means a settled refresh or eligibility lookup result stored for the exact context key, not a missing cache entry and not a local blocker synthesized after a failed lookup.

## Delivery plan

Ship in two PRs. Do not merge Phase 2 machinery into Phase 1.

### Phase 1 — Truthful lookup and confirmed-only preserve (this change)

1. Four-state review evidence model; retire `hasAmbiguousGitHubHostedReview`.
2. Honest empty-state precedence and copy for every GitHub refresh path and every skipped reason that reaches the panel.
3. Propagate `errorType` and unified retry schedule fields into renderer refresh state.
4. Confirmed-only composer preserve across transient refresh failures.
5. Positive unresolved blocks Create / Push & Create.
6. Main submission boundary hardening already described (typed `already_exists`, refuse inconclusive create) if not already complete; do not invent provisional Create.
7. Mobile: leave `shouldOpenChecksPanelCreateComposer` confirmed-only (existing `canCreate` / `needs_push` semantics plus hard blocks from positive unresolved / hard refresh errors). No provisional path.

### Phase 2 — Draft preserve without live Create (follow-up)

1. During `rate_limited` / `network` / `unknown` only, allow **draft preserve** for exact-context cards that were previously confirmed **or** that meet the draft-preserve checklist below.
2. Create / Push & Create remain **disabled** with explicit copy: status must be confirmed before submit.
3. No live submit that main preflight will refuse for the same outage reason.

Phase 2 is optional. If product later wants live Create during outages, that requires a different submission boundary (e.g. queue create until lookup succeeds) and a new design — not this one.

## Required evidence model

Do not derive the empty state from `prCacheEntry.data == null` or `hasUpstream == null`. Both expressions collapse materially different states.

### Exact context key

All empty-state, composer, and eligibility decisions require an **exact context key**. Build it from existing primitives; do not invent a parallel host type.

| Field | Source | Notes |
| ----- | ------ | ----- |
| Repository / worktree identity | `repoId`, `worktreeId`, `worktreePath` | Same as `buildChecksPanelGitStatusContextKey` |
| Normalized branch | current branch name | Empty / detached handled by eligibility safety states |
| HEAD OID | Git snapshot when known | Missing OID is not a match for a snapshot that has one |
| Execution host | `ExecutionHostId` from `src/shared/execution-host.ts` (`local`, `ssh:{id}`, `runtime:{id}`) via `getRepoExecutionHostId` / normalized `executionHostId` | Already exists |
| Connection | `connectionId` | SSH path identity; do not drop when host id is present |
| WSL distro | `localGitOptions.wslDistro` (or equivalent snapshot field) | **Not** an `ExecutionHostId` kind. WSL is a local-host execution variant. Match the refresh coordinator’s runtime scope: `wsl:{distro}` vs `host` under local |
| Provider / push target | parsed remote identity or opaque remote id + push target branch/remote name | Never a credential-bearing raw remote URL in renderer state |
| Linked review hints | linked/fallback PR/MR numbers used by refresh | Link/unlink must invalidate context (already in git-status context key) |

**Equality:** two keys match only when every field matches. A result for `local` + `wsl:Ubuntu` must not authorize `local` + host, or `ssh:…`, or another distro.

**Reuse:** prefer extending `buildChecksPanelGitStatusContextKey` / refresh `refreshKey` inputs rather than a third ad-hoc string. Document any field added to either helper.

### Review lookup (`reviewLookup`)

| Value | Meaning |
| ----- | ------- |
| `found` | Current PR/MR details are **renderable** (see below). Leave the empty-state path and render the review. |
| `positive_unresolved` | An exact link, accepted positive hosted-review cache, or eligibility `reviewLookupOutcome: 'found'` exists, but details are not renderable. **Never offer Create / Push & Create.** Prefer trusted **Open Review** when a validated URL is known. |
| `not_found` | An accepted `PRRefreshOutcome.kind === 'no-pr'` (or provider-equivalent accepted no-review) **or** an eligibility result with `reviewLookupOutcome: 'not_found'` for the exact context. |
| `unknown` | No accepted positive or no-review result for the exact context (missing entry, failed lookup, skipped structural reasons, in-flight, etc.). |

An accepted cache entry with `data: null` that records an accepted no-PR outcome is distinguishable from a missing entry. If positive hosted-review evidence conflicts with that null entry, use `positive_unresolved` until a newer accepted result clears or replaces the positive evidence; never call the conflict “no PR.”

#### Renderable details

Treat review details as **renderable** only when the Checks panel can show the normal review chrome for that provider from current cache data without guessing:

- GitHub: non-null `PRInfo` (or equivalent cache payload) for the exact context with a usable identity (number + repo identity) and enough fields for the existing review header path.
- Provider-neutral hosted-review summary alone is **not** enough for `found` if the Checks panel would still need a PR details fetch to render; map that to `positive_unresolved` and offer trusted Open Review when possible.

Eligibility `reviewLookupOutcome: 'found'` proves existence but may contain only a summary → map to `found` only when details are renderable; otherwise `positive_unresolved`.

### Refresh state (`refresh`)

Use real store phases only (no synthetic `idle`):

- **phase:** absent entry | `queued` | `in-flight` | `paused` | `error` | `skipped`
- `errorType?: PRRefreshErrorType` on error outcomes
- `skippedReason?:` from the coordinator when phase is `skipped`
- Unified schedule (see [Retry schedule model](#retry-schedule-model)):
  - `nextAutoRetryAt?: number`
  - `retryDisabledUntil?: number`

### Git status (`gitStatus`)

- phase: `loading` | `ready` | `error`
- upstream: `configured` | `not_configured` | `unknown`
- dirty, ahead, behind, branch, HEAD OID, base, execution-host fields when known

`hasUpstream === undefined` is **unknown**, never `false`.

### Eligibility (`eligibility`)

- current `HostedReviewCreationEligibility` result for the exact context
- `reviewLookupOutcome: 'found' | 'not_found' | 'unavailable'` so a local blocker returned after a swallowed lookup failure cannot masquerade as authoritative no-review
- context key, request start time, completion time

## Hard invariants

1. A renderable review wins over every empty state.
2. Only an accepted no-review result may produce “No {reviewLabel} found.” An error, pause, skip, missing cache entry, unknown upstream, or eligibility `reviewLookupOutcome: 'unavailable'` never may.
3. Positive unresolved review evidence blocks Create **and** Push & Create, even if local Git state otherwise looks ready or eligibility says `needs_push` / `canCreate`.
4. `hasUpstream === undefined` never means `false`. Initial loading and a failed status probe must remain distinct, and neither may expose Publish Branch or Create PR.
5. Renderer state from another exact context key is unusable (branch, HEAD, provider, push target, `ExecutionHostId`, connection, WSL distro).
6. Main-process submission preflight remains authoritative. Renderer readiness controls affordance only.
7. Raw CLI, environment, remote, or provider errors never reach UI copy.
8. **No live Create that depends on a lookup Orca currently cannot perform.** A **hard** refresh error (`auth`, `permission`, `repo_unavailable`, `gh_unavailable`) means the existing-review lookup is impossible in this environment right now: it hides the composer and exposes no Create submit until [cleared](#clearing-a-hard-error). A **transient** failure (`network`, `rate_limited` / `paused`, `unknown`, untyped) only pauses Orca's background refresh; it does not prove that a fresh, user-initiated preflight lookup will fail, so it may preserve a **confirmed** composer with an enabled submit. That enabled submit is not a dead-end: the click triggers a fresh authoritative preflight (see [Submission boundary](#submission-boundary)), and if the lookup is still unavailable, main refuses inconclusively, preserves the draft, and shows the classified failure inline — it never creates a duplicate. Phase 1 must not **open** a new (never-confirmed) Create from a refresh failure, and Phase 2 draft-preserve keeps submit **disabled**.

## State precedence

Use one selector to return the complete model: title, description, optional lookup detail, composer mode (`hidden` | `confirmed_open` | `needs_push_open` | `draft_preserve_disabled`), workflow action, and recovery actions. Do not select copy and buttons in separate branches.

Evaluate in this order:

1. **`reviewLookup: found`** → render the review (no empty state).
2. **Operation-in-progress** and eligibility safety states that must not be overridden by refresh copy: `detached_head`, `dirty`, `default_branch`, `existing_review`, `fork_head_unsupported`, `base_not_on_remote`, `unsupported_provider`.  
   - `existing_review` is a hard create block (same family as positive evidence).
3. **`reviewLookup: positive_unresolved`** with no stronger safety state → “Pull request details unavailable” (or provider-neutral wording), trusted Open Review when possible, **no Create / Push & Create**.  
   - If a branch blocker also applies, the blocker may supply the **title/body**, but workflow Create actions stay suppressed and the positive-unresolved detail sentence is appended (see concurrent section).
4. **Actionable creation blockers** (when not suppressed by positive unresolved): `no_upstream`, `needs_sync`, `auth_required`, then `needs_push`. Order matches main eligibility. Ranked above refresh errors so a pre-publish branch shows publish/sync guidance instead of a GitHub failure. If review lookup also failed (including a hard error), append the lookup detail and suppress the workflow Create action (see concurrent section); do not hide the blocker.
5. **Hard refresh error** (`auth`, `permission`, `repo_unavailable`, `gh_unavailable`) with no blocker above → classified hard-error copy; **hide composer** until [cleared](#clearing-a-hard-error). Ranked above `not_found` because the existing-review lookup is currently impossible, so it must override an accepted no-review's Create path.
6. **`reviewLookup: not_found`** (accepted no-review for the exact context) → ordinary no-review state and confirmed Create when eligibility allows. A concurrent **transient** refresh failure or in-progress re-check does **not** override this: append at most one muted detail sentence (see concurrent section) and keep the confirmed composer preserved. An accepted no-review must stay sticky across background-refresh churn — this is the flip-flop the current empty-state code guards against.
7. **Transient classified refresh error or rate-limit pause** (`network`, `rate_limited` / `paused`, `unknown`, untyped) with **no accepted lookup result** → classified transient copy. Composer: confirmed preserve only in Phase 1; Phase 2 may add draft-preserve-disabled.
8. **Active refresh** (`queued` or `in-flight`) with **no accepted lookup result** → “Checking pull request status.” Composer: confirmed preserve only.
9. **Git status loading or failure** when upstream is still unknown → “Checking branch status” / “Could not check branch status.”
10. **Unclassified unknown / error-without-type / GitHub `skipped` reasons that mean “not confirmed” / missing entry** with no accepted result → status unavailable (not “No PR found”).

`hasAmbiguousGitHubHostedReview` must not remain a top-level Boolean gate. Replace it with the explicit review-lookup states above.

### Concurrent branch blocker and lookup failure

A known blocker is the primary guidance, but it must not erase a current lookup failure or positive unresolved evidence.

- Append one muted detail sentence beneath the blocker body.
- Retain the relevant Retry when the lookup side failed.
- **Suppress Create / Push & Create** whenever `reviewLookup` is `positive_unresolved`, eligibility is `existing_review`, or a hard refresh error (`auth` / `permission` / `repo_unavailable` / `gh_unavailable`) is current, regardless of blocker.

Examples:

- Rate limited: **Orca also could not check pull request status because GitHub is temporarily limiting requests.**
- Network: **Orca also could not check pull request status because this environment could not reach GitHub.**
- Untyped: **Orca also could not confirm whether this branch already has a pull request.**
- Positive unresolved: **Orca also has saved pull request information that it could not verify.**

Never append this detail to an operation-in-progress state where review status is intentionally unavailable, and never append “No pull request found.”

## Branch guidance

`{provider}` is the localized provider name, `{reviewLabel}` is “pull request” or “merge request,” and `{shortLabel}` is “PR” or “MR.”

| State | Title | Body | Workflow action |
| ----- | ----- | ---- | --------------- |
| Eligibility `no_upstream` or ready Git status with `hasUpstream === false` | **No upstream configured** | **Publish this branch to set its upstream before creating a {reviewLabel}.** | **Publish Branch** (not Create) |
| Eligibility `needs_sync` | **Branch needs to sync** | **Sync this branch with its upstream before creating a {reviewLabel}.** | **Sync Branch** |
| Eligibility `auth_required` | **Connect {provider}** | **{provider} must be connected in this environment before Orca can create a {reviewLabel}.** | Environment-scoped provider recovery only if a real handler exists; otherwise none |
| Eligibility `needs_push` **and** review evidence does not block create | **Branch has unpushed commits** | **Push the latest commits before creating a {reviewLabel}.** | Keep composer open with **Push & Create {shortLabel}**, unless positive unresolved / hard error / safety state invalidates it |
| Git status is loading and upstream is not yet known | **Checking branch status** | **Orca is checking this branch before showing create or publish actions.** | None |
| Git status probe failed and upstream is not known | **Could not check branch status** | **Orca could not confirm this branch's upstream from this environment. Retry before publishing or creating a {reviewLabel}.** | None; **Retry** is a recovery action |

“No upstream configured” is deliberate. The absence of a tracking upstream does not prove that no same-named branch exists on the remote, so “Branch not published” overclaims.

Publish and sync must use the same runtime-scoped operations and safety checks as Source Control. Publish must re-read upstream state and use a non-force push; it must not overwrite a remote branch merely because a cached value said no upstream was configured.

## GitHub refresh copy and actions

Composer column values:

- **Confirmed preserve** — keep an already-open composer only if [Confirmed readiness](#confirmed-readiness) still holds; submit stays enabled only while confirmed (and not hard-blocked). During a transient refresh failure this enabled submit is safe: the submission boundary re-runs a fresh authoritative lookup and refuses inconclusively (preserving the draft) rather than creating a duplicate (see invariant 8).
- **None** — hide Create / Push & Create; Phase 1 never opens a new composer from a refresh failure alone.
- Phase 2 **Draft preserve (disabled submit)** is not in the Phase 1 table.

Recovery: **Retry** invokes a complete, exact-context refresh of both Git status and review state after a failure. The successful no-review state keeps the existing **Refresh** label.

### Active and error rows

| Refresh state | Title | Body | Workflow | Recovery |
| ------------- | ----- | ---- | -------- | -------- |
| `queued` or `in-flight`, no accepted lookup result | **Checking pull request status** | **Orca is checking GitHub for a pull request on this branch.** | Confirmed preserve only | None |
| `paused`, or `errorType: rate_limited` | **GitHub refresh paused** | **GitHub is temporarily limiting requests. This can happen even when the displayed API quota is not exhausted.** | Confirmed preserve only | **Retry** (disabled until `retryDisabledUntil` when set) |
| `errorType: auth` | **GitHub authentication failed** | **GitHub could not authenticate the credentials available in this environment. Check the GitHub login or environment token, then retry.** | None (hide composer) | Runtime-scoped login help **only if implemented**; else inline instruction + **Retry** |
| `errorType: network` | **Could not reach GitHub** | **This environment could not reach GitHub. Check its connection, then retry.** | Confirmed preserve only | **Retry** (stays enabled while auto-retry is scheduled) |
| `errorType: permission` | **GitHub access denied** | **The current GitHub credentials cannot read this repository's pull requests. Check the account, token scopes, and repository access, then retry.** | None | **Review Access** only if implemented; **Retry** |
| `errorType: repo_unavailable` | **GitHub repository unavailable** | **GitHub could not resolve or access the repository for the current remote and account. Check the remote and repository access, then retry.** | None | **Open Repository** only if trusted URL + handler exist; **Retry** |
| `errorType: gh_unavailable` | **GitHub CLI unavailable** | **Orca could not run GitHub CLI in this environment. Set it up here, then retry.** | None | **View CLI Setup** only if implemented; **Retry** |
| `errorType: unknown` | **Could not check pull request status** | **The lookup failed, so Orca could not confirm whether this branch already has a pull request.** | Confirmed preserve only | **Retry** |
| Error with no `errorType` | **Pull request status unavailable** | **Orca could not confirm whether this branch already has a pull request. Retry to check again.** | Confirmed preserve only | **Retry** |
| `positive_unresolved` with no stronger state | **Pull request details unavailable** | **Orca has saved pull request information for this branch but could not confirm its current status.** | None | **Open Review** when trusted URL known; **Retry** |
| Accepted no-review outcome | **No pull request found** | **Create a pull request to start checks and review.** | Composer when confirmed ready | **Refresh** |

### Skipped and missing rows (do not collapse)

| Condition | Title | Body | Workflow | Recovery |
| --------- | ----- | ---- | -------- | -------- |
| Missing refresh entry, no accepted lookup, no stronger state | **Pull request status unavailable** | **Orca has not confirmed the pull request status for this branch. Retry to check again.** | None | **Retry** |
| `skippedReason: fresh` | Prefer accepted cache / `reviewLookup` | Do not use skipped copy if an accepted found/no-pr/positive result exists. If somehow no accepted result: same as missing. | Per `reviewLookup` | **Refresh** if no-pr; else **Retry** |
| `skippedReason: rate-limit` | Same as rate-limited / paused row | Same body + schedule rules | Confirmed preserve only | **Retry** gated like rate limit |
| `skippedReason: disconnected` | **Host disconnected** | **This repository's execution host is disconnected, so Orca cannot refresh pull request status.** | None | Host reconnect UI if it already exists; else **Retry** |
| `skippedReason: bare` | **Bare repository** | **This repository is bare, so pull request status is not available here.** | None | None |
| `skippedReason: archived` | **Repository archived** | **This repository is archived, so Orca is not refreshing pull request status.** | None | None |
| `skippedReason: not-git` | **Not a Git repository** | **Orca could not treat this folder as a Git repository for pull request status.** | None | None |
| `skippedReason: remote` | **Remote-only context** | **Orca could not refresh pull request status for this remote context. Retry after the host is available.** | None | **Retry** |

For non-GitHub providers, Phase 1 does not add typed error rows. Shared selector rules still apply: never emit “No {reviewLabel} found” without `reviewLookup: not_found`; use the missing/unknown unavailable copy instead.

### Auto-retry sentence

Append **Orca will retry at {time}.** only when a future `nextAutoRetryAt` exists for the current visible context. This applies to any transient row that carries a scheduled `nextAutoRetryAt` — `paused` / `rate_limited`, `network`, and `unknown` — not just the paused row; the per-row tables omit it because it is driven solely by the schedule field. Format `{time}` with the user's locale. Do not claim an automatic retry when none is scheduled.

Keep the Retry label stable. Do not use a countdown label that changes button width.

For the reported secondary-limit case, a create-ready **confirmed** card is:

- Title: **GitHub refresh paused**
- Body: **GitHub is temporarily limiting requests. This can happen even when the displayed API quota is not exhausted. Orca will retry at {time}.**
- Existing composer submit: **Create PR** (still enabled only because readiness was already confirmed; if the paused lookup is still failing at submit time, main refuses inconclusively and preserves the draft)
- Recovery: **Retry**, disabled until `retryDisabledUntil`

If no retry time is known, omit the final sentence and leave Retry enabled unless a hard manual gate is active.

### Classification requirements

Export the upstream-error discriminator as `PRRefreshErrorType`.

| Type | Detection (main, structured first) | Notes |
| ---- | ----------------------------------- | ----- |
| `rate_limited` | (1) **Status:** HTTP `429` (Too Many Requests) — GitHub returns `403` **or** `429` for both primary and secondary limits, so a `429` is always a rate-limit signal regardless of body; a `403` with `x-ratelimit-remaining: 0` is a primary limit. (2) **Secondary:** case-insensitive substring `secondary rate limit`, **or** the older abuse-mechanism phrasing (`abuse detection` / `abuse-rate-limits` / `you have triggered an abuse`), **or** a `403`/`429` carrying a `Retry-After` header — GitHub emits secondary limits under all of these and only the first contains `rate limit`; (3) Primary: stderr/message matches `api rate limit exceeded` (existing breaker language) **or** synthesized breaker errors that already contain `rate limit` without implying secondary-only handling gaps; (4) Coordinator / `rateLimitGuard` pause path (`status: 'paused'`, `skippedReason: 'rate-limit'`). Order matches the [detection sequence](#shared-and-main-process) in the implementation plan. | Secondary is undetectable via `GET /rate_limit` (GitHub documents no way to read secondary-limit status), so classify it from the response/marker, never from remaining primary quota. Do **not** classify a rate limit as `permission` merely because the HTTP status is 403. Match `429` and every secondary marker (including the abuse phrasing and `Retry-After` responses, which lack the `rate limit` substring) **before** the generic `http 403` → permission branch. |
| `network` | Timeouts, DNS, connection failures in the **execution** environment | Do not blame the desktop connection for WSL/SSH/runtime failures |
| `permission` | Resource not accessible / explicit access denial after rate-limit checks | |
| `repo_unavailable` | 404 / could not resolve repository | Copy must not choose renamed vs wrong remote vs private-without-access without evidence |
| `gh_unavailable` | Structured spawn failure: `ENOENT` / equivalent “gh not found” launch errors from the runner | Prefer error codes; do not classify from a broad substring alone |
| `auth` | Auth/login/credential failures that are not rate-limit or permission-resource denials | Checked after rate-limit and permission so a 403 resource denial classifies as `permission`, not `auth`. Does not prove which credential source is wrong |
| `unknown` | Everything else | Must preserve uncertainty about review existence |

Untyped fallback (error with no `errorType`) uses the unavailable copy row and confirmed-preserve only — never provisional/draft-open from untyped alone.

## Retry schedule model

One model for UI and main. Map existing pause machinery into it; do not leave three independent meanings.

| Field | Meaning | Set when |
| ----- | ------- | -------- |
| `nextAutoRetryAt` | Earliest time main expects to auto-retry this refresh key | `paused` events: copy from `pausedUntil`. Error backoff: compute before broadcast (coordinator already owns backoff). Clear when a non-paused success/error settles without schedule. |
| `retryDisabledUntil` | Earliest time **manual** Retry / `refreshPRNow` is accepted | Rate-limit gates only (primary bucket floor, breaker block, or explicit secondary cooldown when known). **Not** set for ordinary network/auth exponential backoff. |
| `pausedUntil` (existing event field) | Source of truth on `status: 'paused'` events | Renderer maps it into `nextAutoRetryAt` (and into `retryDisabledUntil` when the pause is a hard rate-limit gate). Prefer not growing a third user-facing concept in copy. |

Rules:

1. Auto-retry copy reads **only** `nextAutoRetryAt`.
2. Retry button disabled **only** while `now < retryDisabledUntil`.
3. Manual network/auth/unknown Retry stays enabled even if `nextAutoRetryAt` is in the future.
4. Main `refreshPRNow` enforces the same `retryDisabledUntil` gate so a stale renderer cannot bypass it.
5. Scheduling stays scoped by the existing host-aware refresh key (`refreshKey` in `pr-refresh-coordinator.ts`).

## Composer readiness

The selector exposes composer mode, not a free-floating “provisional Create.”

### Confirmed readiness

Confirmed readiness requires **all** of:

1. Exact context key match.
2. A completed eligibility result with `canCreate === true` **or** `blockedReason === 'needs_push'` (Push & Create path).  
   - `needs_push` is not “confirmed create”; it is the separate Push & Create workflow. Both are **confirmed composer opens**, not provisional.
3. `reviewLookup` is not `positive_unresolved` and eligibility is not `existing_review`.
4. No current **hard** refresh error for this context: `auth`, `permission`, `repo_unavailable`, `gh_unavailable`.
5. **Freshness:** eligibility completion time is within **5 minutes** **and** the Git snapshot used for that eligibility still matches current HEAD OID, branch, upstream configured/ahead/behind/dirty, base, and execution-host fields. Any mismatch drops confirmed immediately.
6. Eligibility request that produced the result is for this exact context key.

Transient refresh failures that **do not** invalidate confirmed:

- `rate_limited` / `paused` / `skippedReason: rate-limit`
- `network`
- `unknown` (typed)
- error without `errorType` (confirmed preserve only; do not use these to *enter* confirmed)

Hard errors **hide** the composer. Preserve field state in memory for the exact context so recovery does not discard input, but do not show an enabled Create until confirmed returns.

#### Clearing a hard error

A hard error is cleared only when **all** hold:

1. An eligibility request with `requestStartedAt` **strictly after** the hard error’s observation time (`fetchedAt` / refresh `updatedAt`).
2. That request completes for the **same** exact context key.
3. Its `reviewLookupOutcome` is `found` or `not_found` (not `unavailable`).
4. No newer hard error has been observed since that request started.

Sequence notes:

- A request already in flight when the hard error arrives **cannot** clear it, even if it completes later with `not_found`.
- A local-blocker fallback with `reviewLookupOutcome: 'unavailable'` cannot clear it.
- Completion order alone is insufficient; compare start times.

### Phase 1: no provisional Create

Do **not** open Create from git-signal inference during a refresh failure. Do **not** treat a cached no-review outcome as a license to enable Create when current refresh is failed/paused/unknown.

That keeps composer authority aligned with invariant 2: only accepted current no-review (plus eligibility) drives the no-PR create path; transient failure only **preserves** a composer that was already confirmed.

### Phase 2: draft preserve (disabled submit)

Allowed only for `rate_limited` / `network` / `unknown`, exact context, and:

- real non-default branch on a supported review provider
- no active, linked, renderable, or positive unresolved review
- known base ≠ head
- clean worktree
- upstream configured, `ahead === 0`, `behind === 0`
- current HEAD OID + execution-host-scoped Git snapshot

Behavior:

- Show composer fields if useful, or keep them mounted but disabled.
- Submit label remains Create / Push & Create but control is **disabled**.
- Body or helper text: **Orca will enable create when pull request status is confirmed.**
- Untyped errors do not enter draft-preserve; they only keep a previously confirmed open composer (Phase 1 rule).

Never enable submit until confirmed readiness returns.

### Blocked

Readiness is blocked by positive review evidence, unknown/loading/failed upstream probe, dirty/default/detached/unsupported state, hard refresh error, or failed freshness checks.

## Submission boundary

On Create or Push & Create submission, main must:

- verify selected worktree, branch, HEAD, provider, remote, and execution host (including WSL variant when applicable) still match the submitted context
- re-read dirty state, upstream, ahead/behind, base, provider authentication, and remote head in that environment
- perform a **current** existing-review lookup before invoking the provider create API
- return typed `already_exists` with a trusted review URL when a review is found
- avoid the provider create call when any required preflight is unavailable or inconclusive
- preserve composed title and body and show the classified failure inline when preflight cannot complete

This is what makes a **confirmed** composer resilient without weakening duplicate-review or stale-head protection: a confirmed submit during a transient outage triggers this fresh preflight, which either completes or refuses inconclusively and preserves the draft — never a silent dead-end or duplicate. It is also why Phase 1/2 must not expose a **never-confirmed** (provisional) Create, and why a **hard** error — where the lookup is currently impossible — hides the composer entirely.

When main returns `already_exists`, collapse the composer into a card titled **Pull request already exists** with body **Orca found an existing pull request for this branch.** and primary **Open Review** bound to the returned trusted URL (same trusted-link rules as `positive_unresolved`). Preserve composed title and body so the user can dismiss and resume.

## Provider recovery behavior

Recovery controls must describe what they actually do. Do not label a button **Reconnect GitHub** if it merely opens instructions, and do not wire a remote failure to desktop-only settings.

### Phase 1 inventory

| Control | Ship in Phase 1? | Rule |
| ------- | ---------------- | ---- |
| **Retry** / **Refresh** | Yes | Always for failed/unknown/no-pr paths as in tables |
| **Open Review** | Yes when trusted URL known | Exact linked or accepted provider URL only; trusted-link handling |
| **Publish Branch** / **Sync Branch** | Yes | Existing Source Control operations |
| **Create** / **Push & Create** | Yes when confirmed | Existing composer |
| Runtime-scoped login / **View CLI Setup** / **Review Access** / **Open Repository** | Only if a real exact-context handler already exists | Otherwise omit the button; keep safe inline copy + Retry |

If runtime-scoped provider recovery is not implemented, omit those conditional buttons rather than shipping a desktop-only or no-op action.

Additional rules when handlers exist:

- Login/setup must resolve the repository's execution host (and WSL variant when local+WSL) and open a runtime-scoped help or terminal flow.
- For GitHub.com, diagnostics may name `GH_TOKEN` or `GITHUB_TOKEN` when one overrides the saved `gh` login. For GitHub Enterprise, also account for `GH_ENTERPRISE_TOKEN` and `GITHUB_ENTERPRISE_TOKEN`. Never put token values in renderer state or UI.
- Show the correct `gh auth login --hostname {host}` instruction for the failed runtime. Do not assume `github.com`.
- **Review Access** may explain account/scopes/access; it must not claim to change permissions.
- **Open Repository** only for HTTPS URL derived from parsed provider identity.
- **View CLI Setup** opens setup instructions; it does not claim to install `gh`.
- Provider-neutral `auth_required` uses the matching provider adapter and review terminology. Do not send GitLab/Bitbucket/Azure DevOps/Gitea failures into GitHub recovery UI.

## Mobile parity

`shouldOpenChecksPanelCreateComposer` is shared with mobile tests and create gating.

Phase 1 changes to that helper must:

- keep confirmed-only semantics (`canCreate` or `needs_push`)
- additionally return false when desktop would hard-block (positive unresolved review evidence, hard refresh error for the shared context when those signals are available on mobile)
- not introduce draft-preserve or provisional Create on mobile

If mobile lacks refresh `errorType` / review-lookup signals, fail closed: do not open create when review existence is known-ambiguous from hosted-review cache alone (mirror `positive_unresolved` / existing ambiguity helpers).

Update `mobile-pr-create.test.ts` parity cases when the desktop gate gains hard-block inputs.

## Presentation and interaction

Keep the existing Checks-panel empty-state layout.

- Use `text-sm font-medium text-foreground` for the title and `text-xs text-muted-foreground` for body/detail copy.
- Keep the existing `Button` primitive at `size="xs"`.
- Composer Create/Push & Create, Publish Branch, and Sync Branch are workflow actions (default variant). Retry, Open Repository, and other supporting actions use `outline`.
- Keep errors and recovery guidance persistent inline. Do not move required information into a toast or tooltip.
- Disable an invoked control immediately. Use the canonical `Loader2` spinner only after the existing delayed-loading threshold, keep the label stable, and reserve the spinner's width so SSH latency does not shift the row.
- Do not use destructive color. These failures do not delete data, and rate limiting is not the user's fault.
- Do not add keyboard shortcuts without an implemented cross-platform binding.
- Do not move focus when a background refresh changes the state. Deduplicate polite announcements so periodic identical refreshes stay silent, and keep the user's composer focus and text intact.
- When a hard error hides a composer that currently holds focus, move focus to the new error card's heading or its primary Retry action. If the composer does not hold focus, leave focus untouched.
- Announce any non-duplicate resolved card (change in title or body) by its title through the polite live region. Suppress identical consecutive titles via the dedup rule, and do not announce in-flight-only transitions.

## Implementation plan

### Shared and main process

- `src/shared/types.ts`
  - Export `PRRefreshErrorType` from the upstream-error discriminator.
  - Document schedule fields on refresh events/outcomes: `nextAutoRetryAt?`, `retryDisabledUntil?` (renderer may derive the former from `pausedUntil` for pause events).
- `src/shared/hosted-review.ts` and `src/main/source-control/hosted-review-creation.ts`
  - Add `reviewLookupOutcome` to eligibility results.
  - Mark local-blocker fallback paths as `unavailable`; only accepted provider lookup may return `found` or `not_found`.
- `src/main/github/client.ts`
  - Keep `classifyPRRefreshError` / `safePRRefreshErrorMessage` as the sanitization boundary.
  - Classification order: HTTP `429` / secondary rate limit → primary rate limit → network → permission → repo_unavailable → structured `gh_unavailable` → auth → unknown. GitHub returns `403` **or** `429` for both primary and secondary limits, so the current `http 403` permission check must run only **after** an HTTP-`429` check and the secondary markers (abuse-mechanism phrasing and `Retry-After` responses; see [Classification requirements](#classification-requirements)); otherwise a `429` or a `403` secondary limit falls through to `permission`.
  - Exhaustive tests per branch; never expose stderr or env values.
- `src/main/github/pr-refresh-coordinator.ts`
  - Preserve visible-refresh exponential backoff.
  - Compute schedule metadata before broadcasting so every alias receives the same schedule.
  - Enforce manual rate-limit gate in `refreshPRNow`.
  - Keep scheduling scoped by existing host-aware `refreshKey` (connection + WSL/runtime scope + repo path + branch/PR).

### Renderer state and selector

- `src/renderer/src/store/slices/github.ts`
  - Add `errorType`, `nextAutoRetryAt`, `retryDisabledUntil`, `skippedReason` to `PRRefreshState` (today: `status`, `reason`, `updatedAt`, `pausedUntil?`, `message?`). Keep `skippedReason` distinct from the existing trigger `reason` (`GitHubPRRefreshReason`); the two are not interchangeable.
  - Map pause events: `pausedUntil` → `nextAutoRetryAt` (+ `retryDisabledUntil` when hard gate).
  - Preserve accepted PR/hosted-review cache data on upstream errors.
  - Preserve enough accepted-outcome provenance to distinguish missing lookup from accepted `no-pr` after hydration/invalidation.
- `src/renderer/src/components/right-sidebar/checks-panel-review-lookup-authority.ts` (new)
  - Four-state review evidence model; retire `hasAmbiguousGitHubHostedReviewForChecksPanel` and its inputs in `checks-panel-empty-state.ts` / `ChecksPanel.tsx`.
  - Resolve conflicting positive vs no-PR evidence by accepted outcome order; never treat conflict as no review.
- `src/renderer/src/components/right-sidebar/checks-panel-git-status-snapshot.ts`
  - Track loading/ready/error, capture time, HEAD OID, `ExecutionHostId`, connectionId, WSL distro when applicable.
  - Keep exact-context commit guards; extend context key fields listed above if missing.
- `src/renderer/src/components/right-sidebar/checks-panel-empty-state.ts`
  - One exhaustive selector: copy, optional lookup detail, composer mode, semantic actions.
  - Keep translation at the copy boundary; do not build localized sentences by concatenation.
- `src/renderer/src/components/right-sidebar/checks-panel-review-creation.ts`
  - `shouldOpenChecksPanelCreateComposer` remains the confirmed open gate (plus needs_push).
  - Add hard-block inputs (positive unresolved / hard error) without Phase 2 draft mode.
  - Compare hard-error observation time with eligibility **request start** time before clearing.
- `src/renderer/src/components/right-sidebar/ChecksPanel.tsx`
  - Remove duplicate inline composer gate.
  - Render selector actions through exact-context handlers.
  - Preserve composer field state across refresh failures and failed submission preflight.
- Mobile tests under `mobile/src/source-control/` for gate parity.

## Acceptance tests

### Phase 1

- every GitHub error type, rate-limit pause, queued/in-flight, each skippedReason row, missing, positive unresolved, and accepted no-PR copy
- only accepted no-review renders “No pull request found” / “No merge request found”
- every branch blocker combined with classified and unclassified lookup failures, including detail sentence
- `needs_push` + `positive_unresolved` never exposes Push & Create
- initial Git status loading vs failed status; no Publish/Create when upstream unknown
- confirmed preserve for transient errors; hard errors hide composer but keep draft fields
- hard error before/during/after eligibility request, including late `unavailable` fallback that must not clear the error
- positive linked/cached review evidence blocks create
- exact context isolation: branch, HEAD, remote/provider, `ExecutionHostId`, connectionId, WSL distro vs host
- store propagation of classification + retry schedule; accepted review cache unchanged on upstream error
- auto-retry time formatting; stable Retry copy; renderer disable + main rejection before `retryDisabledUntil`
- manual network/auth retry remains available when only auto-retry is scheduled
- secondary rate-limit strings classify as `rate_limited`, not `permission`
- `ENOENT`-style gh launch failures classify as `gh_unavailable`
- trusted Open Review validation; no desktop-only recovery for remote failures when handlers are absent
- submit preflight `already_exists`, refuse inconclusive creation, preserve title/body on failure
- no focus loss, eager spinner, destructive styling, or layout shift under simulated SSH latency
- mobile parity tests for confirmed gate + hard blocks

### Phase 2 (when implemented)

- draft-preserve shows disabled Create for allowed transient errors only
- untyped error does not enter draft-preserve
- submit never fires while disabled; enabling requires confirmed readiness

No new color, typography, spacing, radius, shadow, or component token is required.

## Resolved decisions (from 2026-07-16 review)

| Issue | Decision |
| ----- | -------- |
| Provisional live Create dead-ends during outage | **Removed for never-confirmed cards.** Phase 1 opens no provisional Create; Phase 2 is draft-preserve with **disabled** submit. A **confirmed** composer keeps its enabled submit through transient failures — that is not a dead-end, because the user-initiated submit runs a fresh authoritative preflight that refuses inconclusively and preserves the draft rather than creating a duplicate. **Hard** errors (lookup currently impossible) hide the composer outright. |
| Invariant 2 vs provisional “cached no-PR” | **Aligned.** Cached no-PR must not enable Create during failed/unknown refresh. Only accepted current no-review + eligibility opens Create. |
| `needs_push` vs `positive_unresolved` | **Invariant 3 wins.** Positive unresolved suppresses Create and Push & Create; blocker may still own title/body with detail sentence. |
| Secondary rate-limit marker | **Specified:** substring `secondary rate limit` (and primary `api rate limit exceeded` / guard pause path); classify before generic 403→permission. |
| Canonical host identity | **Use existing `ExecutionHostId` + connectionId + WSL distro field.** WSL is not a fourth host kind; match coordinator `wsl:{distro}` vs `host` under local. |
| Sequencing | **Phase 1 honesty + confirmed preserve first; Phase 2 optional draft preserve.** |
| Skipped collapse | **Per-`skippedReason` rows**; `fresh` defers to accepted cache. |
| Confirmed staleness | **5-minute eligibility age + exact Git/host snapshot match.** |
| Renderable | **Defined:** enough cached details for normal Checks review chrome; summary-only → `positive_unresolved`. |
| Triple retry clocks | **Unified model:** `nextAutoRetryAt` + `retryDisabledUntil`; `pausedUntil` maps into them. |
| Recovery catalog | **Phase 1 ships Retry/Refresh/Open Review/Publish/Sync/Create only; other buttons only if handlers exist.** |
| Mobile | **Confirmed-only gate; hard blocks shared; no provisional.** |
| Product evidence | **Premise is current false “No PR found” / dropped error types in code; telemetry optional.** |
| Synthetic `idle` phase | **Removed;** use absent entry. |

## Deferred / Open Questions

None that block Phase 1. Optional later work:

- Provider-specific refresh classification for GitLab/Bitbucket/Azure DevOps/Gitea.
- Telemetry for empty-state impressions per `errorType`.
- Queued create-on-recovery (would require a new design; not Phase 2 draft preserve).
