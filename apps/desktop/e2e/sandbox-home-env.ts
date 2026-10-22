import * as path from 'node:path'

/**
 * The variables that make a process's home directory the sandbox. POSIX reads `HOME`, which every caller sets.
 * Windows (Python's `Path.home()` / `expanduser`, Node's `os.homedir()`) reads `USERPROFILE`, then
 * `HOMEDRIVE` + `HOMEPATH`, and never `HOME`. Without them the backend's host-wide rendezvous lock (one serve and
 * one gateway per OS user, `gateway/status.py::_get_lock_dir`, under `%USERPROFILE%\.local\state\hermes`) is the
 * REAL user's: an "isolated" run on a laptop could attach to the user's running backend, and CI would write a
 * directory nothing watches. `HERMES_GATEWAY_LOCK_DIR` pins that lock directory explicitly. Empty on other
 * platforms, which are already isolated by `HOME`.
 */
export function sandboxHomeEnv(root: string, platform: NodeJS.Platform = process.platform): Record<string, string> {
  if (platform !== 'win32') {
    return {}
  }

  const drive = /^[A-Za-z]:/.exec(root)?.[0]

  return {
    HERMES_GATEWAY_LOCK_DIR: path.win32.join(root, 'gateway-locks'),
    ...(drive ? { HOMEDRIVE: drive, HOMEPATH: root.slice(drive.length) } : {}),
    USERPROFILE: root,
  }
}
