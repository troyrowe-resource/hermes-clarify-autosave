// Applies the desktop's userData before any other module runs: main.ts imports this FIRST. Modules that resolve a
// userData path when they are imported (link-metadata's favicon cache) must see the final directory, and nothing may
// ask Electron for the default one first (that call creates it). See applyDesktopUserData.

import { app } from 'electron'

import { applyDesktopUserData } from './product-identity'

/** The identity's display name for a nonstable build (commit, canary, light, bundled), else null. */
export const IDENTITY_APP_NAME: string | null = applyDesktopUserData(app)
