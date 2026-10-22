/**
 * Helpers for the packaged-candidate acceptance spec (`clarify-drafts-packaged.spec.ts`): the launch contract the
 * SHIPPED launcher prints, the checks that make a launch provably isolated, path and process comparisons, and the
 * shipped Start/Stop entry points.
 *
 * Everything pure takes its platform explicitly, so it is provable on any host
 * (`clarify-packaged-fixture.unit.test.ts`). Only `runShipped`, `sha256File` and `copyBackendLogs` touch the machine.
 * Nothing here imports the dev fixtures: the packaged spec must never reach a dev Electron or a dev backend.
 */

import { spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { z } from 'zod'

import type { NativeProcess } from '../../../tests-js/scripts/desktop-smoke-process'

// ─── Paths ─────────────────────────────────────────────────────────────

type Platform = NodeJS.Platform

const pathApi = (platform: Platform): path.PlatformPath => (platform === 'win32' ? path.win32 : path.posix)

/** Absolute, separator-normalised, no trailing separator; case-folded on Windows (its paths compare that way). */
export function normalizePath(value: string, platform: Platform = process.platform): string {
  const api = pathApi(platform)
  const resolved = api.resolve(value)
  const root = api.parse(resolved).root
  const trimmed = resolved.length > root.length ? resolved.replace(/[\\/]+$/, '') : resolved

  return platform === 'win32' ? trimmed.toLowerCase() : trimmed
}

export function samePath(a: string, b: string, platform: Platform = process.platform): boolean {
  return normalizePath(a, platform) === normalizePath(b, platform)
}

/** `child` is `parent` itself or lies below it. */
export function isInside(parent: string, child: string, platform: Platform = process.platform): boolean {
  const base = normalizePath(parent, platform)
  const target = normalizePath(child, platform)
  const separator = pathApi(platform).sep

  return target === base || target.startsWith(base.endsWith(separator) ? base : base + separator)
}

// ─── The launch contract ───────────────────────────────────────────────

const layoutSchema = z.object({
  hermesHome: z.string(),
  local: z.string(),
  profile: z.string(),
  roaming: z.string(),
  root: z.string(),
  temp: z.string(),
  userData: z.string()
})

const contractSchema = z.object({
  arguments: z.array(z.string()),
  commit: z.string().regex(/^[0-9a-f]{40}$/),
  environment: z.record(z.string(), z.string()),
  exe: z.string(),
  layout: layoutSchema,
  packageRoot: z.string(),
  refusedLocations: z.array(z.string()),
  schema: z.literal(1),
  workingDirectory: z.string()
})

export type LaunchContract = z.infer<typeof contractSchema>
export type SandboxLayout = z.infer<typeof layoutSchema>

/** The data-directory suffix the build bakes in and the launcher sets (`scripts/clarify_ci/candidate.py`). */
export const DATA_DIR_SUFFIX = '-clarify-candidate'

/** The one JSON line `Start-HermesClarifyCandidate -EmitEnvironment` prints. */
export function parseLaunchContract(output: string): LaunchContract {
  const line = output
    .split(/\r?\n/)
    .map(entry => entry.trim())
    .filter(Boolean)
    .at(-1)

  if (!line) {
    throw new Error('the shipped launcher printed no launch contract')
  }

  let value: unknown

  try {
    value = JSON.parse(line)
  } catch (error) {
    throw new Error(`the launch contract is not JSON (${(error as Error).message}): ${line.slice(0, 300)}`)
  }

  const parsed = contractSchema.safeParse(value)

  if (!parsed.success) {
    throw new Error(`the launch contract has the wrong shape: ${parsed.error.message.slice(0, 600)}`)
  }

  return parsed.data
}

export interface ContractExpectation {
  commit: string
  /** Names the harness exported on purpose (decoys), to prove the launcher keeps them out of the candidate. */
  decoys?: string[]
  /** The packaged executable this run means to start. */
  exe: string
  packageRoot: string
  platform?: Platform
}

/** Only these Hermes variables may reach the candidate: the sandbox and isolation switches, nothing inherited. */
const ALLOWED_HERMES_VARIABLES = new Set([
  'HERMES_DATA_DIR_SUFFIX',
  'HERMES_DESKTOP_APP_NAME',
  'HERMES_DESKTOP_IGNORE_EXISTING',
  'HERMES_DESKTOP_ISOLATED_BACKEND',
  'HERMES_DESKTOP_SKIP_PROTOCOL_REGISTRATION',
  'HERMES_DESKTOP_USER_DATA_DIR',
  'HERMES_HOME'
])

const ISOLATION_FLAGS = [
  'HERMES_DESKTOP_IGNORE_EXISTING',
  'HERMES_DESKTOP_ISOLATED_BACKEND',
  'HERMES_DESKTOP_SKIP_PROTOCOL_REGISTRATION'
]

const LEAKY_VARIABLE = /^(?:PYTHON|VIRTUAL_ENV|CONDA|NODE_|NPM_|ELECTRON_|VITE_|UV_|PM_|GITHUB_|RUNNER_|ACTIONS_)/i
const SECRETISH_VARIABLE = /(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i

/** What every rule may consult: the expectation, the platform's path semantics, and the harness's decoys. */
interface ContractCheck {
  decoys: Set<string>
  expected: ContractExpectation
  inside: (parent: string, child: string) => boolean
  platform: Platform
  same: (a: string, b: string) => boolean
}

/** One facet of "isolated start of this executable": the problems it finds, none when it holds. */
type ContractRule = (contract: LaunchContract, check: ContractCheck) => string[]

/** The messages of the `[holds, message]` pairs that do not hold. */
const failures = (checks: [boolean, string][]): string[] =>
  checks.filter(([holds]) => !holds).map(([, message]) => message)

const LAYOUT_KEYS = ['userData', 'hermesHome', 'profile', 'roaming', 'local', 'temp'] as const

const unset = (value: string | undefined): string => value ?? '(unset)'

/** It is this commit's launcher for this executable. */
const identityRule: ContractRule = (contract, { expected, inside, same }) =>
  failures([
    [contract.commit === expected.commit, `the launcher names commit ${contract.commit}, expected ${expected.commit}`],
    [same(contract.exe, expected.exe), `the launcher would start ${contract.exe}, not the packaged ${expected.exe}`],
    [
      same(contract.packageRoot, expected.packageRoot) && inside(expected.packageRoot, contract.exe),
      `the launcher's package root ${contract.packageRoot} is not ${expected.packageRoot}`
    ]
  ])

/** Every state location is one directory inside the one sandbox, and the Hermes home is where the app derives it. */
const layoutRule: ContractRule = (contract, { inside, platform, same }) => {
  const { layout } = contract

  return failures([
    ...LAYOUT_KEYS.map((key): [boolean, string] => [
      inside(layout.root, layout[key]),
      `layout.${key} (${layout[key]}) is outside the sandbox ${layout.root}`
    ]),
    [
      same(layout.hermesHome, pathApi(platform).join(layout.userData, 'hermes-home')),
      `the Hermes home ${layout.hermesHome} is not <user data>\\hermes-home, which the app derives from it`
    ],
    [
      inside(layout.root, contract.workingDirectory),
      `the working directory ${contract.workingDirectory} is outside the sandbox`
    ]
  ])
}

/** The variables Hermes, Electron and Windows resolve their folders from all name the sandbox. */
const bindingRule: ContractRule = ({ environment: env, layout }, { same }) => {
  const bindings: [string, string][] = [
    ['HERMES_HOME', layout.hermesHome],
    ['HERMES_DESKTOP_USER_DATA_DIR', layout.userData],
    ['USERPROFILE', layout.profile],
    ['HOME', layout.profile],
    ['APPDATA', layout.roaming],
    ['LOCALAPPDATA', layout.local],
    ['TEMP', layout.temp],
    ['TMP', layout.temp]
  ]

  return failures(
    bindings.map(([name, wanted]): [boolean, string] => [
      Boolean(env[name]) && same(env[name], wanted),
      `${name}=${unset(env[name])}, expected the sandbox path ${wanted}`
    ])
  )
}

/** The isolation switches are on and Electron is told its user data directory (so it never creates its default). */
const switchRule: ContractRule = ({ arguments: args, environment: env, layout }) => {
  const expectedSwitch = `--user-data-dir=${layout.userData}`

  return failures([
    ...ISOLATION_FLAGS.map((name): [boolean, string] => [env[name] === '1', `${name}=${unset(env[name])}, expected 1`]),
    [
      env.HERMES_DATA_DIR_SUFFIX === DATA_DIR_SUFFIX,
      `HERMES_DATA_DIR_SUFFIX=${unset(env.HERMES_DATA_DIR_SUFFIX)}, expected ${DATA_DIR_SUFFIX}`
    ],
    [args[0] === expectedSwitch, `the first argument is ${args[0] ?? '(none)'}, expected ${expectedSwitch}`]
  ])
}

/** Why a variable name must not be in the candidate's environment, or null. Decoys are named as such. */
function leakProblem(name: string, decoys: Set<string>): null | string {
  const upper = name.toUpperCase()

  const reasons: [boolean, string][] = [
    [decoys.has(upper), `${name} was exported by the harness as a decoy and reached the candidate`],
    [
      upper.startsWith('HERMES_') && !ALLOWED_HERMES_VARIABLES.has(upper),
      `${name} is a Hermes variable the launcher must not pass on`
    ],
    [
      LEAKY_VARIABLE.test(name) || SECRETISH_VARIABLE.test(name),
      `${name} is a runtime override or credential-shaped variable the launcher must not pass on`
    ]
  ]

  return reasons.find(([leaks]) => leaks)?.[1] ?? null
}

/** Nothing the machine or the harness exported (credentials, runtime overrides, decoys) reached the candidate. */
const leakRule: ContractRule = ({ environment: env }, { decoys }) =>
  Object.keys(env)
    .map(name => leakProblem(name, decoys))
    .filter((problem): problem is string => problem !== null)

/** What Windows programs and Python sockets need was kept. */
const windowsBasicsRule: ContractRule = ({ environment: env }) => {
  const names = new Set(Object.keys(env).map(name => name.toUpperCase()))

  return failures(
    ['SYSTEMROOT', 'PATH'].map((needed): [boolean, string] => [
      names.has(needed),
      `${needed} is missing: Windows programs and Python sockets need it`
    ])
  )
}

/** The sandbox is nowhere near a real Hermes location, and no real location is handed to the candidate. */
const realLocationRule: ContractRule = ({ environment: env, layout, refusedLocations }, { inside, same }) =>
  refusedLocations.flatMap(real =>
    failures([
      [
        !inside(real, layout.root) && !inside(layout.root, real),
        `the sandbox ${layout.root} overlaps the real location ${real}`
      ],
      [
        !Object.values(env).some(value => same(value, real)),
        `the real location ${real} is in the candidate's environment`
      ]
    ])
  )

const CONTRACT_RULES: ContractRule[] = [
  identityRule,
  layoutRule,
  bindingRule,
  switchRule,
  leakRule,
  windowsBasicsRule,
  realLocationRule
]

/**
 * Every reason the launch contract is not a fully isolated start of THIS packaged executable. Empty means: each
 * state location the app and its backend use is inside one sandbox, the sandbox is nowhere near a real Hermes
 * location, the switches that stop Electron creating its default user data are present, and nothing the machine
 * or the harness exported (credentials, Python/Node/Hermes overrides, decoy homes) reached the candidate.
 */
export function contractProblems(contract: LaunchContract, expected: ContractExpectation): string[] {
  const platform = expected.platform ?? process.platform

  const check: ContractCheck = {
    decoys: new Set((expected.decoys ?? []).map(name => name.toUpperCase())),
    expected,
    inside: (parent, child) => isInside(parent, child, platform),
    platform,
    same: (a, b) => samePath(a, b, platform)
  }

  return CONTRACT_RULES.flatMap(rule => rule(contract, check))
}

// ─── The shipped entry points ──────────────────────────────────────────

export interface ShippedRun {
  code: null | number
  error?: Error
  stderr: string
  stdout: string
}

/**
 * Run the .cmd a person double-clicks (`Start-` or `Stop-HermesClarifyCandidate.cmd`) from the extracted package.
 * stdin is closed, so a failing .cmd's `pause` returns at once instead of waiting for a key.
 */
export function runShipped(
  packageRoot: string,
  script: 'Start' | 'Stop',
  args: string[] = [],
  timeoutMs = 180_000
): ShippedRun {
  const entry = path.join(packageRoot, `${script}-HermesClarifyCandidate.cmd`)

  const result = spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/c', entry, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: timeoutMs,
    windowsHide: true
  })

  return { code: result.status, error: result.error, stderr: result.stderr ?? '', stdout: result.stdout ?? '' }
}

