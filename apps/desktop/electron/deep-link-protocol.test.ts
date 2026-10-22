import assert from 'node:assert/strict'

import { test } from 'vitest'

import { registerDeepLinkProtocol } from './deep-link-protocol'
import type { InstallStamp } from './install-stamp'

type Source = InstallStamp['source']

function run(env: NodeJS.ProcessEnv, defaultApp = true, source?: Source): { calls: unknown[][]; log: string[] } {
  const calls: unknown[][] = []
  const log: string[] = []

  registerDeepLinkProtocol({
    app: {
      setAsDefaultProtocolClient: (...args: unknown[]): boolean => {
        calls.push(args)

        return true
      }
    },
    protocol: 'hermes',
    env,
    defaultApp,
    argv: ['/electron', '.'],
    execPath: '/electron',
    resolve: entry => `/checkout/${entry}`,
    log: line => log.push(line),
    source
  })

  return { calls, log }
}

// Every provenance except a commit build. A new stamp source must be placed here (it registers) or in the commit-build
// rule (it never does): the type forces that decision.
const REGISTERING: Record<Exclude<Source, 'commit-build'>, true> = {
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

test('the E2E/dev guard leaves the OS hermes:// handler untouched; normal launches still register', () => {
  const skipped = run({ HERMES_DESKTOP_SKIP_PROTOCOL_REGISTRATION: '1' })
  assert.deepEqual(skipped.calls, [])
  assert.match(skipped.log.join('\n'), /registration skipped/)

  assert.deepEqual(run({}).calls, [['hermes', '/electron', ['/checkout/.']]])
  assert.deepEqual(run({}, false).calls, [['hermes']])
})

test('a commit build never repoints the OS hermes:// handler, however it was launched, and says why', () => {
  for (const defaultApp of [true, false]) {
    const { calls, log } = run({}, defaultApp, 'commit-build')

    assert.deepEqual(calls, [], `defaultApp=${defaultApp}`)
    assert.deepEqual(log, ['[deeplink] hermes:// registration skipped (commit build)'], `defaultApp=${defaultApp}`)
  }
})

test('every other provenance, and a dev bundle with no stamp, registers exactly as before', () => {
  const sources: Source[] = [...(Object.keys(REGISTERING) as Source[]), null, undefined]

  for (const source of sources) {
    const packaged = run({}, false, source)

    assert.deepEqual(packaged.calls, [['hermes']], `source=${source}`)
    assert.deepEqual(packaged.log, ['[deeplink] registered hermes:// handler'], `source=${source}`)
    assert.deepEqual(run({}, true, source).calls, [['hermes', '/electron', ['/checkout/.']]], `source=${source}`)
  }
})

test('the environment guard is honoured whatever the provenance', () => {
  for (const source of ['commit-build', 'build', 'channel-build', null, undefined] as Source[]) {
    const { calls, log } = run({ HERMES_DESKTOP_SKIP_PROTOCOL_REGISTRATION: '1' }, false, source)

    assert.deepEqual(calls, [], `source=${source}`)
    assert.match(log.join('\n'), /registration skipped/, `source=${source}`)
  }
})
