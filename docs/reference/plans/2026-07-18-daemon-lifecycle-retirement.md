# Daemon lifecycle retirement for issue #9138

## Status

Implemented and locally validated for PR #9277.

The earlier full ownership/audit prototype is preserved at:

- branch: `Jinwoo-H/issue-9138-full-ownership-audit-snapshot`
- commit: `7c915909bd26670b8af36aa683cff85077395dd1`
- GitHub: <https://github.com/stablyai/orca/tree/Jinwoo-H/issue-9138-full-ownership-audit-snapshot>

That branch is the recovery point for ownership persistence, cross-profile raw extraction, startup
audit, the candidate journal, profile-transfer recovery, natural-exit reconciliation, and future
legacy enforcement. None of those systems ship in this PR.

Current `main` assigned protocol v23 to the macOS login-shell preparation change while this work was
in progress. The lifecycle contract therefore ships as v24; v23 is preserved as a legacy generation
alongside v22 and older versions.

## Inputs and scope decision

Issue: <https://github.com/stablyai/orca/issues/9138>

Reviewed design comment by AmethystLiang:
<https://github.com/stablyai/orca/issues/9138#issuecomment-5006601124>

The reviewed comment correctly identifies two different problems:

1. current-generation daemons have no daemon-owned empty lifecycle;
2. legacy sessions need complete cross-profile ownership evidence before an app-side reaper can act.

This PR solves only the first problem. The second problem is much larger, adds steady-state
persistence and startup-audit cost, and is audit-only until field evidence can justify enforcement.
Keeping it out makes the user-visible fix small enough to review and benchmark independently.

The narrow implementation retains these important rules from AmethystLiang's design:

- daemon lifecycle behavior requires a protocol bump because old running daemons cannot acquire it;
- live sessions always win over cleanup;
- absence from a worktree, pane layout, profile, or failed listing is never destructive evidence;
- exact PID, process-start time, and per-launch nonce identify a v24 endpoint incarnation;
- the daemon, not app startup, makes the atomic empty decision;
- pre-v24 daemons stay reattachable and are not automatically shut down;
- SSH, WSL, remote-runtime, degraded-provider, sleep/wake, and profile behavior stay unchanged.

The narrow implementation changes one policy from the original comment: it does not use a blanket
30-minute idle timer. Clean authenticated app detach is an event with exact local evidence, so an
empty daemon can retire immediately. An unexpected connection loss gets a two-minute grace. This
removes needless lingering after normal quit without running periodic ownership work.

## User-visible behavior

```text
Before

app disconnects ──> daemon stays forever
                         ├── live sessions stay (wanted)
                         └── zero sessions also stay (leak)

After

clean app detach ──> daemon atomically checks itself
                         ├── any live session/work/client ──> stay alive
                         └── exactly empty ──> exit immediately

unexpected drop ──> keep endpoint for two minutes
                         ├── app reconnects/new work ──> cancel deadline
                         ├── live session remains ──> stay alive
                         └── empty at deadline ──> exit

v23 and older ──> existing reattach behavior; no automatic retirement
```

An end user with live terminals should notice no change. An end user who quits with no daemon-backed
terminals should no longer accumulate the new v24 generation. If Orca crashes or briefly loses its
socket, an empty daemon waits two minutes for recovery. A daemon with a background agent does not
exit; if that agent later exits while Orca remains disconnected, the original grace deadline applies.

## Protocol and lifecycle design

### Endpoint identity

Protocol v24 hello responses include:

```ts
type DaemonEndpointIdentity = {
  pid: number
  startedAtMs: number
  launchNonce: string
}
```

The parent generates the launch nonce, passes the nonce and PID-record path to the daemon, and writes
the daemon's self-reported start time plus the same nonce to the PID record. Both authenticated client
sockets must report the same valid identity. v24 rejects a missing or malformed identity; v23 keeps
the previous identity-free handshake.

