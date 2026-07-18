import { shouldInspectWindowsAgentForeground } from './windows-agent-foreground-process'

/**
 * Whether a cheap ConPTY console-membership read can confirm the foreground
 * agent, letting us skip the whole-table process scan.
 *
 * Why: on Windows the foreground scan is a whole-process-table PowerShell fork
 * that, under load, exceeds its timeout or returns an incomplete snapshot — the
 * completion coordinator then reads the shell as the foreground and fires a
 * false "agent done" while the agent is still working. When node-pty only names
 * the shell (so a scan would otherwise run) and we already recognized an agent
 * here, a child process still attached to this console means that agent is still
 * active, so we can keep it without the scan. If node-pty already names a
 * recognized agent, the fast path already returns it and no scan runs; if no
 * agent has been recognized yet, identity must be established by a real scan
 * first.
 */
export function canConfirmAgentFromConsolePresence(
  cachedAgentName: string | null,
  fallbackProcess: string | null
): boolean {
  return (
    cachedAgentName !== null &&
    fallbackProcess !== null &&
    shouldInspectWindowsAgentForeground(fallbackProcess)
  )
}
