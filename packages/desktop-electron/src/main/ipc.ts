import { execFile } from "node:child_process"
import { BrowserWindow, Notification, app, clipboard, dialog, ipcMain, shell } from "electron"
import type { IpcMainEvent, IpcMainInvokeEvent } from "electron"

import type {
  InitStep,
  ServerReadyData,
  SqliteMigrationProgress,
  TitlebarTheme,
  WindowConfig,
  WslServerConfig,
  WslServersEvent,
  WslServersState,
} from "../preload/types"
import { getStore } from "./store"
import { setTitlebar } from "./windows"

const pickerFilters = (ext?: string[]) => {
  if (!ext || ext.length === 0) return undefined
  return [{ name: "Files", extensions: ext }]
}

type Deps = {
  killSidecar: () => void
  relaunch: () => void
  awaitInitialization: (sendStep: (step: InitStep) => void) => Promise<ServerReadyData>
  getWslServersState: () => Promise<WslServersState> | WslServersState
  onWslServersEvent: (listener: (event: WslServersEvent) => void) => () => void
  wslServersProbeRuntime: () => Promise<void> | void
  wslServersRefreshDistros: () => Promise<void> | void
  wslServersInstallWsl: () => Promise<void> | void
  wslServersInstallDistro: (name: string) => Promise<void> | void
  wslServersProbeDistro: (name: string) => Promise<void> | void
  wslServersProbeOpencode: (name: string) => Promise<void> | void
  wslServersInstallOpencode: (name: string) => Promise<void> | void
  wslServersOpenTerminal: (name: string) => Promise<void> | void
  wslServersAddServer: (distro: string) => Promise<WslServerConfig> | WslServerConfig
  wslServersRemoveServer: (id: string) => Promise<void> | void
  wslServersStartServer: (id: string) => Promise<void> | void
  wslServersStopServer: (id: string) => Promise<void> | void
  wslServersCancelJob: () => Promise<void> | void
  getWindowConfig: () => Promise<WindowConfig> | WindowConfig
  consumeInitialDeepLinks: () => Promise<string[]> | string[]
  getDefaultServerUrl: () => Promise<string | null> | string | null
  setDefaultServerUrl: (url: string | null) => Promise<void> | void
  getDisplayBackend: () => Promise<string | null>
  setDisplayBackend: (backend: string | null) => Promise<void> | void
  parseMarkdown: (markdown: string) => Promise<string> | string
  checkAppExists: (appName: string) => Promise<boolean> | boolean
  wslPath: (path: string, mode: "windows" | "linux" | null, distro?: string | null) => Promise<string>
  resolveAppPath: (appName: string) => Promise<string | null>
  loadingWindowComplete: () => void
  runUpdater: (alertOnFail: boolean) => Promise<void> | void
  checkUpdate: () => Promise<{ updateAvailable: boolean; version?: string }>
  installUpdate: () => Promise<void> | void
  setBackgroundColor: (color: string) => void
}

