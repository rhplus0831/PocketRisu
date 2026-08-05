/**
 * Spawn a RisuAI-NodeOnly server in isolation using a temporary save directory.
 *
 * Strategy: run `node <project>/server/node/server.cjs` with cwd set to a temp
 * directory.  The server resolves `save/` relative to cwd, but loads code via
 * __dirname, so no symlinks or copies are needed.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

const PROJECT_ROOT = path.resolve(import.meta.dirname, '..', '..', '..')
const SERVER_SCRIPT = path.join(PROJECT_ROOT, 'server', 'node', 'server.cjs')

const TEST_PASSWORD = 'compat-test-pass'

export interface ServerHandle {
  port: number
  /** PID of the active isolated server process. */
  pid: number
  password: string
  cwd: string
  /** Installation-owned child of the configured spool root. */
  spoolDir: string
  /** Restart the same save directory on a fresh port. */
  restart: (env?: Record<string, string>) => Promise<void>
  /** Abruptly kill the active process without deleting its save directory. */
  crash: () => Promise<void>
  /** Kill the server and clean up the temp directory. */
  cleanup: () => Promise<void>
}

/** Find a free port by binding to 0 and immediately closing. */
async function getFreePort(): Promise<number> {
  const { createServer } = await import('node:net')
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.listen(0, () => {
      const addr = srv.address()
      if (addr && typeof addr === 'object') {
        const port = addr.port
        srv.close(() => resolve(port))
      } else {
        srv.close(() => reject(new Error('Unable to determine port')))
      }
    })
    srv.on('error', reject)
  })
}

export interface SpawnServerOptions {
  /** Extra env vars to pass to the spawned server process. */
  env?: Record<string, string>
  /** Skip the optional server-file-backup destination for hub-mode coverage. */
  createBackupsDir?: boolean
  /**
   * Seed files into the temp `save/` directory BEFORE the server boots — e.g.
   * to plant an old hex-named save folder and exercise migrateFromSaveDir.
   * Receives the absolute path to the `save/` dir.
   */
  seedSave?: (saveDir: string) => Promise<void>
  /** Seed files such as dist/build-stamp.json before the server discovers them. */
  seedRoot?: (rootDir: string) => Promise<void>
}

export async function spawnServer(opts: SpawnServerOptions = {}): Promise<ServerHandle> {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'risu-compat-'))
  await mkdir(path.join(tempDir, 'save'), { recursive: true })
  if (opts.createBackupsDir !== false) {
    await mkdir(path.join(tempDir, 'backups'), { recursive: true })
  }
  await writeFile(path.join(tempDir, 'save', '__password'), TEST_PASSWORD, 'utf-8')
  if (opts.seedSave) await opts.seedSave(path.join(tempDir, 'save'))
  if (opts.seedRoot) await opts.seedRoot(tempDir)

  let child: ChildProcess | null = null
  let exited = true
  const handle = {
    port: 0,
    pid: 0,
    password: TEST_PASSWORD,
    cwd: tempDir,
    spoolDir: '',
  } as ServerHandle

  const launch = async (extraEnv: Record<string, string> = {}) => {
    // getFreePort closes its probe socket before the child binds the port, so
    // a concurrently-spawning server can steal it in between. Retry the
    // collision signature instead of failing the whole test file.
    for (let attempt = 1; ; attempt++) {
      try {
        await launchOnce(extraEnv)
        return
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (attempt >= 5 || !message.includes('EADDRINUSE')) throw error
      }
    }
  }

  const launchOnce = async (extraEnv: Record<string, string> = {}) => {
    handle.port = await getFreePort()
    let stderrBuf = ''
    const launchEnv = { ...opts.env, ...extraEnv }
    const childEnv: NodeJS.ProcessEnv = {
      ...process.env,
      PORT: String(handle.port),
      NODE_ENV: 'test',
      ...launchEnv,
    }
    const launched = spawn(
      process.execPath,
      [SERVER_SCRIPT],
      {
        cwd: tempDir,
        env: childEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )
    child = launched
    handle.pid = launched.pid ?? 0
    exited = launched.exitCode !== null
    launched.stderr?.on('data', (chunk: Buffer) => { stderrBuf += chunk.toString() })
    launched.on('exit', () => {
      if (child === launched) exited = true
    })

    await new Promise<void>((resolve, reject) => {
      let settled = false
      const timeout = setTimeout(() => {
        settled = true
        reject(new Error(`Server did not start within 10 s.\nstderr: ${stderrBuf}`))
      }, 10_000)
      launched.stdout?.on('data', (chunk: Buffer) => {
        if (!settled
          && chunk.toString().includes('[Server]')
          && chunk.toString().includes('server is running')) {
          settled = true
          clearTimeout(timeout)
          const configuredSpoolRoot = String(
            childEnv['POCKETRISU_SPOOL_DIR'] ?? '',
          ).trim()
          const spoolRoot = configuredSpoolRoot
            ? path.resolve(tempDir, configuredSpoolRoot)
            : path.join(tempDir, 'save', '.spool')
          void readFile(path.join(tempDir, 'save', '__spool_owner_id'), 'utf8').then(ownerId => {
            const owner = createHash('sha256').update(ownerId.trim().toLowerCase()).digest('hex')
            handle.spoolDir = path.join(spoolRoot, `.instance-${owner}`)
            resolve()
          }, error => {
            // Keep the harness behaviorally useful against pre-ownership
            // servers: their active files live directly in the configured root.
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
              handle.spoolDir = spoolRoot
              resolve()
              return
            }
            reject(error)
          })
        }
      })
      launched.on('error', (err) => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        reject(err)
      })
      launched.on('exit', (code) => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        reject(new Error(`Server exited early with code ${code}.\nstderr: ${stderrBuf}`))
      })
    })
  }

  const stop = async () => {
    const active = child
    if (active && !exited) {
      active.kill('SIGTERM')
      await new Promise<void>(resolve => {
        const timeout = setTimeout(() => {
          if (active.exitCode === null) active.kill('SIGKILL')
          resolve()
        }, 3000)
        active.on('exit', () => { clearTimeout(timeout); resolve() })
      })
    }
    if (child === active) {
      child = null
      handle.pid = 0
      exited = true
    }
  }

  handle.restart = async (env = {}) => {
    await stop()
    await launch(env)
  }
  handle.crash = async () => {
    const active = child
    if (!active || exited) return
    active.kill('SIGKILL')
    await new Promise<void>(resolve => {
      if (active.exitCode !== null) {
        resolve()
        return
      }
      active.once('exit', () => resolve())
    })
    if (child === active) {
      child = null
      handle.pid = 0
      exited = true
    }
  }
  handle.cleanup = async () => {
    await stop()
    await rm(tempDir, { recursive: true, force: true })
  }

  await launch()
  return handle
}
