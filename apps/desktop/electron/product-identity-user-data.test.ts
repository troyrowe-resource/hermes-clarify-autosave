// A run that overrides userData (HERMES_DESKTOP_USER_DATA_DIR: the E2E sandbox and any isolated launch) must not leave
// anything behind in the real appData, which on Windows is %APPDATA%: the installed app's own data.
//
// Two things used to put a directory there before the override took effect:
//  - applyDesktopIdentity pinned and created <appData>/<identity name> for every nonstable identity (commit, canary,
//    light and bundled builds);
//  - the override was derived from app.getPath('userData'), and so were the modules main.ts imports ahead of it
//    (link-metadata reads it when it is imported). Electron CREATES its default userData directory the first time
//    anything asks for it, which the fake app below reproduces.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, test, vi } from 'vitest'

import type { applyDesktopIdentity, applyDesktopUserData, ProductIdentity } from './product-identity'

type UserDataApp = Parameters<typeof applyDesktopUserData>[0]

// The Electron app that desktop-user-data-boot imports, backed by whichever fake the running test installed.
const electron: { app: UserDataApp | null } = vi.hoisted(() => ({ app: null }))

vi.mock('electron', () => ({
  app: {
    getPath: (name: 'appData' | 'userData'): string => electron.app!.getPath(name),
    setPath: (name: 'userData', value: string): void => electron.app!.setPath(name, value),
    setName: (name: string): void => electron.app!.setName(name)
  }
}))

const require: NodeJS.Require = createRequire(import.meta.url)

const COMMIT = 'abcdef1234567890abcdef1234567890abcdef12'
const IDENTITY_ENV: string[] = ['HERMES_DESKTOP_VARIANT', 'HERMES_PAYLOAD_TAG', 'HERMES_BUILD_COMMIT']
const USER_DATA_ENV: string[] = ['HERMES_DESKTOP_USER_DATA_DIR', 'HERMES_DATA_DIR_SUFFIX']

// A stable identity keeps Electron's own userData and name; any other (commit, canary, light, bundled) owns a directory.
const IDENTITIES: { label: string; env: Record<string, string>; nonstable: boolean }[] = [
  { label: 'stable', env: {}, nonstable: false },
  { label: 'nonstable', env: { HERMES_BUILD_COMMIT: COMMIT }, nonstable: true }
]

interface Harness {
  app: UserDataApp
  appData: string
  defaultUserData: string
  names: string[]
  pins: string[]
  cleanup: () => void
}

function harness(): Harness {
  const root: string = fs.mkdtempSync(path.join(os.tmpdir(), 'identity-userdata-isolation-'))
  const appData: string = path.join(root, 'AppData', 'Roaming')
  const defaultUserData: string = path.join(appData, 'Hermes')
  const names: string[] = []
  const pins: string[] = []
  let pinned: string | null = null

  fs.mkdirSync(appData, { recursive: true })

  const app: UserDataApp = {
    getPath: (name: 'appData' | 'userData'): string => {
      if (name === 'appData') {
        return appData
      }

      if (pinned === null) {
        // Electron's behaviour (40.x): looking the unset userData up creates the directory.
        fs.mkdirSync(defaultUserData, { recursive: true })

        return defaultUserData
      }

      return pinned
    },
    setPath: (_name: 'userData', value: string): void => {
      assert.ok(fs.statSync(value).isDirectory(), `Electron refuses a userData path that does not exist: ${value}`)
      pins.push(value)
      pinned = value
    },
    setName: (value: string): void => {
      names.push(value)
    }
  }

  return { app, appData, defaultUserData, names, pins, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) }
}

async function identityFor(env: Record<string, string>, nonstable: boolean): Promise<ProductIdentity> {
  for (const key of IDENTITY_ENV) {
    delete process.env[key]
  }

  Object.assign(process.env, env)
  delete require.cache[require.resolve('../product-identity.cjs')]
  vi.resetModules()

  const identity: ProductIdentity = (await import('./product-identity')).PRODUCT_IDENTITY

  assert.equal(identity.appNamePascal !== identity.artifactNamePascal, nonstable, 'the fixture identity is not as labelled')

  return identity
}