PID publication is fail-closed. Missing readiness identity, invalid PID, an existing PID record, or a
write failure terminates the new child and fails launch instead of leaving an untracked daemon.

### Clean detach

At the end of `DaemonPtyAdapter.disconnectOnly()`, after final checkpoints and producer resumes, a
v24 adapter establishes a full connection if necessary and sends `shutdownIfIdle` within one shared
250 ms budget. v23 and older adapters skip it.

Initialization establishes one authenticated v24 lifecycle lease even before the first terminal is
opened. This cancels an inherited crash deadline after app relaunch and ensures a never-used daemon
can still receive clean retirement on quit. If startup fallback has already won, the late daemon is
not installed; it instead receives the same bounded retirement attempt, which an adopted live session
will reject.

The daemon accepts retirement only when, in one event-loop turn:

- the requesting authenticated client has both control and stream sockets;
- it is the only authenticated client;
- every accepted transport belongs to that client;
- no `createOrAttach` operation is in flight;
- the terminal host has zero sessions.

When all conditions hold, the daemon synchronously closes the listening server before replying. That
is the admission fence: a new socket or terminal cannot appear after the empty proof. Cleanup then
runs asynchronously and the process exits. A failed RPC is non-fatal to app quit and falls back to the
unexpected-disconnect behavior.

### Unexpected disconnect

The two-minute deadline starts only when the last client that completed both authenticated sockets
loses its control connection. Merely starting a daemon does not arm a timer, so an unused but healthy
daemon cannot remove its token before the app's first terminal request.

- A complete authenticated reconnect cancels the deadline.
- New terminal admission cancels the deadline.
- A raw socket or one-socket health probe pauses the timer but does not move the deadline.
- A partial authenticated connection cannot erase evidence that the last fully connected app left.
- Replacing a client ID first records the old full connection's loss; completing the replacement
  stream cancels that evidence, while an incomplete replacement only pauses it.
- A live session prevents shutdown, but does not reset the deadline.
- When the last session exits, shutdown uses the remaining time; it is immediate if the deadline
  already passed.

The adapter remembers an authenticated unexpected disconnect. If self-retirement later removes the
token, a token-file `ENOENT` is respawnable only with that prior evidence. An initial missing token is
not broadened into destructive or respawn authority.

### Artifact cleanup

The daemon removes only artifacts it can claim as its own:

- token contents must match the daemon's in-memory token;
- PID and launch nonce must match the daemon process and launch nonce;
- cleanup first renames the canonical entry to a unique claim, validates that claim, and never
  overwrites or unlinks a replacement installed at the canonical path.

Current-protocol external cleanup waits for v24 self-shutdown and does not unconditionally remove v24
PID/socket artifacts. Legacy cleanup behavior is unchanged.

## Performance design

There is no polling, profile enumeration, ownership checksum, candidate journal, process scan, or
steady-state persistence write in this PR.

The steady-state terminal hot path adds no timer work and no per-byte hashing. Initialization adds one
two-socket authenticated lifecycle handshake; the only new RPC is on app/provider detach, and its
connect-plus-request path shares a 250 ms cap, including when quit joins an existing connection
attempt; teardown fences that attempt from resurrecting sockets afterward. Unexpected-disconnect
bookkeeping changes only socket and session lifecycle events. Each daemon owns at most one unref'ed
deadline timer.

Validation compares current main and the branch for:

- daemon connect plus two-socket hello latency;
- repeated `listSessions` RPC latency;
- terminal echo/stream throughput through a real socket daemon;
- clean empty-detach latency;
- event-loop delay under repeated RPC/stream work;
- idle CPU/RSS and timer count where observable.

The acceptance target is no statistically meaningful terminal throughput regression and no new
steady-state disk writes. Results are recorded in the PR body.

### Local performance regression screen

The final local host was not quiet enough for publication-grade absolute numbers: load averages were
17-38 and unrelated Orca, browser, simulator, and VM processes occupied several cores. A paired
same-host screen still found no large regression. Five `main` v23 samples were bracketed by ten v24
branch samples; medians across sample medians were:

