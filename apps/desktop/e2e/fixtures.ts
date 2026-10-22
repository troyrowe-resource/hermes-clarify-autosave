/**
 * Shared E2E fixtures for the Hermes desktop Playwright suite.
 *
 * Two fixture modes:
 *
 *  1. `mockBackend` — starts a mock inference server, writes a config.yaml
 *     that points at it, and launches the desktop app so the full chain
 *     (electron → hermes serve → provider → inference → renderer) is
 *     exercised with a real backend but a fake LLM.
 *
 *  2. `noProvider` — launches the app with an empty config (no provider
 *     configured). The onboarding overlay should appear. Used to test the
 *     first-run flow without real credentials.
 *
 * Both modes launch the *dev* Electron app (`electron .` against the built
 * `dist/`), not the packaged binary. This avoids the multi-minute
 * `electron-builder --dir` step and matches `hermes desktop --source`. The
 * packaged-binary path is already covered by `launch.spec.ts`.
 *
 * Prerequisite: `npm run build` must have been run so that `dist/` exists.
 */

import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { _electron, type ElectronApplication, type Page } from '@playwright/test'

import { waitForChatReady } from '../../../tests-js/scripts/desktop-chat-smoke'
import { writeEnvFile, writeMockProviderConfig } from '../../../tests-js/scripts/mock-provider-config'
import { type MockServerOptions, startMockServer } from '../../../tests-js/scripts/mock-server'

import { resolveElectronBinary } from './electron-binary'
import { sandboxHomeEnv } from './sandbox-home-env'
import { canonicalPath, samePath } from './sandbox-path'
import { installErrorBannerGuard } from './test'

const DESKTOP_ROOT = path.resolve(import.meta.dirname, '..')
const REPO_ROOT = path.resolve(DESKTOP_ROOT, '..', '..')
const RELEASE_ROOT = path.join(DESKTOP_ROOT, 'release')

// ─── Credential stripping (matches launch.spec.ts) ──────────────────────

const CREDENTIAL_SUFFIXES: string[] = [
  '_API_KEY',
  '_TOKEN',
  '_SECRET',
  '_PASSWORD',
  '_CREDENTIALS',
  '_ACCESS_KEY',
  '_PRIVATE_KEY',
  '_OAUTH_TOKEN',
]

const CREDENTIAL_NAMES = new Set([
  // Config directories that hold another tool's login (Claude Code, Codex): the sandboxed backend must not find them.
  'CLAUDE_CONFIG_DIR',
  'CODEX_HOME',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_TOKEN',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'CUSTOM_API_KEY',
  'GEMINI_BASE_URL',
  'OPENAI_BASE_URL',
  'OPENROUTER_BASE_URL',
  'OLLAMA_BASE_URL',
  'GROQ_BASE_URL',
  'XAI_BASE_URL',
])

function isCredentialEnvVar(name: string): boolean {
  if (CREDENTIAL_NAMES.has(name)) {
    return true
  }

  return CREDENTIAL_SUFFIXES.some((suffix) => name.endsWith(suffix))
}

// Runtime state of whatever Hermes launched this run. A spec driven from inside
// an agent's terminal inherits HERMES_YOLO_MODE, HERMES_INTERACTIVE,
// HERMES_SESSION_ID…, and the sandboxed backend then skips approvals or binds
// the caller's session — the approval spec failed locally on the leaked yolo
// flag while CI (which never has these) stayed green. The fixtures set every
// HERMES_* the app needs themselves; only the harness's own knobs pass.
function isInheritedHermesRuntimeVar(name: string): boolean {
  return name.startsWith('HERMES_') && !name.startsWith('HERMES_DESKTOP_') && !name.startsWith('HERMES_E2E_')
}

function stripCredentials(env: Record<string, string | undefined>): Record<string, string> {
  const clean: Record<string, string> = {}

  for (const [key, value] of Object.entries(env)) {
    if (!value) {
      continue
    }

    if (isCredentialEnvVar(key) || isInheritedHermesRuntimeVar(key)) {
      continue
    }

    clean[key] = value
  }

  return clean
}