// ─── The package ───────────────────────────────────────────────────────

const manifestSchema = z.object({
  app: z.object({ exe: z.string(), exe_sha256: z.string().regex(/^[0-9a-f]{64}$/) }),
  package: z.string(),
  source: z.object({ commit: z.string().regex(/^[0-9a-f]{40}$/) })
})

export interface CandidatePackage {
  appDir: string
  exe: string
  exeSha256: string
  manifest: z.infer<typeof manifestSchema>
  payloadRoot: string
  resources: string
  root: string
}

export function readCandidatePackage(root: string): CandidatePackage {
  const resolved = path.resolve(root)
  const manifestPath = path.join(resolved, 'MANIFEST.json')

  if (!fs.existsSync(manifestPath)) {
    throw new Error(`${manifestPath} is missing: HERMES_E2E_CANDIDATE_DIR must be an extracted candidate package`)
  }

  const manifest = manifestSchema.parse(JSON.parse(fs.readFileSync(manifestPath, 'utf8').replace(/^\uFEFF/, '')))
  const exe = path.join(resolved, ...manifest.app.exe.split('/'))
  const appDir = path.dirname(exe)
  const resources = path.join(appDir, 'resources')

  return {
    appDir,
    exe,
    exeSha256: manifest.app.exe_sha256,
    manifest,
    payloadRoot: path.join(resources, 'agent-payload'),
    resources,
    root: resolved
  }
}

