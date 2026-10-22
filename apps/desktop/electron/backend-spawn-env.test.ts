import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'

import { test } from 'vitest'

import { commitBuildGatewayScope, commitBuildScopedResolver, desktopBackendSpawnEnv } from './backend-spawn-env'
import { buildTerminalScript, posixQuote, terminalScriptEnv } from './external-terminal'
import type { InstallStamp } from './install-stamp'
import { runGatewayEnsure } from './local-gateway'

test('desktopBackendSpawnEnv keeps the base env and stamps stay_alive last', () => {
  const base = {
    HERMES_HOME: '/tmp/home',
    HERMES_DESKTOP: '1',
    GATEWAY_ON_ALL_ADAPTERS_DOWN: 'exit',
    PATH: '/usr/bin'
  }

  const env = desktopBackendSpawnEnv(base)

  assert.equal(env.HERMES_HOME, base.HERMES_HOME)
  assert.equal(env.HERMES_DESKTOP, base.HERMES_DESKTOP)
  assert.equal(env.PATH, base.PATH)
  // The desktop spawns `hermes serve` with no supervising service manager, so the
  // child must stay alive on all-adapters-down instead of exiting EX_TEMPFAIL
  // (#118080). Stamped unconditionally — an inherited value cannot opt the child
  // back into the failure exit.
  assert.equal(env.GATEWAY_ON_ALL_ADAPTERS_DOWN, 'stay_alive')
})

type Source = InstallStamp['source']

const HOME: string = path.join(os.tmpdir(), 'hermes-commit-build-home')
const OWN_LOCK_DIR: string = path.join(HOME, 'gateway-locks')
const PRINT_LOCK_DIR = 'process.stdout.write(process.env.HERMES_GATEWAY_LOCK_DIR ?? "<unset>")'

// Every stamp source except a commit build. A new source must be listed here (nothing changes for it) or join the
// commit-build rule: the type forces that decision.
const UNCHANGED: Record<Exclude<Source, 'commit-build'>, true> = {
  build: true,
  'channel-build': true,
  ci: true,
  docker: true,
  fallback: true,
  git: true,
  local: true,
  nix: true,
  unknown: true
}

interface Backend {
  args: string[]
  command: string
  env: NodeJS.ProcessEnv
  shell: boolean
}

const bareBackend = (): Backend => ({ args: ['-e', PRINT_LOCK_DIR], command: process.execPath, env: {}, shell: false })

/** What a real child process started the way the Desktop starts its gateway clients sees in HERMES_GATEWAY_LOCK_DIR. */
async function lockDirSeenByChild(source: Source | undefined, inherited?: string): Promise<string> {
  const parentEnv: NodeJS.ProcessEnv = { ...process.env }

  delete parentEnv.HERMES_GATEWAY_LOCK_DIR

  if (inherited !== undefined) {
    parentEnv.HERMES_GATEWAY_LOCK_DIR = inherited
  }

  const backend = commitBuildGatewayScope(bareBackend(), { env: parentEnv, hermesHome: HOME, source })

  const result = await runGatewayEnsure(
    { ...backend, env: desktopBackendSpawnEnv(backend.env) },
    process.cwd(),
    HOME,
    parentEnv
  )

  assert.equal(result.code, 0, result.stderr)

  return result.stdout
}

test('a commit build gives its gateway children a lock directory inside its own Hermes home', async () => {
  const original = bareBackend()
  const scoped = commitBuildGatewayScope(original, { env: {}, hermesHome: HOME, source: 'commit-build' })

  assert.equal(scoped.env.HERMES_GATEWAY_LOCK_DIR, OWN_LOCK_DIR)
  assert.deepEqual(original.env, {}, 'the resolved backend is not mutated')
  assert.equal(await lockDirSeenByChild('commit-build'), OWN_LOCK_DIR)
})

test('the open-in-terminal TUI of a commit build exports the same lock directory', () => {
  const tui = (source: Source | undefined): string =>
    buildTerminalScript({
      args: ['--tui'],
      command: '/hermes',
      cwd: '/work',
      env: terminalScriptEnv(commitBuildGatewayScope(bareBackend(), { env: {}, hermesHome: HOME, source }).env, HOME),
      platform: 'linux'
    })

  assert.ok(tui('commit-build').includes(`export HERMES_GATEWAY_LOCK_DIR=${posixQuote(OWN_LOCK_DIR)}`))
  assert.doesNotMatch(tui('ci'), /HERMES_GATEWAY_LOCK_DIR/)
})

test('a lock directory the environment already chose wins, and an empty one is no choice', async () => {
  const chosen: string = path.join(os.tmpdir(), 'chosen-gateway-locks')
  const backend = bareBackend()

  assert.equal(
    commitBuildGatewayScope(backend, {
      env: { HERMES_GATEWAY_LOCK_DIR: chosen },
      hermesHome: HOME,
      source: 'commit-build'
    }),
    backend
  )
  assert.equal(await lockDirSeenByChild('commit-build', chosen), chosen)
  // The gateway reads an empty HERMES_GATEWAY_LOCK_DIR as unset, so the build still gets its own.
  assert.equal(await lockDirSeenByChild('commit-build', ''), OWN_LOCK_DIR)
})

test('every other build, and a dev bundle with no stamp, is left exactly as it was', async () => {
  const sources: (Source | undefined)[] = [...(Object.keys(UNCHANGED) as Source[]), null, undefined]

  for (const source of sources) {
    const backend = bareBackend()

    assert.equal(
      commitBuildGatewayScope(backend, { env: {}, hermesHome: HOME, source }),
      backend,
      `source=${source}: the same backend object comes back`
    )
    assert.equal(await lockDirSeenByChild(source), '<unset>', `source=${source}: no lock directory is introduced`)
  }
})

test('a commit build without a Hermes home does not invent a relative lock directory', () => {
  const backend = bareBackend()

  assert.equal(commitBuildGatewayScope(backend, { env: {}, hermesHome: '', source: 'commit-build' }), backend)
})

test('the resolver the app spawns from scopes what it resolves for a commit build and passes its arguments through', async () => {
  const resolved = bareBackend()
  const seen: string[][] = []

  const resolve = async (args: string[]): Promise<Backend> => {
    seen.push(args)

    return resolved
  }

  const commit = commitBuildScopedResolver(resolve, { env: {}, hermesHome: HOME, source: 'commit-build' })
  const other = commitBuildScopedResolver(resolve, { env: {}, hermesHome: HOME, source: 'ci' })

  assert.equal((await commit(['gateway', 'ensure', '--json'])).env.HERMES_GATEWAY_LOCK_DIR, OWN_LOCK_DIR)
  assert.equal(await other(['--tui']), resolved)
  assert.deepEqual(seen, [['gateway', 'ensure', '--json'], ['--tui']])
})
