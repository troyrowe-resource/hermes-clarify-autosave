// product-identity.ts — the typed build-time product identity.
//
// product-identity.cjs is the single derivation of every name-shaped
// value a variant owns (product name, appId, channel). Dev bundles and
// test runs import the .cjs itself so the derivation exists in exactly
// one place.

import { mkdirSync } from 'node:fs'
// without this rename it breaks due to some bundler injection of the same name
import { createRequire as nodeCreateRequire } from 'node:module'
import path from 'node:path'

import type devIdentity from '../product-identity.cjs'

import { resolveDesktopUserData } from './data-paths'

/** Mirrors product-identity.cjs (see product-identity.d.cts). */
export type ProductIdentity = typeof devIdentity

declare const __HERMES_PRODUCT_IDENTITY__: ProductIdentity

/** The baked identity of this artifact (dev bundles derive it live). */
export const PRODUCT_IDENTITY: Readonly<ProductIdentity> =
  typeof __HERMES_PRODUCT_IDENTITY__ === 'undefined'
    ? Object.freeze(nodeCreateRequire(import.meta.url)('../product-identity.cjs') as ProductIdentity)
    : Object.freeze(__HERMES_PRODUCT_IDENTITY__)

/** Pin before the first userData lookup and single-instance lock. Electron's
 * later display-name changes must not redirect an installed build's state.
 * Stable keeps its historical userData and runtime naming behavior.
 *
 * An explicit HERMES_DESKTOP_USER_DATA_DIR replaces the pinned directory
 * outright (applyDesktopUserData applies it right after this), so it is neither
 * pinned nor created: an isolated launch must not leave <appData>/<identity name>
 * behind in the real profile.
 */
export function applyDesktopIdentity(
  app: {
    getPath(name: 'appData'): string
    setPath(name: 'userData', value: string): void
    setName(name: string): void
  },
  identity: Readonly<ProductIdentity> = PRODUCT_IDENTITY,
  env: NodeJS.ProcessEnv = process.env
): string | null {
  if (!identity.token && identity.appNamePascal === identity.artifactNamePascal) {
    return null
  }

  if (!env.HERMES_DESKTOP_USER_DATA_DIR) {
    const userData: string = path.join(app.getPath('appData'), identity.appNamePascal)
    mkdirSync(userData, { recursive: true })
    app.setPath('userData', userData)
  }

  app.setName(identity.displayName)

  return identity.displayName
}

/**
 * The desktop's userData, decided once at startup: the identity's own directory, replaced by an explicit
 * HERMES_DESKTOP_USER_DATA_DIR or extended by HERMES_DATA_DIR_SUFFIX. Returns the identity's display name.
 *
 * `app.getPath('userData')` CREATES Electron's default directory (%APPDATA%\Hermes on Windows: the installed
 * app's own data) as a side effect, so an explicit override is applied without ever asking for the default,
 * and before any other module is evaluated (desktop-user-data-boot is main.ts's first import): several
 * modules resolve userData paths when they are imported. `app.setPath('userData')` first never creates it.
 */
export function applyDesktopUserData(
  app: {
    getPath(name: 'appData' | 'userData'): string
    setPath(name: 'userData', value: string): void
    setName(name: string): void
  },
  identity: Readonly<ProductIdentity> = PRODUCT_IDENTITY,
  env: NodeJS.ProcessEnv = process.env
): string | null {
  const name: string | null = applyDesktopIdentity(app, identity, env)

  if (env.HERMES_DESKTOP_USER_DATA_DIR || env.HERMES_DATA_DIR_SUFFIX) {
    // Only the suffix form builds on the default; an explicit directory never needs it.
    const userData: string = resolveDesktopUserData(
      env.HERMES_DESKTOP_USER_DATA_DIR ? '' : app.getPath('userData'),
      env
    )

    mkdirSync(userData, { recursive: true })
    app.setPath('userData', userData)
  }

  return name
}