export function sha256File(file: string): string {
  const hash = crypto.createHash('sha256')
  const descriptor = fs.openSync(file, 'r')
  const buffer = Buffer.allocUnsafe(1 << 20)

  try {
    let read = fs.readSync(descriptor, buffer, 0, buffer.length, null)

    while (read > 0) {
      hash.update(buffer.subarray(0, read))
      read = fs.readSync(descriptor, buffer, 0, buffer.length, null)
    }
  } finally {
    fs.closeSync(descriptor)
  }

  return hash.digest('hex')
}

// ─── Processes ─────────────────────────────────────────────────────────

/** Every process whose executable image lies inside `root` (the app, its helpers and the gateway daemon). */
export function processesInside(
  processes: NativeProcess[],
  root: string,
  platform: Platform = process.platform
): NativeProcess[] {
  return processes.filter(entry => entry.executable !== '' && isInside(root, entry.executable, platform))
}

/**
 * Hermes processes that do NOT run from `root`: a gateway or Python started from some other install (the runner's
 * checkout, a PM interpreter) would be an official or dev backend answering in the package's place.
 */
export function foreignHermesProcesses(
  processes: NativeProcess[],
  root: string,
  platform: Platform = process.platform
): NativeProcess[] {
  const pattern = /(?:hermes_cli|tui_gateway|gateway\s+run|hermes\.exe|\\hermes\\|hermes-agent)/i

  return processes.filter(
    entry =>
      entry.executable !== '' &&
      !isInside(root, entry.executable, platform) &&
      /python|hermes/i.test(path.win32.basename(entry.executable)) &&
      pattern.test(entry.command)
  )
}