// ─── Sandbox creation ──────────────────────────────────────────────────

export interface Sandbox {
  root: string
  hermesHome: string
  userDataDir: string
  cleanup: () => void
}

export function createSandbox(prefix: string): Sandbox {
  // Canonical path: the backend resolves HERMES_HOME, so a symlinked tmpdir (macOS /var, a symlinked scratch
  // dir) or a Windows 8.3 short name (a runner's TEMP is C:\Users\RUNNER~1\..., the backend records
  // C:\Users\runneradmin\...) would otherwise make every HERMES_HOME match against the sandbox miss.
  const root = canonicalPath(fs.mkdtempSync(path.join(os.tmpdir(), `hermes-e2e-${prefix}-${Math.random()}`)))
  const hermesHome = path.join(root, 'hermes-home')
  const userDataDir = path.join(root, 'electron-user-data')

  fs.mkdirSync(hermesHome, { recursive: true })
  fs.mkdirSync(userDataDir, { recursive: true })

  // Write a fixed window-state.json so the Electron window opens at a
  // consistent size — helps with visual regression screenshots.  The
  // exact size is also enforced right before each screenshot (see
  // expectVisualSnapshot in visual-snapshot.ts) because window managers
  // may resize after launch.
  fs.writeFileSync(
    path.join(userDataDir, 'window-state.json'),
    JSON.stringify(
      { x: 0, y: 0, width: 1220, height: 800, isMaximized: false },
      null,
      2,
    ),
    'utf8',
  )

  // Pin Chromium actual-size zoom (level 0) for the suite. Playwright click
  // hit-testing and the committed visual baselines were calibrated at 100%,
  // so the suite must not drift if the product default (DEFAULT_ZOOM_LEVEL)
  // ever moves off 100% again.
  fs.writeFileSync(
    path.join(userDataDir, 'zoom-state.json'),
    JSON.stringify({ zoomLevel: 0 }, null, 2),
    'utf8',
  )

  return {
    root,
    hermesHome,
    userDataDir,
    cleanup: () => {
      try {
        // Desktop attaches to the gateway it ensured and never stops it: a daemon left running keeps
        // writing into (and, on Windows, locking) this sandbox, so stop it before removing anything. A
        // daemon that cannot be stopped throws: an orphan must not go unnoticed.
        stopSandboxGatewayDaemons({ hermesHome })
      } finally {
        try {
          fs.rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 })
        } catch {
          // best-effort
        }
      }
    },
  }
}

// ─── Sandbox gateway daemon ────────────────────────────────────────────

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
  } catch (error) {
    // EPERM: it exists but is not ours to signal; only ESRCH means gone.
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }

  // A zombie (dead, not yet reaped: a container without an init) still answers signal 0. Without /proc (Windows,
  // macOS) there are no zombies to tell apart.
  try {
    return !/^\d+ \(.*\) Z/.test(fs.readFileSync(`/proc/${pid}/stat`, 'utf8'))
  } catch {
    return true
  }
}

/**
 * Whether `pid` is this sandbox's gateway and not an unrelated process that inherited a stale lock's pid.
 * Linux reads the process environment (it must name the sandbox home); Windows and macOS have no readable
 * foreign environment, so the lock's own `hermes_home` plus the image/command name is the proof.
 */
function isSandboxGateway(pid: number, hermesHome: string): boolean {
  if (fs.existsSync('/proc/self/environ')) {
    try {
      return fs.readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0').includes(`HERMES_HOME=${hermesHome}`)
    } catch {
      return false
    }
  }

  const probe =
    process.platform === 'win32'
      ? spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8', timeout: 30_000, windowsHide: true })
      : spawnSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8', timeout: 30_000 })

  return process.platform === 'win32' ? /python/i.test(probe.stdout ?? '') : /hermes_cli/.test(probe.stdout ?? '')
}

