import { createSimpleContext } from "@opencode-ai/ui/context"
import type { AsyncStorage, SyncStorage } from "@solid-primitives/storage"
import type { Accessor } from "solid-js"
import { ServerConnection } from "./server"

type PickerPaths = string | string[] | null
type OpenDirectoryPickerOptions = { title?: string; multiple?: boolean }
type OpenFilePickerOptions = { title?: string; multiple?: boolean; accept?: string[]; extensions?: string[] }
type SaveFilePickerOptions = { title?: string; defaultPath?: string }
type UpdateInfo = { updateAvailable: boolean; version?: string }

export type LocalServerMode = "windows" | "wsl"
export type LocalServerStep = "wsl" | "distro" | "opencode" | "switch"
export type LocalServerMismatchAcknowledgement = {
  path: string
  version: string
}
export type LocalServerWslCheck = {
  available: boolean
  version: string | null
  status: string | null
  error: string | null
}
export type LocalServerInstalledDistro = {
  name: string
  state: string | null
  version: number | null
  isDefault: boolean
}
export type LocalServerOnlineDistro = {
  name: string
  label: string
}
export type LocalServerDistroProbe = {
  name: string
  canExecute: boolean
  hasBash: boolean
  hasCurl: boolean
  username: string | null
  isRoot: boolean | null
  error: string | null
}
export type LocalServerDistroCheck = {
  installed: LocalServerInstalledDistro[]
  online: LocalServerOnlineDistro[]
  selected: LocalServerDistroProbe | null
  error: string | null
}
export type LocalServerOpencodeCheck = {
  distro: string | null
  resolvedPath: string | null
  version: string | null
  expectedVersion: string | null
  matchesDesktop: boolean | null
  error: string | null
}
export type LocalServerTranscriptLine = {
  stream: "stdout" | "stderr" | "system"
  text: string
  at: number
}
export type LocalServerConfig = {
  mode: LocalServerMode
  distro: string | null
  onboarding: {
    step: LocalServerStep | null
    complete: boolean
    pendingRestart: boolean
  }
  acknowledgements: {
    root: string[]
    mismatch: LocalServerMismatchAcknowledgement[]
  }
}
export type LocalServerStatus =
  | { kind: "idle" }
  | { kind: "ready" }
  | { kind: "running"; step: LocalServerStep | null }
  | { kind: "failed"; step: LocalServerStep | null; message: string }
export type LocalServerState = {
  config: LocalServerConfig
  runtime: {
    key: string
    mode: LocalServerMode
    distro: string | null
  }
  status: LocalServerStatus
  job: { step: LocalServerStep | null; startedAt: number } | null
  checks: {
    wsl: LocalServerWslCheck | null
    distro: LocalServerDistroCheck | null
    opencode: LocalServerOpencodeCheck | null
  }
  transcript: LocalServerTranscriptLine[]
}
export type LocalServerEvent = {
  type: "state"
  state: LocalServerState
}
export type LocalServerPlatform = {
  getState(): Promise<LocalServerState>
  setConfig(config: LocalServerConfig): Promise<void>
  runStep(step: LocalServerStep): Promise<void>
  cancelJob(): Promise<void>
  installWsl(): Promise<void>
  installDistro(name: string): Promise<void>
  installOpencode(): Promise<void>
  openTerminal(): Promise<void>
  subscribe(cb: (event: LocalServerEvent) => void): () => void
}

export type Platform = {
  /** Platform discriminator */
  platform: "web" | "desktop"

  /** Desktop OS (Tauri only) */
  os?: "macos" | "windows" | "linux"

  /** App version */
  version?: string

  /** Open a URL in the default browser */
  openLink(url: string): void

  /** Open a local path in a local app (desktop only) */
  openPath?(path: string, app?: string): Promise<void>

  /** Restart the app  */
  restart(): Promise<void>

  /** Navigate back in history */
  back(): void

  /** Navigate forward in history */
  forward(): void

  /** Send a system notification (optional deep link) */
  notify(title: string, description?: string, href?: string): Promise<void>

  /** Open directory picker dialog (native on Tauri, server-backed on web) */
  openDirectoryPickerDialog?(opts?: OpenDirectoryPickerOptions): Promise<PickerPaths>

  /** Open native file picker dialog (Tauri only) */
  openFilePickerDialog?(opts?: OpenFilePickerOptions): Promise<PickerPaths>

  /** Save file picker dialog (Tauri only) */
  saveFilePickerDialog?(opts?: SaveFilePickerOptions): Promise<string | null>

  /** Storage mechanism, defaults to localStorage */
  storage?: (name?: string) => SyncStorage | AsyncStorage

  /** Check for updates (Tauri only) */
  checkUpdate?(): Promise<UpdateInfo>

  /** Install updates (Tauri only) */
  update?(): Promise<void>

  /** Fetch override */
  fetch?: typeof fetch

  /** Get the configured default server URL (platform-specific) */
  getDefaultServer?(): Promise<ServerConnection.Key | null>

  /** Set the default server URL to use on app startup (platform-specific) */
  setDefaultServer?(url: ServerConnection.Key | null): Promise<void> | void

  /** Manage the desktop Local Server lifecycle (desktop only) */
  localServer?: LocalServerPlatform

  /** Get the configured WSL integration (desktop only) */
  getWslEnabled?(): Promise<boolean>

  /** Set the configured WSL integration (desktop only) */
  setWslEnabled?(config: boolean): Promise<void> | void

  /** Get the preferred display backend (desktop only) */
  getDisplayBackend?(): Promise<DisplayBackend | null> | DisplayBackend | null

  /** Set the preferred display backend (desktop only) */
  setDisplayBackend?(backend: DisplayBackend): Promise<void>

  /** Parse markdown to HTML using native parser (desktop only, returns unprocessed code blocks) */
  parseMarkdown?(markdown: string): Promise<string>

  /** Webview zoom level (desktop only) */
  webviewZoom?: Accessor<number>

  /** Check if an editor app exists (desktop only) */
  checkAppExists?(appName: string): Promise<boolean>

  /** Read image from clipboard (desktop only) */
  readClipboardImage?(): Promise<File | null>
}

export type DisplayBackend = "auto" | "wayland"

export const { use: usePlatform, provider: PlatformProvider } = createSimpleContext({
  name: "Platform",
  init: (props: { value: Platform }) => {
    return props.value
  },
})
