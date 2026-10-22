import { describe, expect, test } from 'vitest'

import { sandboxHomeEnv } from './sandbox-home-env'

describe('sandboxHomeEnv', () => {
  test('on Windows the sandbox is the home for Python and Node alike, and the host lock directory is pinned inside it', () => {
    const root = 'C:\\Users\\runneradmin\\AppData\\Local\\Temp\\hermes-e2e-mock-0.42'

    expect(sandboxHomeEnv(root, 'win32')).toEqual({
      HERMES_GATEWAY_LOCK_DIR: `${root}\\gateway-locks`,
      HOMEDRIVE: 'C:',
      HOMEPATH: '\\Users\\runneradmin\\AppData\\Local\\Temp\\hermes-e2e-mock-0.42',
      USERPROFILE: root
    })
  })

  test('a root with no drive letter still gets USERPROFILE and the lock directory, and no invented drive', () => {
    const root = '\\\\runner\\share\\hermes-e2e-mock-0.42'
    const env = sandboxHomeEnv(root, 'win32')

    expect(env).toEqual({ HERMES_GATEWAY_LOCK_DIR: `${root}\\gateway-locks`, USERPROFILE: root })
    expect(env).not.toHaveProperty('HOMEDRIVE')
    expect(env).not.toHaveProperty('HOMEPATH')
  })

  test.each(['linux', 'darwin'] as const)('%s is isolated by HOME alone and adds nothing', platform => {
    expect(sandboxHomeEnv('/tmp/hermes-e2e-mock-0.42', platform)).toEqual({})
  })
})