interface GatewayLockRecord {
  hermes_home?: string
  pid?: number
}

/**
 * The record the gateway daemon wrote into the sandbox's `gateway.lock` (its pid and its canonical HERMES_HOME), or
 * null when there is none: the daemon never booted (no file) or died before writing one (an empty file). A record
 * that cannot be read is an error, never "no gateway": a daemon we cannot see is a daemon we cannot stop.
 */
function readGatewayLock(hermesHome: string): GatewayLockRecord | null {
  const file = path.join(hermesHome, 'gateway.lock')

  for (let attempt = 0; ; attempt += 1) {
    try {
      const text = fs.readFileSync(file, 'utf8')

      return text.trim() ? (JSON.parse(text) as GatewayLockRecord) : null
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return null
      }

      // A daemon rewrites its record at boot (truncate, then write): a read in between sees it partial.
      if (error instanceof SyntaxError && attempt < 10) {
        sleepSync(100)

        continue
      }

      throw new Error(`cannot read the sandbox gateway lock ${file}: ${(error as Error).message}`)
    }
  }
}

/**
 * The pid of the live gateway daemon of this sandbox, or null when none runs (it never booted, or it exited: a
 * stopped daemon leaves its record behind). A live process that holds the sandbox's lock but is not provably this
 * sandbox's gateway throws instead of being ignored or killed on a guess.
 */
export function sandboxGatewayPid(hermesHome: string): number | null {
  const lock = readGatewayLock(hermesHome)
  const pid = Number(lock?.pid)

  if (!lock || !Number.isInteger(pid) || pid <= 0 || !processAlive(pid)) {
    return null
  }

  // The daemon records its CANONICAL home (a Windows 8.3 short name is expanded): compare canonical spellings.
  if (lock.hermes_home && !samePath(lock.hermes_home, hermesHome)) {
    throw new Error(`live pid ${pid} holds ${hermesHome}/gateway.lock but records the home ${lock.hermes_home}`)
  }

  if (!isSandboxGateway(pid, hermesHome)) {
    throw new Error(`live pid ${pid} holds ${hermesHome}/gateway.lock but is not a Hermes gateway process`)
  }

  return pid
}

/**
 * Stop the detached `gateway run` daemon `hermes gateway ensure` started for this sandbox: SIGTERM, then SIGKILL
 * after 15 s; on Windows (no graceful signal) the daemon and its children end at once. Returns the pid it stopped,
 * or null when none ran, and throws when the daemon is still alive afterwards. A fresh backend after this is a NEW
 * process: the next launch's ensure starts another one.
 */
export function stopSandboxGatewayDaemons(sandbox: Pick<Sandbox, 'hermesHome'>): number | null {
  const pid = sandboxGatewayPid(sandbox.hermesHome)

  if (pid === null) {
    return null
  }

  const signal = (sig: NodeJS.Signals) => {
    try {
      process.kill(pid, sig)
    } catch {
      // Already gone.
    }
  }

  const waitGone = (seconds: number) => {
    for (const deadline = Date.now() + seconds * 1000; processAlive(pid) && Date.now() < deadline; ) {
      sleepSync(100)
    }
  }

  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { timeout: 30_000, windowsHide: true })
  } else {
    signal('SIGTERM')
    waitGone(15)

    if (processAlive(pid)) {
      signal('SIGKILL')
    }
  }

  waitGone(10)

  if (processAlive(pid)) {
    throw new Error(`the sandbox gateway (pid ${pid}) is still running after it was stopped`)
  }

  return pid
}

// ─── Config writing ─────────────────────────────────────────────────────


/**
 * Write an empty config (no providers). The desktop app should show the
 * onboarding overlay because no inference provider is configured.
 */
function writeEmptyConfig(hermesHome: string): void {
  const configPath = path.join(hermesHome, 'config.yaml')
  fs.writeFileSync(configPath, '# Auto-generated by E2E test fixtures — no providers configured\n', 'utf8')
}

