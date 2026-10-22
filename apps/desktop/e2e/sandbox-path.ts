import * as fs from 'node:fs'
import * as path from 'node:path'

/**
 * `target` as the OS itself spells it: symlinks resolved and, on Windows, 8.3 short names (`C:\Users\RUNNER~1`,
 * which is how a CI runner spells its TEMP) expanded to the long form a backend records for its own HERMES_HOME.
 * Falls back to the absolute path when `target` does not exist (a stale record naming a deleted directory).
 */
export function canonicalPath(target: string): string {
  try {
    return fs.realpathSync.native(target)
  } catch {
    return path.resolve(target)
  }
}

/** Whether two spellings name the same directory (case-insensitively on Windows, as its file system is). */
export function samePath(a: string, b: string, platform: NodeJS.Platform = process.platform): boolean {
  const [left, right] = [canonicalPath(a), canonicalPath(b)]

  return platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right
}
