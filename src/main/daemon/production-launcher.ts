import { fork, type ChildProcess } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import {
  serializeDaemonPidFile,
  type DaemonLauncher,
  type DaemonProcessHandle
} from './daemon-spawner'

const READY_TIMEOUT_MS = 10_000

export type ProductionLauncherOptions = {
  getDaemonEntryPath: () => string
}

export function createProductionLauncher(opts: ProductionLauncherOptions): DaemonLauncher {
  return async (
    socketPath: string,
    tokenPath: string,
    pidPath?: string,
    launchNonce?: string
  ): Promise<DaemonProcessHandle> => {
    const entryPath = opts.getDaemonEntryPath()

    const child = fork(
      entryPath,
      [
        '--socket',
        socketPath,
        '--token',
        tokenPath,
        ...(pidPath && launchNonce ? ['--pid-record', pidPath, '--launch-nonce', launchNonce] : [])
      ],
      {
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        detached: true,
        env: { ...process.env },
        ...(process.platform === 'win32' ? { windowsHide: true } : {})
      }
    )

    const startedAtMs = await waitForReady(child)
    if (pidPath && launchNonce) {
      if (!Number.isSafeInteger(child.pid) || (child.pid as number) <= 0) {
        await shutdownChild(child)
        throw new Error('Daemon readiness identity is incomplete')
      }
      try {
        writeFileSync(
          pidPath,
          serializeDaemonPidFile({
            pid: child.pid as number,
            startedAtMs,
            entryPath,
            launchNonce
          }),
          { mode: 0o600, flag: 'wx' }
        )
      } catch (error) {
        await shutdownChild(child)
        throw error
      }
    }

    // Unref so the Electron process can exit without waiting for the daemon
    child.unref()
    child.disconnect()

    return {
      shutdown: () => shutdownChild(child)
    }
  }
}

function waitForReady(child: ChildProcess): Promise<number> {
  return new Promise((resolve, reject) => {
    let timeout: ReturnType<typeof setTimeout> | undefined
    let settled = false
    function cleanupStartupListeners(): void {
      if (timeout) {
        clearTimeout(timeout)
      }
      child.off('message', onMessage)
      child.off('error', onError)
      child.off('exit', onExit)
    }
    function fail(error: Error, killChild = false): void {
      if (settled) {
        return
      }
      settled = true
      cleanupStartupListeners()
      if (killChild) {
        child.kill('SIGTERM')
      }
      reject(error)
    }
    function onMessage(msg: unknown): void {
      if (msg && typeof msg === 'object' && (msg as Record<string, unknown>).type === 'ready') {
        if (settled) {
          return
        }
        const startedAtMs = (msg as { startedAtMs?: unknown }).startedAtMs
        if (typeof startedAtMs !== 'number' || !Number.isFinite(startedAtMs) || startedAtMs <= 0) {
          fail(new Error('Daemon readiness identity is incomplete'), true)
          return
        }
        settled = true
        // Why: the daemon is detached after readiness, so startup listeners
        // must not keep the child process closure alive for the daemon lifetime.
        cleanupStartupListeners()
        resolve(startedAtMs)
      }
    }
    function onError(err: Error): void {
      fail(new Error(`Daemon process error: ${err.message}`))
    }
    function onExit(code: number | null): void {
      fail(new Error(`Daemon process exited prematurely with code ${code}`))
    }

    timeout = setTimeout(() => {
      fail(new Error('Daemon failed to signal readiness within timeout'), true)
    }, READY_TIMEOUT_MS)

    child.on('message', onMessage)
    child.on('error', onError)
    child.on('exit', onExit)
  })
}

function shutdownChild(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (child.killed) {
      resolve()
      return
    }

    let settled = false
    let timeout: ReturnType<typeof setTimeout>
    function finish(): void {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timeout)
      child.off('exit', onExit)
      resolve()
    }

    function onExit(): void {
      finish()
    }

    timeout = setTimeout(() => {
      child.kill('SIGKILL')
      finish()
    }, 5000)

    child.once('exit', onExit)
    child.kill('SIGTERM')
  })
}