// ─── Env building ──────────────────────────────────────────────────────

/**
 * Build the environment for the Electron app process.
 *
 * Key env vars:
 *  - HERMES_HOME → sandbox hermes-home (isolated config/sessions)
 *  - HERMES_DESKTOP_USER_DATA_DIR → sandbox electron-user-data
 *  - HERMES_DESKTOP_IGNORE_EXISTING=1 → skip the installed runtime
 *    (we want the dev checkout at REPO_ROOT)
 *  - HERMES_DESKTOP_HERMES_ROOT → REPO_ROOT (dev checkout resolution)
 *  - HERMES_DESKTOP_APP_NAME → unique-ish per test (avoids single-instance lock)
 *  - HOME, HERMES_GATEWAY_LOCK_DIR (and on Windows USERPROFILE / HOMEDRIVE / HOMEPATH), see `sandboxHomeEnv`
 *    → the sandbox is the process's home and holds its host-wide gateway lock
 *  - XDG_RUNTIME_DIR → ensure Electron has a writable runtime dir on Linux
 */
export function buildAppEnv(sandbox: Sandbox, extra: Record<string, string> = {}): Record<string, string> {
  const clean = stripCredentials(process.env)

  // XDG_RUNTIME_DIR is needed for Electron on Linux when running in a
  // headless/CI context — without it the zygote may fail to initialize.
  if (!clean.XDG_RUNTIME_DIR && process.env.XDG_RUNTIME_DIR) {
    clean.XDG_RUNTIME_DIR = process.env.XDG_RUNTIME_DIR
  }

  // DISPLAY — needed for Electron to open a window.
  if (!clean.DISPLAY && process.env.DISPLAY) {
    clean.DISPLAY = process.env.DISPLAY
  }

  return {
    ...clean,
    HERMES_HOME: sandbox.hermesHome,
    HERMES_DESKTOP_USER_DATA_DIR: sandbox.userDataDir,
    HERMES_DESKTOP_IGNORE_EXISTING: '1',
    // One `hermes serve` per host (its rendezvous lock lives under the OS user's state dir, not under HERMES_HOME),
    // and anything that resolves the NATIVE Hermes home (`~/.hermes`) instead of HERMES_HOME is anchored to HOME
    // (with HERMES_HOME set, the profiles root follows it: hermes_constants.get_default_hermes_root): without both
    // of these a local e2e run attaches to the developer's running backend or reads and writes their real home,
    // and chats through their real model and state.db instead of the sandbox + mock provider. CI never has
    // either, so only local runs ever took that path.
    HERMES_DESKTOP_ISOLATED_BACKEND: '1',
    HOME: sandbox.root,
    ...sandboxHomeEnv(sandbox.root),
    HERMES_DESKTOP_HERMES_ROOT: REPO_ROOT,
    HERMES_DESKTOP_APP_NAME: `HermesE2E-${Date.now()}`,
    // `app.close()` in teardown must exit even when a spec leaves a turn
    // mid-flight — otherwise the quit confirmation waits on a click that no
    // one is there to make, and the worker dies on a teardown timeout.
    HERMES_DESKTOP_SKIP_QUIT_CONFIRM: '1',
    // Never repoint the user's OS hermes:// handler (HKCU on Windows) at a test checkout.
    HERMES_DESKTOP_SKIP_PROTOCOL_REGISTRATION: '1',
    // Clear dev-server override — we want the built dist/, not a vite server.
    // The dev-server check in main.ts looks for this env var; if it's set,
    // it loads from the vite URL instead of the local file.
    ...extra,
  }
}

// ─── Electron launch ────────────────────────────────────────────────────

/**
 * Verify that the desktop app has been built (dist/ exists). Playwright
 * tests can't run without it — the Electron main process loads
 * dist/electron-main.mjs and the renderer loads dist/index.html.
 */