export function registerIpcHandlers(deps: Deps) {
  const debugStore = (op: string, name: string, key: string, meta?: Record<string, unknown>) => {
    if (app.isPackaged) return
    if (!name.startsWith("opencode.workspace.")) return
    if (!key.includes("terminal")) return
    console.log(`[store ${op}] ${JSON.stringify({ name, key, ...meta })}`)
  }

  const requireString = (name: string, value: unknown) => {
    if (typeof value === "string" && value.length > 0) return value
    throw new Error(`Invalid ${name}`)
  }

  const trustedSender = (event: IpcMainEvent | IpcMainInvokeEvent) => {
    const raw = event.senderFrame?.url ?? event.sender.getURL()
    try {
      const url = new URL(raw)
      if (url.protocol === "oc:" && url.hostname === "renderer") return true
      if (!app.isPackaged && (url.hostname === "127.0.0.1" || url.hostname === "localhost")) return true
    } catch {
      return false
    }
    return false
  }

  const requireTrustedSender = (event: IpcMainEvent | IpcMainInvokeEvent) => {
    if (trustedSender(event)) return
    throw new Error("Untrusted IPC sender")
  }

  const handle = <Args extends unknown[]>(
    channel: string,
    listener: (event: IpcMainInvokeEvent, ...args: Args) => unknown,
  ) => {
    ipcMain.handle(channel, (event, ...args) => {
      requireTrustedSender(event)
      return listener(event, ...(args as Args))
    })
  }

  const on = <Args extends unknown[]>(channel: string, listener: (event: IpcMainEvent, ...args: Args) => void) => {
    ipcMain.on(channel, (event, ...args) => {
      if (!trustedSender(event)) return
      listener(event, ...(args as Args))
    })
  }

  const wslSubscriptions = new Map<number, () => void>()
  const unsubscribeWsl = (id: number) => {
    const off = wslSubscriptions.get(id)
    if (!off) return
    off()
    wslSubscriptions.delete(id)
  }

  app.once("will-quit", () => {
    for (const off of wslSubscriptions.values()) off()
    wslSubscriptions.clear()
  })

  handle("kill-sidecar", () => deps.killSidecar())
  handle("await-initialization", (event: IpcMainInvokeEvent) => {
    const send = (step: InitStep) => event.sender.send("init-step", step)
    return deps.awaitInitialization(send)
  })
  handle("wsl-servers-subscribe", (event) => {
    const id = event.sender.id
    if (wslSubscriptions.has(id)) return
    wslSubscriptions.set(
      id,
      deps.onWslServersEvent((payload) => {
        if (event.sender.isDestroyed()) {
          unsubscribeWsl(id)
          return
        }
        event.sender.send("wsl-servers-event", payload)
      }),
    )
    event.sender.once("destroyed", () => unsubscribeWsl(id))
  })
  handle("wsl-servers-unsubscribe", (event) => unsubscribeWsl(event.sender.id))
  handle("wsl-servers-get-state", () => deps.getWslServersState())
  handle("wsl-servers-probe-runtime", () => deps.wslServersProbeRuntime())
  handle("wsl-servers-refresh-distros", () => deps.wslServersRefreshDistros())
  handle("wsl-servers-install-wsl", () => deps.wslServersInstallWsl())
  handle("wsl-servers-install-distro", (_event: IpcMainInvokeEvent, name: string) =>
    deps.wslServersInstallDistro(requireString("distro", name)),
  )
  handle("wsl-servers-probe-distro", (_event: IpcMainInvokeEvent, name: string) =>
    deps.wslServersProbeDistro(requireString("distro", name)),
  )
  handle("wsl-servers-probe-opencode", (_event: IpcMainInvokeEvent, name: string) =>
    deps.wslServersProbeOpencode(requireString("distro", name)),
  )
  handle("wsl-servers-install-opencode", (_event: IpcMainInvokeEvent, name: string) =>
    deps.wslServersInstallOpencode(requireString("distro", name)),
  )
  handle("wsl-servers-open-terminal", (_event: IpcMainInvokeEvent, name: string) =>
    deps.wslServersOpenTerminal(requireString("distro", name)),
  )
  handle("wsl-servers-add", (_event: IpcMainInvokeEvent, distro: string) =>
    deps.wslServersAddServer(requireString("distro", distro)),
  )
  handle("wsl-servers-remove", (_event: IpcMainInvokeEvent, id: string) =>
    deps.wslServersRemoveServer(requireString("server id", id)),
  )
  handle("wsl-servers-start", (_event: IpcMainInvokeEvent, id: string) =>
    deps.wslServersStartServer(requireString("server id", id)),
  )
  handle("wsl-servers-stop", (_event: IpcMainInvokeEvent, id: string) =>
    deps.wslServersStopServer(requireString("server id", id)),
  )
  handle("wsl-servers-cancel", () => deps.wslServersCancelJob())
  handle("get-window-config", () => deps.getWindowConfig())
  handle("consume-initial-deep-links", () => deps.consumeInitialDeepLinks())
  handle("get-default-server-url", () => deps.getDefaultServerUrl())
  handle("set-default-server-url", (_event: IpcMainInvokeEvent, url: string | null) =>
    deps.setDefaultServerUrl(url),
  )
  handle("get-display-backend", () => deps.getDisplayBackend())
  handle("set-display-backend", (_event: IpcMainInvokeEvent, backend: string | null) =>
    deps.setDisplayBackend(backend),
  )
  handle("parse-markdown", (_event: IpcMainInvokeEvent, markdown: string) => deps.parseMarkdown(markdown))
  handle("check-app-exists", (_event: IpcMainInvokeEvent, appName: string) => deps.checkAppExists(appName))
  handle(
    "wsl-path",
    (_event: IpcMainInvokeEvent, path: string, mode: "windows" | "linux" | null, distro?: string | null) =>
      deps.wslPath(path, mode, distro),
  )
  handle("resolve-app-path", (_event: IpcMainInvokeEvent, appName: string) => deps.resolveAppPath(appName))
  on("loading-window-complete", () => deps.loadingWindowComplete())
  handle("run-updater", (_event: IpcMainInvokeEvent, alertOnFail: boolean) => deps.runUpdater(alertOnFail))
  handle("check-update", () => deps.checkUpdate())
  handle("install-update", () => deps.installUpdate())
  handle("set-background-color", (_event: IpcMainInvokeEvent, color: string) => deps.setBackgroundColor(color))
  handle("store-get", (_event: IpcMainInvokeEvent, name: string, key: string) => {
    const store = getStore(name)
    const value = store.get(key)
    debugStore("get", name, key, {
      found: value !== undefined && value !== null,
      length:
        typeof value === "string"
          ? value.length
          : value === undefined || value === null
            ? 0
            : JSON.stringify(value).length,
    })
    if (value === undefined || value === null) return null
    return typeof value === "string" ? value : JSON.stringify(value)
  })
  handle("store-set", (_event: IpcMainInvokeEvent, name: string, key: string, value: string) => {
    debugStore("set", name, key, { length: value.length })
    getStore(name).set(key, value)
  })
  handle("store-delete", (_event: IpcMainInvokeEvent, name: string, key: string) => {
    debugStore("delete", name, key)
    getStore(name).delete(key)
  })
  handle("store-clear", (_event: IpcMainInvokeEvent, name: string) => {
    getStore(name).clear()
  })
  handle("store-keys", (_event: IpcMainInvokeEvent, name: string) => {
    const store = getStore(name)
    return Object.keys(store.store)
  })
  handle("store-length", (_event: IpcMainInvokeEvent, name: string) => {
    const store = getStore(name)
    return Object.keys(store.store).length
  })

  handle(
    "open-directory-picker",
    async (_event: IpcMainInvokeEvent, opts?: { multiple?: boolean; title?: string; defaultPath?: string }) => {
      const result = await dialog.showOpenDialog({
        properties: ["openDirectory", ...(opts?.multiple ? ["multiSelections" as const] : []), "createDirectory"],
        title: opts?.title ?? "Choose a folder",
        defaultPath: opts?.defaultPath,
      })
      if (result.canceled) return null
      return opts?.multiple ? result.filePaths : result.filePaths[0]
    },
  )

  handle(
    "open-file-picker",
    async (
      _event: IpcMainInvokeEvent,
      opts?: { multiple?: boolean; title?: string; defaultPath?: string; accept?: string[]; extensions?: string[] },
    ) => {
      const result = await dialog.showOpenDialog({
        properties: ["openFile", ...(opts?.multiple ? ["multiSelections" as const] : [])],
        title: opts?.title ?? "Choose a file",
        defaultPath: opts?.defaultPath,
        filters: pickerFilters(opts?.extensions),
      })
      if (result.canceled) return null
      return opts?.multiple ? result.filePaths : result.filePaths[0]
    },
  )

  handle(
    "save-file-picker",
    async (_event: IpcMainInvokeEvent, opts?: { title?: string; defaultPath?: string }) => {
      const result = await dialog.showSaveDialog({
        title: opts?.title ?? "Save file",
        defaultPath: opts?.defaultPath,
      })
      if (result.canceled) return null
      return result.filePath ?? null
    },
  )

  on("open-link", (_event: IpcMainEvent, url: string) => {
    void shell.openExternal(url)
  })

  handle("open-path", async (_event: IpcMainInvokeEvent, path: string, app?: string) => {
    if (!app) return shell.openPath(path)
    await new Promise<void>((resolve, reject) => {
      const [cmd, args] =
        process.platform === "darwin" ? (["open", ["-a", app, path]] as const) : ([app, [path]] as const)
      execFile(cmd, args, (err) => (err ? reject(err) : resolve()))
    })
  })

  handle("read-clipboard-image", () => {
    const image = clipboard.readImage()
    if (image.isEmpty()) return null
    const buffer = image.toPNG().buffer
    const size = image.getSize()
    return { buffer, width: size.width, height: size.height }
  })

  on("show-notification", (_event: IpcMainEvent, title: string, body?: string) => {
    new Notification({ title, body }).show()
  })

  handle("get-window-count", () => BrowserWindow.getAllWindows().length)

  handle("get-window-focused", (event: IpcMainInvokeEvent) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    return win?.isFocused() ?? false
  })

  handle("set-window-focus", (event: IpcMainInvokeEvent) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    win?.focus()
  })

  handle("show-window", (event: IpcMainInvokeEvent) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    win?.show()
  })

  on("relaunch", () => {
    deps.relaunch()
  })

  handle("get-zoom-factor", (event: IpcMainInvokeEvent) => event.sender.getZoomFactor())
  handle("set-zoom-factor", (event: IpcMainInvokeEvent, factor: number) => event.sender.setZoomFactor(factor))
  handle("set-titlebar", (event: IpcMainInvokeEvent, theme: TitlebarTheme) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return
    setTitlebar(win, theme)
  })
}

export function sendSqliteMigrationProgress(win: BrowserWindow, progress: SqliteMigrationProgress) {
  win.webContents.send("sqlite-migration-progress", progress)
}

export function sendMenuCommand(win: BrowserWindow, id: string) {
  win.webContents.send("menu-command", id)
}

export function sendDeepLinks(win: BrowserWindow, urls: string[]) {
  win.webContents.send("deep-link", urls)
}