beforeEach((): void => {
  vi.resetModules()
  electron.app = null
})

afterEach((): void => {
  for (const key of [...IDENTITY_ENV, ...USER_DATA_ENV]) {
    delete process.env[key]
  }

  vi.resetModules()
})

test('an explicit override keeps a nonstable identity from pinning its own directory in appData', async (): Promise<void> => {
  const identity: ProductIdentity = await identityFor({ HERMES_BUILD_COMMIT: COMMIT }, true)
  const runtime: { applyDesktopIdentity: typeof applyDesktopIdentity } = await import('./product-identity')
  const { app, appData, names, pins, cleanup } = harness()

  try {
    assert.equal(
      runtime.applyDesktopIdentity(app, identity, { HERMES_DESKTOP_USER_DATA_DIR: path.join(appData, 'sandbox') }),
      identity.displayName
    )
    assert.deepEqual(names, [identity.displayName], 'the display name still applies')
    assert.deepEqual(pins, [], 'the identity must not pin a userData the override replaces')
    assert.deepEqual(fs.readdirSync(appData), [], 'nothing may be created in the real appData')
  } finally {
    cleanup()
  }
})

test('a stable identity touches nothing when the identity alone is applied, override or not', async (): Promise<void> => {
  const identity: ProductIdentity = await identityFor({}, false)
  const runtime: { applyDesktopIdentity: typeof applyDesktopIdentity } = await import('./product-identity')
  const { app, appData, names, pins, cleanup } = harness()

  try {
    assert.equal(
      runtime.applyDesktopIdentity(app, identity, { HERMES_DESKTOP_USER_DATA_DIR: path.join(appData, 'x') }),
      null
    )
    assert.equal(runtime.applyDesktopIdentity(app, identity, {}), null)
    assert.deepEqual([names, pins, fs.readdirSync(appData)], [[], [], []])
  } finally {
    cleanup()
  }
})

test('an explicit override applies without the default userData ever being looked up', async (): Promise<void> => {
  const runtime: { applyDesktopUserData: typeof applyDesktopUserData } = await import('./product-identity')
  const sandbox: string = fs.mkdtempSync(path.join(os.tmpdir(), 'identity-userdata-sandbox-'))
  const override: string = path.join(sandbox, 'electron-user-data')

  try {
    for (const { label, env, nonstable } of IDENTITIES) {
      const identity: ProductIdentity = await identityFor(env, nonstable)
      const { app, appData, names, pins, cleanup } = harness()

      try {
        assert.equal(
          runtime.applyDesktopUserData(app, identity, { HERMES_DESKTOP_USER_DATA_DIR: override }),
          nonstable ? identity.displayName : null,
          label
        )
        assert.deepEqual(names, nonstable ? [identity.displayName] : [], label)
        assert.deepEqual(pins, [path.resolve(override)], `${label}: userData is the sandbox`)
        assert.ok(fs.statSync(override).isDirectory(), `${label}: the sandbox exists, so Electron accepts the path`)
        assert.deepEqual(fs.readdirSync(appData), [], `${label}: nothing may be created in the real appData`)
      } finally {
        cleanup()
      }
    }
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true })
  }
})

test('an explicit override wins over a data-dir suffix', async (): Promise<void> => {
  const identity: ProductIdentity = await identityFor({ HERMES_BUILD_COMMIT: COMMIT }, true)
  const runtime: { applyDesktopUserData: typeof applyDesktopUserData } = await import('./product-identity')
  const { app, appData, pins, cleanup } = harness()
  const sandbox: string = fs.mkdtempSync(path.join(os.tmpdir(), 'identity-userdata-sandbox-'))

  try {
    runtime.applyDesktopUserData(app, identity, {
      HERMES_DESKTOP_USER_DATA_DIR: path.join(sandbox, 'electron-user-data'),
      HERMES_DATA_DIR_SUFFIX: '-rehearsal'
    })

    assert.deepEqual(pins, [path.join(sandbox, 'electron-user-data')])
    assert.deepEqual(fs.readdirSync(appData), [])
  } finally {
    cleanup()
    fs.rmSync(sandbox, { recursive: true, force: true })
  }
})

