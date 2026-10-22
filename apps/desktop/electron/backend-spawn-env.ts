import path from 'node:path'

import type { InstallStamp } from './install-stamp'

export function desktopBackendSpawnEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...base,
    // The desktop spawns `hermes serve` directly — no systemd/launchd supervisor will
    // revive a failure exit, so EX_TEMPFAIL only severs the UI's websockets and drops
    // in-flight assistant messages (#118080). Tell the gateway to stay alive on
    // all-adapters-down and let the reconnect watcher recover instead. Written LAST
    // so no earlier spread can override it. Older runtimes ignore the unknown
    // variable and keep the historical exit behavior.
    GATEWAY_ON_ALL_ADAPTERS_DOWN: 'stay_alive'
  }
}

/**
 * A commit build never joins the per-OS-user singletons. The gateway keeps its host lock, its host record and its
 * platform-token locks in ONE directory per OS user (gateway/status.py::_get_lock_dir: HERMES_GATEWAY_LOCK_DIR, else
 * XDG_STATE_HOME, else ~/.local/state/hermes/gateway-locks), shared by every Hermes home of that user. A commit build is
 * a one-off build handed to a tester beside their real install, so started directly it would publish its host record
 * beside the installed Hermes's, take or lose the same host lock, and read the same serve records and update state.
 * Unless the environment already chose a directory, its backend and gateway children get one inside the build's own
 * Hermes home. Every other build gets the very same backend object back: no new key, nothing changed.
 *
 * `hermesHome` is the home the children are launched with, not a profile's: a profile is selected by `--profile`, and
 * every profile of one app instance shares the one host role, so they must share the one directory.
 */
export function commitBuildGatewayScope<T extends { env?: NodeJS.ProcessEnv }>(
  backend: T,
  {
    source,
    hermesHome,
    env = process.env
  }: { source: InstallStamp['source'] | undefined; hermesHome: string; env?: NodeJS.ProcessEnv }
): T {
  // An empty value is no choice: the gateway treats it as unset.
  if (source !== 'commit-build' || !hermesHome || env.HERMES_GATEWAY_LOCK_DIR) {
    return backend
  }

  return { ...backend, env: { ...backend.env, HERMES_GATEWAY_LOCK_DIR: path.join(hermesHome, 'gateway-locks') } }
}

/**
 * `resolve`, with every backend it resolves scoped by {@link commitBuildGatewayScope}. main.ts resolves the one backend
 * every consumer spawns (the gateway ensure/restart clients, the open-in-terminal TUI, the ticket helper) through this,
 * so the scoping is applied once, where that backend is made.
 */
export function commitBuildScopedResolver<A extends unknown[], T extends { env?: NodeJS.ProcessEnv }>(
  resolve: (...args: A) => Promise<T>,
  scope: Parameters<typeof commitBuildGatewayScope>[1]
): (...args: A) => Promise<T> {
  return async (...args: A): Promise<T> => commitBuildGatewayScope(await resolve(...args), scope)
}