/** `{ name: count }` of the image names in `processes`, for evidence that stays readable. */
export function countByImage(processes: NativeProcess[]): Record<string, number> {
  const counts: Record<string, number> = {}

  for (const entry of processes) {
    const name = path.win32.basename(entry.executable).toLowerCase() || '(unnamed)'
    counts[name] = (counts[name] ?? 0) + 1
  }

  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)))
}

// ─── Evidence hygiene ──────────────────────────────────────────────────

/** Strip what a log line may carry that is not evidence: connection tokens, tickets, credential-shaped values. */
export function redact(text: string): string {
  return text
    .replace(/([?&](?:token|ticket|key)=)[^&\s"']+/gi, '$1[redacted]')
    .replace(
      /((?:authorization|api[_ -]?key|token|secret|password)\s*[:=]\s*)(?:Bearer\s+)?[^\s,"']+/gi,
      '$1[redacted]'
    )
}

/**
 * Copy the candidate's own logs (`<hermesHome>/logs`: desktop, agent, gateway) into the evidence directory, redacted
 * and capped, so a failure on a runner that is gone tomorrow can still be diagnosed. Best effort; never throws.
 */
export function copyBackendLogs(hermesHome: string, destination: string, maxBytesPerFile = 2_000_000): string[] {
  const source = path.join(hermesHome, 'logs')
  const copied: string[] = []

  try {
    fs.mkdirSync(destination, { recursive: true })

    for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
      if (!entry.isFile() || !/\.(?:log|txt|json)$/i.test(entry.name)) {
        continue
      }

      const file = path.join(source, entry.name)
      const size = fs.statSync(file).size
      const text = fs.readFileSync(file, 'utf8')
      const kept = size > maxBytesPerFile ? text.slice(-maxBytesPerFile) : text

      fs.writeFileSync(path.join(destination, entry.name), redact(kept), 'utf8')
      copied.push(entry.name)
    }
  } catch {
    // Diagnostics only: the candidate may not have written any logs.
  }

  return copied
}
