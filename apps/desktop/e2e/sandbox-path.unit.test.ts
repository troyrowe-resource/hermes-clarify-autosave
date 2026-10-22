import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import { canonicalPath, samePath } from './sandbox-path'

const made: string[] = []

const scratch = (): string => {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'sandbox-path-')))
  made.push(dir)

  return dir
}

afterEach(() => {
  for (const dir of made.splice(0)) {
    fs.rmSync(dir, { force: true, recursive: true })
  }
})

describe('samePath', () => {
  test('two spellings of one directory are the same, and two directories are not', () => {
    const real = path.join(scratch(), 'real')
    const other = path.join(path.dirname(real), 'other')
    fs.mkdirSync(real)
    fs.mkdirSync(other)

    // A link is another spelling of its target (a junction needs no privilege on Windows).
    const link = path.join(path.dirname(real), 'link')
    fs.symlinkSync(real, link, process.platform === 'win32' ? 'junction' : 'dir')

    expect(canonicalPath(link)).toBe(real)
    expect(samePath(link, real)).toBe(true)
    expect(samePath(`${real}${path.sep}.`, real)).toBe(true)
    expect(samePath(real, other)).toBe(false)
  })

  test('a path that no longer exists is compared by its absolute spelling', () => {
    const gone = path.join(scratch(), 'deleted-sandbox')

    expect(canonicalPath(gone)).toBe(path.resolve(gone))
    expect(samePath(gone, path.join(gone, '..', 'deleted-sandbox'))).toBe(true)
  })

  test('on Windows, where the file system ignores case, case alone does not make two spellings differ', () => {
    const missing = path.join(scratch(), 'Hermes-Home')

    expect(samePath(missing, missing.toUpperCase(), 'win32')).toBe(true)
    expect(samePath(missing, missing.toUpperCase(), 'linux')).toBe(false)
  })
})