function assertDistBuilt(): void {
  const distDir = path.join(DESKTOP_ROOT, 'dist')
  const electronMain = path.join(distDir, 'electron-main.mjs')
  const indexHtml = path.join(distDir, 'index.html')

  if (!fs.existsSync(electronMain)) {
    throw new Error(
      `Desktop dist not built. Run 'cd apps/desktop && npm run build' first.\n` +
        `Missing: ${electronMain}`,
    )
  }

  if (!fs.existsSync(indexHtml)) {
    throw new Error(
      `Desktop dist/index.html not found. Run 'cd apps/desktop && npm run build' first.\n` +
        `Missing: ${indexHtml}`,
    )
  }
}

/**
 * Find the Electron binary. In the nix devshell, `electron` is on PATH.
 * As a fallback, use the node_modules/electron install from either package.
 */
export function findElectron(): string {
  // In dev mode, we use the `electron` binary directly (not the packaged app).
  // The dev:electron script in package.json does exactly this: `electron .`
  // after building. We replicate that here.
  //
  // The desktop package is searched first: npm workspaces only hoist
  // `electron` to the repo root when nothing conflicts, so a workspace-local
  // install is just as ordinary an outcome as a hoisted one. The rules live in
  // ./electron-binary so they can be unit-tested per platform.
  return resolveElectronBinary([DESKTOP_ROOT, REPO_ROOT])
}

/**
 * Launch the desktop app in dev mode.
 *
 * @param sandbox  - isolated HERMES_HOME + userData
 * @param env      - the process environment (already has HERMES_HOME etc.)
 * @returns the ElectronApplication + first Page
 */
export async function launchDesktop(
  env: Record<string, string>,
): Promise<{ app: ElectronApplication; page: Page }> {
  assertDistBuilt()

  const electronBin = findElectron()

  // `electron .` loads from the package.json `main` field
  // (dist/electron-main.mjs after build).
  // The app resolves its own userData from HERMES_DESKTOP_USER_DATA_DIR. The switch is belt and braces: it
  // keeps anything that asks Electron for the default userData (%APPDATA%\<app name> on Windows: the real
  // installed app's data) before or around that resolution inside the sandbox too. The default-path creators
  // the Windows baseline run found were app code (a module-scope call in link-metadata.ts, the override
  // derivation in main.ts, the product-identity mkdir), not Electron itself.
  const userDataDir = env.HERMES_DESKTOP_USER_DATA_DIR

  const app = await _electron.launch({
    executablePath: electronBin,
    args: [
      DESKTOP_ROOT, // `electron .` — the `.` is the desktop package dir
      '--disable-gpu',
      '--no-sandbox',
      ...(userDataDir ? [`--user-data-dir=${userDataDir}`] : []),
    ],
    env,
    cwd: DESKTOP_ROOT,
  })

  const page = await app.firstWindow()

  // Install the error-banner guard so any [role="alert"] that appears
  // during a test is collected and surfaced in afterEach.
  installErrorBannerGuard(page)

  return { app, page }
}

// ─── Public fixtures ────────────────────────────────────────────────────

export interface MockBackendFixture {
  app: ElectronApplication
  page: Page
  mock: Awaited<ReturnType<typeof startMockServer>>
  mockUrl: string
  sandbox: Sandbox
  cleanup: () => Promise<void>
}

export interface MockBackendOptions {
  /**
   * Script and stream behavior for the mock inference server.
   */
  mockServer?: MockServerOptions
  /**
   * Optional YAML lines to inject under the `display:` section of the
   * generated config.yaml. Used by the interim-message e2e test to toggle
   * `display.interim_assistant_messages`.
   */
  extraDisplayConfig?: string
  /** Additional top-level config.yaml sections for an E2E scenario. */
  extraConfig?: string
  /** Override the mock model's context window for compression scenarios. */
  modelContextLength?: number
}

/**
 * Set up a full mock-backend E2E environment:
 *   1. Start the mock inference server
 *   2. Create a sandbox with config.yaml pointing at it
 *   3. Launch the desktop app
 *   4. Return handles for test interaction
 */

