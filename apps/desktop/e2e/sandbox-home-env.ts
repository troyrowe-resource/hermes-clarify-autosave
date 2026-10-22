import * as path from 'node:path'

/**
 * The variables that put a process's home and its host-wide gateway lock inside the sandbox.
 *
 * The backend's host rendezvous lock (one serve and one gateway per OS user, `gateway/status.py::_get_lock_dir`) is
 * `HERMES_GATEWAY_LOCK_DIR`, else an absolute `XDG_STATE_HOME`, else `~/.local/state`. Without the override an
 * "isolated" run on a laptop could attach to the user's running backend through an exported `XDG_STATE_HOME`
 * (POSIX) or through `%USERPROFILE%` (Windows), and CI would write a directory nothing watches; so the lock
 * directory is pinned on every platform.
 *
 * POSIX reads `HOME`, which every caller sets. Windows (Python's `Path.home()` / `expanduser`, Node's
 * `os.homedir()`) reads `USERPROFILE`, then `HOMEDRIVE` + `HOMEPATH`, and never `HOME`, so those are set there.
 */
export function sandboxHomeEnv(root: string, platform: NodeJS.Platform = process.platform): Record<string, string> {
  if (platform !== 'win32') {
    return { HERMES_GATEWAY_LOCK_DIR: path.posix.join(root, 'gateway-locks') }
  }

  const drive = /^[A-Za-z]:/.exec(root)?.[0]

  return {
    HERMES_GATEWAY_LOCK_DIR: path.win32.join(root, 'gateway-locks'),
    ...(drive ? { HOMEDRIVE: drive, HOMEPATH: root.slice(drive.length) } : {}),
    USERPROFILE: root,
  }
}