| Measure | `main` v23 | branch v24 |
| --- | ---: | ---: |
| two-socket connect | 1.38 ms | 1.32 ms |
| `listSessions` RPC | 0.0366 ms | 0.0374 ms |
| terminal echo stream | 3.28 MiB/s | 3.14 MiB/s |

All three medians were within about 5%. Individual stream samples varied from 0.66 to 4.04 MiB/s and
event-loop-delay samples had similar load-driven outliers, so these results are a coarse regression
screen, not evidence of an exact performance delta. Static hot-path review confirms lifecycle work
runs on connection, disconnection, session admission/exit, and quit events, with no new work per PTY
byte and no steady-state persistence or polling.

## Verification and validation

### Focused unit and integration tests

- v24 requires valid matching endpoint identity on both sockets.
- v23 and v22 accept the prior identity-free handshake and remain listed as previous protocols.
- production launch passes PID path and nonce and writes the exact readiness identity.
- incomplete readiness identity or failed exclusive PID publication kills and rejects the child.
- clean empty detach exits immediately.
- a never-used current adapter connects and retires cleanly on quit.
- app relaunch establishes a lease before the inherited crash deadline and keeps first-terminal spawn
  working after the old deadline.
- a live session, another client, raw transport, or in-flight admission rejects clean retirement.
- a control-only overlapping client pauses but cannot erase the last full-client deadline.
- a same-client-ID control replacement cannot erase the prior full connection's deadline evidence.
- startup fail-open performs bounded empty retirement without installing a late provider.
- quit remains bounded while a prior handshake is stalled and cannot resurrect client sockets later.
- the synchronous listener fence rejects post-fence connections as retryable.
- unexpected disconnect honors the boundary exactly.
- a real reconnect cancels the old deadline and a later drop gets a fresh deadline.
- raw and health probes cannot extend the deadline.
- final session exit uses the remaining deadline.
- token/PID cleanup preserves malformed, stale, and replacement artifacts.
- authenticated token disappearance performs one coalesced respawn; initial token absence does not.

### Process/E2E tests

- start a real isolated v24 daemon with real socket/named-pipe, token, and PID artifacts;
- authenticate, request clean empty retirement, and verify the exact process and owned artifacts exit;
- prove a live session rejects retirement and remains reattachable;
- run a protocol-v22 fixture beside v24 and prove v22 remains connectable/reattachable;
- never target a production runtime directory or signal a process not created by the fixture.

### Repository validation

- Node typecheck;
- oxlint and repository max-lines policy;
- focused daemon, adapter, launcher, restart, and legacy-routing suites;
- full daemon test suite;
- desktop and web production builds;
- `git diff --check` and review of every changed file against `origin/main`;
- independent review-until-clean, with review loops recorded in `.orca/bug-factory.json`;
- packaged Windows/Linux validation where CI is available; local macOS process E2E before publication.

Final local results on macOS arm64:

- full daemon suite: 53 files passed, 2 skipped; 886 tests passed, 5 skipped;
- process E2E: v22 remained live and reattachable while the exact empty v24 process and its owned
  artifacts retired;
- full Node typecheck, focused oxlint, max-lines ratchet, and `git diff --check` passed;
- full desktop, web, and native production build passed with existing build warnings;
- six complete independent review passes, including the final post-timeout-fix pass, ended clean.

The local shell used Node 26.5.0 while the repository requests Node 24; the commands completed
successfully, and repository CI remains responsible for the supported Node/platform matrix.

## Rollout and rollback

This PR changes only v24. Existing v23 and older daemons are preserved. Rolling back the app leaves
v24 as another legacy generation and does not give an older app authority to shut it down.

If the lifecycle behavior must be disabled, revert the v24 protocol/lifecycle commit. The separated
ownership/audit prototype remains recoverable from the archived branch and commit above; it should
return only as a separately reviewed, benchmarked follow-up.