export async function setupMockBackend(options: MockBackendOptions = {}): Promise<MockBackendFixture> {
  // 1. Start mock server
  const mock = await startMockServer(options.mockServer)

  // 2. Create sandbox + write config
  const sandbox = createSandbox('mock')
  writeMockProviderConfig(
    sandbox.hermesHome,
    mock.url,
    options.extraDisplayConfig,
    options.extraConfig,
    options.modelContextLength,
  )
  writeEnvFile(sandbox.hermesHome)

  // 3. Build env + launch
  const env = buildAppEnv(sandbox)
  const { app, page } = await launchDesktop(env)

  const fixture: MockBackendFixture = {
    app,
    page,
    mock,
    mockUrl: mock.url,
    sandbox,
    cleanup: async () => {
      // `fixture.app`, not the first launch: `relaunchDesktop` replaces it in place.
      await fixture.app.close().catch(() => undefined)

      // The gateway outlives the app (attach mode): stop it, then keep its logs for the evidence artifact
      // (pass or fail), then drop the sandbox. A daemon that cannot be stopped still gets its logs kept and its
      // sandbox dropped, and then fails the teardown.
      try {
        stopSandboxGatewayDaemons(sandbox)
      } finally {
        preserveSandboxLogs(sandbox)
        await mock.close()
        sandbox.cleanup()
      }
    },
  }

  return fixture
}

/**
 * Copy the sandbox backend's `<HERMES_HOME>/logs` to `$HERMES_E2E_EVIDENCE_DIR/backend-logs/<sandbox>/` when an
 * evidence directory is set, so a failure on a runner that is gone tomorrow can still be diagnosed. Synthetic
 * sandbox only; best-effort, never fails a test.
 */
export function preserveSandboxLogs(sandbox: Pick<Sandbox, 'hermesHome' | 'root'>): void {
  const evidence = process.env.HERMES_E2E_EVIDENCE_DIR
  const logs = path.join(sandbox.hermesHome, 'logs')

  if (!evidence || !fs.existsSync(logs)) {
    return
  }

  try {
    fs.cpSync(logs, path.join(evidence, 'backend-logs', path.basename(sandbox.root)), { recursive: true })
  } catch {
    // best-effort
  }
}

/**
 * Quit the app and start it again on the SAME sandbox (same HERMES_HOME, same Electron user data, so the
 * same localStorage and the same session store). With `freshBackend` the sandbox's gateway daemon is stopped
 * in between, so the next launch's `gateway ensure` starts a NEW backend process; the old pid is returned.
 * `fixture.app` / `fixture.page` are replaced in place.
 */
export async function relaunchDesktop(
  fixture: MockBackendFixture,
  { freshBackend = false, timeoutMs = 120_000 }: { freshBackend?: boolean; timeoutMs?: number } = {},
): Promise<{ stoppedGatewayPid: number | null }> {
  await fixture.app.close().catch(() => undefined)
  const stoppedGatewayPid = freshBackend ? stopSandboxGatewayDaemons(fixture.sandbox) : null
  const relaunched = await launchDesktop(buildAppEnv(fixture.sandbox))

  fixture.app = relaunched.app
  fixture.page = relaunched.page
  await waitForAppReady(fixture, timeoutMs)

  return { stoppedGatewayPid }
}

export interface NoProviderFixture {
  app: ElectronApplication
  page: Page
  sandbox: Sandbox
  cleanup: () => Promise<void>
}

/**
 * Launch the app with no provider configured. The onboarding overlay should
 * appear because there's no inference provider in config.yaml.
 */
export async function setupNoProvider(): Promise<NoProviderFixture> {
  const sandbox = createSandbox('noprovider')
  writeEmptyConfig(sandbox.hermesHome)

  const env = buildAppEnv(sandbox)
  const { app, page } = await launchDesktop(env)

  return {
    app,
    page,
    sandbox,
    cleanup: async () => {
      await app.close().catch(() => undefined)
      sandbox.cleanup()
    },
  }
}

