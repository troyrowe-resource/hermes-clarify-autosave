/**
 * `hermes://` deep-link registration. Every launch rewrites the OS handler (on Windows,
 * HKCU\Software\Classes\<protocol>), so a test or dev run of an unpackaged checkout would
 * repoint the user's installed handler at that checkout. `HERMES_DESKTOP_SKIP_PROTOCOL_REGISTRATION=1`
 * (set by the E2E harnesses) leaves the OS registration untouched. So does a commit build (install
 * stamp source 'commit-build'): it is a one-off build handed to a tester beside their real install,
 * so launching it directly must not repoint that install's handler at it. Deep links that arrive
 * through argv / second-instance / open-url still route normally in both cases.
 */

import type { InstallStamp } from './install-stamp'

export interface ProtocolRegistrar {
  setAsDefaultProtocolClient: (protocol: string, path?: string, args?: string[]) => boolean
}

export interface DeepLinkProtocolOptions {
  app: ProtocolRegistrar
  protocol: string
  env: NodeJS.ProcessEnv
  /** `process.defaultApp`: running as `electron <dir>` rather than a packaged binary. */
  defaultApp: boolean
  argv: string[]
  execPath: string
  resolve: (entry: string) => string
  log: (line: string) => void
  /** The install stamp's provenance (`INSTALL_STAMP?.source`); null on a dev bundle, which has no stamp. */
  source?: InstallStamp['source']
}

export function registerDeepLinkProtocol(options: DeepLinkProtocolOptions): void {
  const { app, protocol, env, defaultApp, argv, execPath, resolve, log, source } = options

  if (env.HERMES_DESKTOP_SKIP_PROTOCOL_REGISTRATION === '1') {
    log(`[deeplink] ${protocol}:// registration skipped (HERMES_DESKTOP_SKIP_PROTOCOL_REGISTRATION)`)

    return
  }

  if (source === 'commit-build') {
    log(`[deeplink] ${protocol}:// registration skipped (commit build)`)

    return
  }

  try {
    if (defaultApp && argv.length >= 2) {
      // Dev: register with the electron exec path + entry script so the OS can
      // relaunch us with the URL. argv[1] is usually "." when launched via
      // `electron .` from apps/desktop — resolve against cwd.
      app.setAsDefaultProtocolClient(protocol, execPath, [resolve(argv[1])])
    } else {
      app.setAsDefaultProtocolClient(protocol)
    }

    log(`[deeplink] registered ${protocol}:// handler`)
  } catch (err) {
    log(`[deeplink] protocol registration failed: ${(err as Error).message}`)
  }
}
