/**
 * E2E server lifecycle: real `server/node/server.cjs` instances on isolated
 * temp save directories, plus cached fixture templates.
 *
 * Isolation model: the server treats `process.cwd()` as its root, so each test
 * gets a private temp dir with a seeded `save/`. Templates are fully built
 * instances (password + imported dataset) cached under `test/e2e/.templates/`
 * and copied per test, so one slow API-driven build serves every run.
 *
 * Auth model: the browser digests the typed password to sha256 hex via
 * `/api/crypto` and the server string-compares against `save/__password`.
 * Seeding `__password` with `sha256hex(E2E_PASSWORD)` therefore lets the UI
 * log in by typing `E2E_PASSWORD`, while programmatic clients send the digest.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const PROJECT_ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..', '..')
const SERVER_SCRIPT = path.join(PROJECT_ROOT, 'server', 'node', 'server.cjs')
const TEMPLATE_ROOT = path.join(PROJECT_ROOT, 'test', 'e2e', '.templates')

export const E2E_PASSWORD = 'pocketrisu-e2e'
export const E2E_PASSWORD_DIGEST = createHash('sha256').update(E2E_PASSWORD, 'utf-8').digest('hex')

async function getFreePort(): Promise<number> {
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

export interface E2eServer {
  port: number
  baseURL: string
  cwd: string
  stop: () => Promise<void>
  /** Stop the process but keep the instance dir (for warm-restart scenarios). */
  halt: () => Promise<void>
  /** Relaunch on a fresh port after halt(). */
  relaunch: () => Promise<void>
}

/**
 * Create a private instance dir. With `template`, copies the cached template;
 * otherwise seeds a bare password-only instance (first-run scenario).
 */
export async function prepareInstanceDir(template?: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'pocketrisu-e2e-'))
  if (template) {
    for (const sub of ['save', 'backups']) {
      await cp(path.join(TEMPLATE_ROOT, template, sub), path.join(dir, sub), { recursive: true })
    }
  } else {
    await mkdir(path.join(dir, 'save'), { recursive: true })
    await mkdir(path.join(dir, 'backups'), { recursive: true })
    await writeFile(path.join(dir, 'save', '__password'), E2E_PASSWORD_DIGEST, 'utf-8')
  }
  // The server serves the SPA from `<cwd>/dist`; share the repo build read-only.
  await symlink(path.join(PROJECT_ROOT, 'dist'), path.join(dir, 'dist'), 'dir')
  return dir
}

export async function launchServer(dir: string, env: Record<string, string> = {}): Promise<E2eServer> {
  let child: ChildProcess | null = null
  const handle = { cwd: dir } as E2eServer

  const launch = async () => {
    handle.port = await getFreePort()
    handle.baseURL = `http://127.0.0.1:${handle.port}`
    let stderrBuf = ''
    const launched = spawn(process.execPath, [SERVER_SCRIPT], {
      cwd: dir,
      env: {
        ...process.env,
        PORT: String(handle.port),
        HOST: '127.0.0.1',
        // Hermetic instances: no server-side update checks reaching out.
        RISU_UPDATE_CHECK: 'false',
        ...env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    child = launched
    launched.stderr?.on('data', (chunk: Buffer) => { stderrBuf += chunk.toString() })
    await new Promise<void>((resolve, reject) => {
      let settled = false
      const timeout = setTimeout(() => {
        settled = true
        reject(new Error(`E2E server did not start within 20 s.\nstderr: ${stderrBuf}`))
      }, 20_000)
      launched.stdout?.on('data', (chunk: Buffer) => {
        if (!settled && chunk.toString().includes('server is running')) {
          settled = true
          clearTimeout(timeout)
          resolve()
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
        reject(new Error(`E2E server exited early (code ${code}).\nstderr: ${stderrBuf}`))
      })
    })
  }

  const stopProcess = async () => {
    const active = child
    if (!active || active.exitCode !== null) return
    active.kill('SIGTERM')
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        if (active.exitCode === null) active.kill('SIGKILL')
        resolve()
      }, 5000)
      active.on('exit', () => { clearTimeout(timeout); resolve() })
    })
  }

  handle.halt = stopProcess
  handle.relaunch = launch
  handle.stop = async () => {
    await stopProcess()
    await rm(dir, { recursive: true, force: true })
  }

  await launch()
  return handle
}

/**
 * Build (or reuse) a cached template instance. `build` receives a running
 * server plus the digest password and must leave the desired state committed;
 * the instance is then shut down cleanly and its dir becomes the template.
 * The spec string keys the cache: change it to force a rebuild.
 */
export async function ensureTemplate(
  name: string,
  spec: string,
  build: (server: E2eServer) => Promise<void>,
): Promise<void> {
  const dir = path.join(TEMPLATE_ROOT, name)
  const marker = path.join(dir, '.template-spec')
  try {
    if ((await readFile(marker, 'utf-8')) === spec) return
  } catch { /* absent or unreadable: rebuild */ }
  await rm(dir, { recursive: true, force: true })

  const instanceDir = await prepareInstanceDir()
  const server = await launchServer(instanceDir)
  try {
    await build(server)
  } catch (err) {
    await server.stop()
    throw err
  }
  await server.halt()
  await mkdir(dir, { recursive: true })
  for (const sub of ['save', 'backups']) {
    await cp(path.join(instanceDir, sub), path.join(dir, sub), { recursive: true })
  }
  await writeFile(marker, spec, 'utf-8')
  await rm(instanceDir, { recursive: true, force: true })
}