test('a data-dir suffix extends the identity own directory, not Electron default one', async (): Promise<void> => {
  const identity: ProductIdentity = await identityFor({ HERMES_BUILD_COMMIT: COMMIT }, true)
  const runtime: { applyDesktopUserData: typeof applyDesktopUserData } = await import('./product-identity')
  const { app, appData, pins, cleanup } = harness()

  try {
    runtime.applyDesktopUserData(app, identity, { HERMES_DATA_DIR_SUFFIX: '-rehearsal' })

    const own: string = path.join(appData, identity.appNamePascal)

    assert.deepEqual(pins, [own, `${own}-rehearsal`])
    assert.deepEqual(fs.readdirSync(appData).sort(), [identity.appNamePascal, `${identity.appNamePascal}-rehearsal`])
  } finally {
    cleanup()
  }
})

test('a data-dir suffix extends the stable identity default userData', async (): Promise<void> => {
  const identity: ProductIdentity = await identityFor({}, false)
  const runtime: { applyDesktopUserData: typeof applyDesktopUserData } = await import('./product-identity')
  const { app, defaultUserData, names, pins, cleanup } = harness()

  try {
    assert.equal(runtime.applyDesktopUserData(app, identity, { HERMES_DATA_DIR_SUFFIX: '-rehearsal' }), null)
    assert.deepEqual(pins, [`${defaultUserData}-rehearsal`])
    assert.ok(fs.statSync(`${defaultUserData}-rehearsal`).isDirectory())
    assert.deepEqual(names, [])
  } finally {
    cleanup()
  }
})

test('with no override and no suffix a stable identity leaves userData alone and a nonstable one owns its directory', async (): Promise<void> => {
  const runtime: { applyDesktopUserData: typeof applyDesktopUserData } = await import('./product-identity')

  for (const { label, env, nonstable } of IDENTITIES) {
    const identity: ProductIdentity = await identityFor(env, nonstable)
    const { app, appData, names, pins, cleanup } = harness()

    try {
      assert.equal(runtime.applyDesktopUserData(app, identity, {}), nonstable ? identity.displayName : null, label)
      assert.deepEqual(pins, nonstable ? [path.join(appData, identity.appNamePascal)] : [], label)
      assert.deepEqual(names, nonstable ? [identity.displayName] : [], label)
      assert.deepEqual(fs.readdirSync(appData), nonstable ? [identity.appNamePascal] : [], label)
    } finally {
      cleanup()
    }
  }
})

test('importing the boot module applies the override before any other module can ask for userData', async (): Promise<void> => {
  const sandbox: string = fs.mkdtempSync(path.join(os.tmpdir(), 'identity-userdata-sandbox-'))
  const override: string = path.join(sandbox, 'electron-user-data')

  try {
    for (const { label, env, nonstable } of IDENTITIES) {
      const identity: ProductIdentity = await identityFor(env, nonstable)
      const { app, appData, names, pins, cleanup } = harness()

      electron.app = app
      process.env.HERMES_DESKTOP_USER_DATA_DIR = override

      try {
        const boot: { IDENTITY_APP_NAME: string | null } = await import('./desktop-user-data-boot')

        assert.equal(boot.IDENTITY_APP_NAME, nonstable ? identity.displayName : null, label)
        assert.deepEqual(names, nonstable ? [identity.displayName] : [], label)
        assert.deepEqual(pins, [path.resolve(override)], label)
        assert.deepEqual(fs.readdirSync(appData), [], `${label}: nothing may be created in the real appData`)
        // What link-metadata and main.ts read when they are imported next is the sandbox.
        assert.equal(app.getPath('userData'), path.resolve(override), label)
      } finally {
        delete process.env.HERMES_DESKTOP_USER_DATA_DIR
        cleanup()
      }
    }
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true })
  }
})
