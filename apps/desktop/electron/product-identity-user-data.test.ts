// A run that overrides userData (HERMES_DESKTOP_USER_DATA_DIR: the E2E sandbox and any isolated launch) must not
// leave anything behind in the real appData. applyDesktopIdentity used to pin and create <appData>/<identity name> for
// every nonstable identity (commit, canary, light, bundled builds) before main.ts applied the override, so an isolated
// launch of a candidate build still wrote into %APPDATA% on Windows.
//
// This covers the JavaScript half only. Electron itself creates the default userData directory natively before any
// app code runs; only a `--user-data-dir` switch on the process command line avoids that (see e2e/fixtures.ts).
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, test, vi } from 'vitest'

import { resolveDesktopUserData } from './data-paths'
import type { applyDesktopIdentity, ProductIdentity } from './product-identity'

const require: NodeJS.Require = createRequire(import.meta.url)

const COMMIT = 'abcdef1234567890abcdef1234567890abcdef12'

type FakeApp = Parameters<typeof applyDesktopIdentity>[0]

interface Harness {
  app: FakeApp
  appData: string
  names: string[]
  userDataPins: string[]
  cleanup: () => void
}

function harness(): Harness {
  const root: string = fs.mkdtempSync(path.join(os.tmpdir(), 'identity-userdata-isolation-'))
  const appData: string = path.join(root, 'AppData', 'Roaming')
  fs.mkdirSync(appData, { recursive: true })
  // What Electron reports before any override: the default directory under appData.
  const paths: Record<string, string> = { appData, userData: path.join(appData, 'Hermes') }
  const names: string[] = []
  const userDataPins: string[] = []

  const app: FakeApp = {
    getPath: (key: string): string => paths[key],
    setPath: (key: string, value: string): void => {
      assert.ok(fs.statSync(value).isDirectory(), `Electron refuses a userData path that does not exist: ${value}`)
      userDataPins.push(value)
      paths[key] = value
    },
    setName: (value: string): void => {
      names.push(value)
    }
  }

  return { app, appData, names, userDataPins, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) }
}

async function identityFor(env: Record<string, string>): Promise<ProductIdentity> {
  Object.assign(process.env, env)
  delete require.cache[require.resolve('../product-identity.cjs')]
  vi.resetModules()

  return (await import('./product-identity')).PRODUCT_IDENTITY
}

beforeEach((): void => {
  vi.resetModules()
})

afterEach((): void => {
  delete process.env.HERMES_DESKTOP_VARIANT
  delete process.env.HERMES_PAYLOAD_TAG
  delete process.env.HERMES_BUILD_COMMIT
  vi.resetModules()
})

test('an explicit userData override keeps a nonstable identity out of appData', async (): Promise<void> => {
  const identity: ProductIdentity = await identityFor({ HERMES_BUILD_COMMIT: COMMIT })
  const runtime: { applyDesktopIdentity: typeof applyDesktopIdentity } = await import('./product-identity')
  const { app, appData, names, userDataPins, cleanup } = harness()
  const sandbox: string = fs.mkdtempSync(path.join(os.tmpdir(), 'identity-userdata-sandbox-'))
  const env: NodeJS.ProcessEnv = { HERMES_DESKTOP_USER_DATA_DIR: path.join(sandbox, 'electron-user-data') }

  try {
    assert.notEqual(identity.appNamePascal, identity.artifactNamePascal, 'the fixture must be a nonstable identity')

    assert.equal(runtime.applyDesktopIdentity(app, identity, env), identity.displayName)
    assert.deepEqual(names, [identity.displayName], 'the display name still applies')
    assert.deepEqual(fs.readdirSync(appData), [], 'nothing may be created in the real appData')
    assert.deepEqual(userDataPins, [], 'the identity must not pin a userData the override replaces')

    // main.ts applies the override next: it must resolve to the sandbox, never to appData.
    assert.equal(resolveDesktopUserData(app.getPath('userData'), env), path.resolve(env.HERMES_DESKTOP_USER_DATA_DIR!))
  } finally {
    cleanup()
    fs.rmSync(sandbox, { recursive: true, force: true })
  }
})

test('without an override a nonstable identity still owns its userData, which a data-dir suffix extends', async (): Promise<void> => {
  const identity: ProductIdentity = await identityFor({ HERMES_BUILD_COMMIT: COMMIT })
  const runtime: { applyDesktopIdentity: typeof applyDesktopIdentity } = await import('./product-identity')
  const { app, appData, names, userDataPins, cleanup } = harness()
  const env: NodeJS.ProcessEnv = { HERMES_DATA_DIR_SUFFIX: '-rehearsal' }

  try {
    assert.equal(runtime.applyDesktopIdentity(app, identity, env), identity.displayName)

    const pinned: string = path.join(appData, identity.appNamePascal)
    assert.deepEqual(userDataPins, [pinned])
    assert.ok(fs.statSync(pinned).isDirectory())
    assert.deepEqual(names, [identity.displayName])
    // The suffix is appended to the identity's directory, not to Electron's default one.
    assert.equal(resolveDesktopUserData(app.getPath('userData'), env), `${pinned}-rehearsal`)
  } finally {
    cleanup()
  }
})

test('a stable identity touches nothing, with or without an override', async (): Promise<void> => {
  const identity: ProductIdentity = await identityFor({})
  const runtime: { applyDesktopIdentity: typeof applyDesktopIdentity } = await import('./product-identity')
  const { app, appData, names, userDataPins, cleanup } = harness()

  try {
    assert.equal(runtime.applyDesktopIdentity(app, identity, { HERMES_DESKTOP_USER_DATA_DIR: path.join(appData, 'x') }), null)
    assert.equal(runtime.applyDesktopIdentity(app, identity, {}), null)
    assert.deepEqual([names, userDataPins, fs.readdirSync(appData)], [[], [], []])
  } finally {
    cleanup()
  }
})
