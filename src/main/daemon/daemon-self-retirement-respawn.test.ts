import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DaemonPtyAdapter } from './daemon-pty-adapter'
import { DaemonServer } from './daemon-server'
import { getDaemonSocketPath } from './daemon-spawner'
import type { SubprocessHandle } from './session'

function fixtureSubprocess(): SubprocessHandle {
  return {
    pid: process.pid,
    getForegroundProcess: () => null,
    write: () => {},
    resize: () => {},
    kill: () => {},
    forceKill: () => {},
    signal: () => {},
    onData: () => {},
    onExit: () => {},
    dispose: () => {}
  }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error('Timed out waiting for daemon disconnect')
    }
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

describe('daemon self-retirement respawn', () => {
  let dir: string
  let socketPath: string
  let tokenPath: string
  let server: DaemonServer | null

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'daemon-retirement-respawn-'))
    socketPath = getDaemonSocketPath(dir)
    tokenPath = join(dir, 'daemon.token')
    server = null
  })

  afterEach(async () => {
    await server?.shutdown().catch(() => {})
    rmSync(dir, { recursive: true, force: true })
  })

  async function startServer(): Promise<DaemonServer> {
    const next = new DaemonServer({
      socketPath,
      tokenPath,
      spawnSubprocess: () => fixtureSubprocess()
    })
    await next.start()
    server = next
    return next
  }

  it('coalesces respawn after an authenticated endpoint removes its token', async () => {
    const original = await startServer()
    const respawn = vi.fn(async () => {
      await startServer()
    })
    const adapter = new DaemonPtyAdapter({ socketPath, tokenPath, respawn })
    await adapter.listProcesses()
    const client = (
      adapter as unknown as {
        client: { hasObservedAuthenticatedDisconnect(): boolean }
      }
    ).client

    await original.shutdown()
    await waitFor(() => client.hasObservedAuthenticatedDisconnect())

    await Promise.all([
      adapter.spawn({ sessionId: 'first', cols: 80, rows: 24 }),
      adapter.spawn({ sessionId: 'second', cols: 80, rows: 24 })
    ])

    expect(respawn).toHaveBeenCalledTimes(1)
    adapter.dispose()
  })

  it('does not treat an initial missing token as respawn authority', async () => {
    const respawn = vi.fn(async () => {})
    const adapter = new DaemonPtyAdapter({ socketPath, tokenPath, respawn })

    await expect(adapter.spawn({ sessionId: 'missing', cols: 80, rows: 24 })).rejects.toMatchObject(
      {
        code: 'ENOENT'
      }
    )

    expect(respawn).not.toHaveBeenCalled()
    adapter.dispose()
  })
})
