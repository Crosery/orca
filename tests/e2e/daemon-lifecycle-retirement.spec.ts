import { fork, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { build } from 'esbuild'
import { expect, test } from '@playwright/test'
import { DaemonClient } from '../../src/main/daemon/client'
import { DaemonPtyAdapter } from '../../src/main/daemon/daemon-pty-adapter'
import {
  getDaemonPidPath,
  getDaemonSocketPath,
  getDaemonTokenPath
} from '../../src/main/daemon/daemon-spawner'
import { PROTOCOL_VERSION } from '../../src/main/daemon/types'

type FixtureDaemon = {
  child: ChildProcess
  protocolVersion: number
  socketPath: string
  tokenPath: string
  pidPath: string
}

async function waitFor(label: string, predicate: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 10_000
  while (!(await predicate())) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for ${label}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

async function launchFixture(
  entryPath: string,
  daemonDir: string,
  protocolVersion: number
): Promise<FixtureDaemon> {
  const socketPath = getDaemonSocketPath(daemonDir, protocolVersion)
  const tokenPath = getDaemonTokenPath(daemonDir, protocolVersion)
  const pidPath = getDaemonPidPath(daemonDir, protocolVersion)
  const launchNonce = randomUUID()
  const child = fork(
    entryPath,
    [
      '--protocol',
      String(protocolVersion),
      '--socket',
      socketPath,
      '--token',
      tokenPath,
      ...(protocolVersion >= PROTOCOL_VERSION
        ? ['--pid-record', pidPath, '--launch-nonce', launchNonce]
        : [])
    ],
    {
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      env: {
        ...process.env,
        NODE_PATH: [path.join(process.cwd(), 'node_modules'), process.env.NODE_PATH]
          .filter(Boolean)
          .join(path.delimiter)
      }
    }
  )
  let stderr = ''
  child.stderr?.on('data', (chunk) => {
    stderr = `${stderr}${String(chunk)}`.slice(-8_192)
  })
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error('Lifecycle fixture startup timed out')),
      10_000
    )
    child.once('message', (message) => {
      if ((message as { type?: unknown }).type !== 'ready') {
        return
      }
      clearTimeout(timeout)
      resolve()
    })
    child.once('error', reject)
    child.once('exit', (code) =>
      reject(new Error(`Lifecycle fixture exited with ${code}: ${stderr.trim()}`))
    )
  })
  return { child, protocolVersion, socketPath, tokenPath, pidPath }
}

async function stopFixture(fixture: FixtureDaemon): Promise<void> {
  if (fixture.child.exitCode !== null || fixture.child.signalCode !== null) {
    return
  }
  fixture.child.kill('SIGTERM')
  await waitFor(`fixture v${fixture.protocolVersion} exit`, () => fixture.child.exitCode !== null)
}

test('v22 stays reattachable while an empty v24 retires its exact process and artifacts', async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'orca-daemon-lifecycle-'))
  const daemonDir = path.join(rootDir, 'daemon')
  mkdirSync(daemonDir, { recursive: true })
  const entryPath = path.join(rootDir, 'daemon-lifecycle-entry.cjs')
  const fixtures: FixtureDaemon[] = []

  try {
    await build({
      entryPoints: [path.join(process.cwd(), 'tests/e2e/fixtures/daemon-lifecycle-entry.ts')],
      outfile: entryPath,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      target: 'node20',
      external: ['node-pty'],
      logLevel: 'silent'
    })

    const legacy = await launchFixture(entryPath, daemonDir, 22)
    fixtures.push(legacy)
    const legacyClient = new DaemonClient({
      socketPath: legacy.socketPath,
      tokenPath: legacy.tokenPath,
      protocolVersion: 22
    })
    await legacyClient.ensureConnected()
    await expect(
      legacyClient.request('createOrAttach', { sessionId: 'legacy-live', cols: 80, rows: 24 })
    ).resolves.toMatchObject({ isNew: true })
    legacyClient.disconnect()

    const current = await launchFixture(entryPath, daemonDir, PROTOCOL_VERSION)
    fixtures.push(current)
    const reattachClient = new DaemonClient({
      socketPath: legacy.socketPath,
      tokenPath: legacy.tokenPath,
      protocolVersion: 22
    })
    await reattachClient.ensureConnected()
    await expect(
      reattachClient.request('createOrAttach', {
        sessionId: 'legacy-live',
        cols: 80,
        rows: 24
      })
    ).resolves.toMatchObject({ isNew: false })
    reattachClient.disconnect()

    const currentAdapter = new DaemonPtyAdapter({
      socketPath: current.socketPath,
      tokenPath: current.tokenPath
    })
    await currentAdapter.disconnectOnly()

    await waitFor('v24 process exit', () => current.child.exitCode !== null)
    expect(existsSync(current.tokenPath)).toBe(false)
    expect(existsSync(current.pidPath)).toBe(false)
    if (process.platform !== 'win32') {
      expect(existsSync(current.socketPath)).toBe(false)
    }
    expect(legacy.child.exitCode).toBeNull()
  } finally {
    await Promise.allSettled(fixtures.map((fixture) => stopFixture(fixture)))
    rmSync(rootDir, { recursive: true, force: true })
  }
})
