export type InitStep = { phase: "server_waiting" } | { phase: "sqlite_waiting" } | { phase: "done" }

export type ServerReadyData = {
  url: string
  username: string | null
  password: string | null
}

export type SqliteMigrationProgress = { type: "InProgress"; value: number } | { type: "Done" }

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
  }
  transcript: LocalServerTranscriptLine[]
}
export type LocalServerEvent = {
  type: "state"
  state: LocalServerState
}
export type LocalServerAPI = {
  getState: () => Promise<LocalServerState>
  setConfig: (config: LocalServerConfig) => Promise<void>
  runStep: (step: LocalServerStep) => Promise<void>
  cancelJob: () => Promise<void>
  installWsl: () => Promise<void>
  installDistro: (name: string) => Promise<void>
  openTerminal: () => Promise<void>
  subscribe: (cb: (event: LocalServerEvent) => void) => () => void
}

export type LinuxDisplayBackend = "wayland" | "auto"
export type TitlebarTheme = {
  mode: "light" | "dark"
}

export type ElectronAPI = {
  killSidecar: () => Promise<void>
  installCli: () => Promise<string>
  awaitInitialization: (onStep: (step: InitStep) => void) => Promise<ServerReadyData>
  localServer: LocalServerAPI
  getDefaultServerUrl: () => Promise<string | null>
  setDefaultServerUrl: (url: string | null) => Promise<void>
  getDisplayBackend: () => Promise<LinuxDisplayBackend | null>
  setDisplayBackend: (backend: LinuxDisplayBackend | null) => Promise<void>
  parseMarkdownCommand: (markdown: string) => Promise<string>
  checkAppExists: (appName: string) => Promise<boolean>
  wslPath: (path: string, mode: "windows" | "linux" | null, distro?: string | null) => Promise<string>
  resolveAppPath: (appName: string) => Promise<string | null>
  storeGet: (name: string, key: string) => Promise<string | null>
  storeSet: (name: string, key: string, value: string) => Promise<void>
  storeDelete: (name: string, key: string) => Promise<void>
  storeClear: (name: string) => Promise<void>
  storeKeys: (name: string) => Promise<string[]>
  storeLength: (name: string) => Promise<number>

  getWindowCount: () => Promise<number>
  onSqliteMigrationProgress: (cb: (progress: SqliteMigrationProgress) => void) => () => void
  onMenuCommand: (cb: (id: string) => void) => () => void
  onDeepLink: (cb: (urls: string[]) => void) => () => void

  openDirectoryPicker: (opts?: {
    multiple?: boolean
    title?: string
    defaultPath?: string
  }) => Promise<string | string[] | null>
  openFilePicker: (opts?: {
    multiple?: boolean
    title?: string
    defaultPath?: string
    accept?: string[]
    extensions?: string[]
  }) => Promise<string | string[] | null>
  saveFilePicker: (opts?: { title?: string; defaultPath?: string }) => Promise<string | null>
  openLink: (url: string) => void
  openPath: (path: string, app?: string) => Promise<void>
  readClipboardImage: () => Promise<{ buffer: ArrayBuffer; width: number; height: number } | null>
  showNotification: (title: string, body?: string) => void
  getWindowFocused: () => Promise<boolean>
  setWindowFocus: () => Promise<void>
  showWindow: () => Promise<void>
  relaunch: () => void
  getZoomFactor: () => Promise<number>
  setZoomFactor: (factor: number) => Promise<void>
  setTitlebar: (theme: TitlebarTheme) => Promise<void>
  loadingWindowComplete: () => void
  runUpdater: (alertOnFail: boolean) => Promise<void>
  checkUpdate: () => Promise<{ updateAvailable: boolean; version?: string }>
  installUpdate: () => Promise<void>
  setBackgroundColor: (color: string) => Promise<void>
}