export interface DeadBackendFixture {
  app: ElectronApplication
  page: Page
  sandbox: Sandbox
  cleanup: () => Promise<void>
}

export interface DeadBackendOptions {
  /**
   * When true, inject a fake boot error via HERMES_DESKTOP_BOOT_FAKE_ERROR
   * so the backend resolution itself "fails" with a controlled error message.
   * This is the only reliable way to trigger BootFailureOverlay in dev mode
   * (the real backend always resolves via SOURCE_REPO_ROOT).
   */
  fakeError?: boolean
}

/**
 * Launch the app with a provider pointing at a dead endpoint (port 1, which
 * nothing listens on). By default the backend still boots (`hermes serve`
 * starts fine — the dead endpoint only matters at chat time). Pass
 * `{ fakeError: true }` to inject a fake boot failure, triggering the
 * BootFailureOverlay.
 */
export async function setupDeadBackend(options: DeadBackendOptions = {}): Promise<DeadBackendFixture> {
  const sandbox = createSandbox('dead')
  // Same writer the install-e2e harness uses, pointed at a dead endpoint: one
  // shape for "an external OpenAI-compatible provider", never a named 'mock'.
  const deadUrl = 'http://127.0.0.1:1'
  writeMockProviderConfig(sandbox.hermesHome, deadUrl)
  writeEnvFile(sandbox.hermesHome, 'e2e-mock-key', deadUrl)

  const env = buildAppEnv(sandbox, options.fakeError ? { HERMES_DESKTOP_BOOT_FAKE_ERROR: 'Failed to connect to Hermes backend: connection refused' } : {})
  const { app, page } = await launchDesktop(env)

  return {
    app,
    page,
    sandbox,
    cleanup: async () => {
      await app.close().catch(() => undefined)
      sandbox.cleanup()
    },
  }
}

// ─── Packaged-binary fixture ───────────────────────────────────────────

/**
 * Resolve the packaged Electron binary path, per-platform, matching
 * electron-builder's output layout under release/.
 */
function resolvePackagedBinaryPath(): string {
  if (process.platform === 'win32') {
    return path.join(RELEASE_ROOT, 'win-unpacked', 'Hermes.exe')
  }

  if (process.platform === 'darwin') {
    const arch = process.arch === 'arm64' ? 'arm64' : 'x64'

    return path.join(RELEASE_ROOT, `mac-${arch}`, 'Hermes.app', 'Contents', 'MacOS', 'Hermes')
  }

  return path.join(RELEASE_ROOT, 'linux-unpacked', 'hermes')
}

export const PACKAGED_BINARY_PATH = resolvePackagedBinaryPath()

export function packagedBinaryExists(): boolean {
  return fs.existsSync(PACKAGED_BINARY_PATH)
}

export interface PackagedAppFixture {
  app: ElectronApplication
  page: Page
  sandbox: Sandbox
  cleanup: () => Promise<void>
}

/**
 * Launch the *packaged* Electron binary (from `npm run pack` →
 * `electron-builder --dir`) with `BOOT_FAKE=1` so it simulates boot
 * progress without spawning a real Hermes backend.
 *
 * Uses the same sandbox isolation (credential stripping, isolated
 * HERMES_HOME + userData, unique app name) as the dev-mode fixtures.
 *
 * Skips if the packaged binary doesn't exist — run `npm run pack` first.
 */
export async function setupPackagedApp(): Promise<PackagedAppFixture> {
  if (!packagedBinaryExists()) {
    throw new Error(
      `Built app binary not found: ${PACKAGED_BINARY_PATH}. Run 'npm run pack' first.`,
    )
  }

  const sandbox = createSandbox('packaged')

  // Build the sandbox env using the shared helpers, then add the
  // packaged-binary-specific overrides.
  const env = buildAppEnv(sandbox, {
    // Fake boot: simulates progress steps without spawning the real backend.
    HERMES_DESKTOP_BOOT_FAKE: '1',
    HERMES_DESKTOP_BOOT_FAKE_STEP_MS: '120',
  })

  // Clear dev-server + hermes-root overrides — the packaged binary
  // should use its own bundled renderer, not the dev checkout.
  delete (env as Record<string, string | undefined>).HERMES_DESKTOP_DEV_SERVER
  delete (env as Record<string, string | undefined>).HERMES_DESKTOP_HERMES
  delete (env as Record<string, string | undefined>).HERMES_DESKTOP_HERMES_ROOT

  const app = await _electron.launch({
    executablePath: PACKAGED_BINARY_PATH,
    args: ['--disable-gpu', '--no-sandbox', `--user-data-dir=${sandbox.userDataDir}`],
    env,
  })

  const page = await app.firstWindow()
  installErrorBannerGuard(page)

  return {
    app,
    page,
    sandbox,
    cleanup: async () => {
      await app.close().catch(() => undefined)
      sandbox.cleanup()
    },
  }
}

// ─── Wait helpers ──────────────────────────────────────────────────────

/** Composer readiness includes hit testing, so boot overlays cannot produce an early pass. */
export async function waitForAppReady(fixture: MockBackendFixture | NoProviderFixture | DeadBackendFixture, timeoutMs = 60_000): Promise<void> {
  const { page, app } = fixture

  await waitForChatReady(page, timeoutMs)

  // On Electron 40.x, ready-to-show may never fire (electron/electron#51972)
  // and the window stays hidden even though the DOM is rendered. The main
  // process reveals it anyway — immediately under TEST_WORKER_INDEX, and via
  // wireWindowReveal's post-load fallback in production — but the DOM can be
  // ready before that lands. Poll until the window is actually visible so
  // interactions (click, screenshot) don't hit a hidden surface.
  if (app) {
    const deadline = Date.now() + timeoutMs

    while (Date.now() < deadline) {
      const visible = await app.evaluate(({ BrowserWindow }) => {
        const w = BrowserWindow.getAllWindows()[0]

        return w ? w.isVisible() : false
      }).catch(() => false)

      if (visible) {break}
      await page.waitForTimeout(500)
    }
  }
}

/**
 * Wait for the onboarding overlay to appear (no provider configured).
 */
export async function waitForOnboarding(page: Page, timeoutMs = 60_000): Promise<void> {
  // The onboarding overlay contains a heading with "Choose your provider"
  // or similar text. We look for any text that indicates the picker.
  await page.waitForFunction(
    () => {
      const root = document.getElementById('root')

      if (!root) {
        return false
      }

      const text = root.textContent ?? ''

      return (
        text.includes('provider') ||
        text.includes('Provider') ||
        text.includes('Choose') ||
        text.includes('API key') ||
        text.includes('Sign in')
      )
    },
    undefined,
    { timeout: timeoutMs },
  )
}

/**
 * Wait for the boot failure overlay to appear.
 */
export async function waitForBootFailure(page: Page, timeoutMs = 60_000): Promise<void> {
  await page.waitForFunction(
    () => {
      // Boot failure is terminal: the backend gave up. The renderer shows
      // either BootFailureOverlay (z-1400, with Retry/Repair buttons) or
      // falls back to the onboarding picker (z-1300) as a recovery path.
      // We wait for the failure dialog itself — the Preparing component may
      // still paint its progress bar (recolored red) underneath the overlay,
      // which is harmless.
      const text = document.body.textContent ?? ''

      // BootFailureOverlay buttons.
      const hasFailureUI =
        text.includes('Retry') ||
        text.includes('Repair') ||
        text.includes('Use local gateway') ||
        text.includes('Connection settings')

      // The error toast / notification that fires on failDesktopBoot().
      const hasErrorToast = text.includes('Desktop boot failed')

      return hasFailureUI || hasErrorToast
    },
    undefined,
    { timeout: timeoutMs },
  )
}
