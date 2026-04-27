import { randomUUID } from "node:crypto"
import { EventEmitter } from "node:events"
import { existsSync } from "node:fs"
import * as nodeHttp from "node:http"
import * as nodeHttps from "node:https"
import { homedir } from "node:os"
import { join } from "node:path"
import type { Event } from "electron"
import { app, BrowserWindow, dialog } from "electron"
import pkg from "electron-updater"
import { drizzle } from "drizzle-orm/node-sqlite/driver"
import type { Server } from "virtual:opencode-server"

import contextMenu from "electron-context-menu"
contextMenu({ showSaveImageAs: true, showLookUpSelection: false, showSearchWithGoogle: false })

// on macOS apps run in `/` which can cause issues with ripgrep
try {
  process.chdir(homedir())
} catch {}

process.env.OPENCODE_DISABLE_EMBEDDED_WEB_UI = "true"

const APP_NAMES: Record<string, string> = {
  dev: "OpenCode Dev",
  beta: "OpenCode Beta",
  prod: "OpenCode",
}
const APP_IDS: Record<string, string> = {
  dev: "ai.opencode.desktop.dev",
  beta: "ai.opencode.desktop.beta",
  prod: "ai.opencode.desktop",
}
const appId = app.isPackaged ? APP_IDS[CHANNEL] : "ai.opencode.desktop.dev"
app.setName(app.isPackaged ? APP_NAMES[CHANNEL] : "OpenCode Dev")
app.setAppUserModelId(appId)
app.setPath("userData", join(app.getPath("appData"), appId))
const { autoUpdater } = pkg

import type { InitStep, ServerReadyData, SqliteMigrationProgress } from "../preload/types"
import { checkAppExists, resolveAppPath, wslPath } from "./apps"
import { CHANNEL, UPDATER_ENABLED, WSL_SERVERS_KEY } from "./constants"
import { registerIpcHandlers, sendDeepLinks, sendMenuCommand, sendSqliteMigrationProgress } from "./ipc"
import { initLogging } from "./logging"
import { parseMarkdown } from "./markdown"
import { createMenu } from "./menu"
import { allocatePort, getDefaultServerUrl, setDefaultServerUrl, spawnLocalServer, spawnWslSidecar } from "./server"
import { getStore } from "./store"
import { createWslServersController } from "./wsl-servers"
import {
  createLoadingWindow,
  createMainWindow,
  registerRendererProtocol,
  setBackgroundColor,
  setDockIcon,
} from "./windows"

const initEmitter = new EventEmitter()
let initStep: InitStep = { phase: "server_waiting" }

let mainWindow: BrowserWindow | null = null
let server: Server.Listener | null = null
const loadingComplete = defer<void>()

const pendingDeepLinks: string[] = []

const serverReady = defer<ServerReadyData>()
void serverReady.promise.catch(() => undefined)
const logger = initLogging()
const wslServers = createWslServersController(
  app.getVersion(),
  async (distro) => {
    logger.log("spawning wsl sidecar", { distro })
    return spawnWslSidecar(distro, {
      onLine: (line) => logger.log("wsl sidecar", { distro, stream: line.stream, text: line.text }),
    })
  },
  {
    log: (message, meta) => logger.log(message, meta),
    error: (message, meta) => logger.error(message, meta),
  },
)

logger.log("app starting", {
  version: app.getVersion(),
  packaged: app.isPackaged,
})
// NOTE: the first getStore() call here is intentional — it is the earliest
// point after `app.setName` / `app.setPath("userData", ...)` have run, so
// electron-store correctly resolves its root to the channel-specific
// userData dir (`...desktop.dev` in dev) rather than the package.json name.
logger.log("config paths", {
  userData: app.getPath("userData"),
  settingsStore: getStore().path,
  wslServersKey: WSL_SERVERS_KEY,
  wslServers: getStore().get(WSL_SERVERS_KEY) ?? null,
})

setupApp()

function setupApp() {
  ensureLoopbackNoProxy()
  app.commandLine.appendSwitch("proxy-bypass-list", "<-loopback>")

  process.on("uncaughtException", (error) => {
    logger.error("main process uncaught exception", error)
  })

  process.on("unhandledRejection", (reason) => {
    logger.error("main process unhandled rejection", reason)
  })

  if (!app.requestSingleInstanceLock()) {
    app.quit()
    return
  }

  app.on("second-instance", (_event: Event, argv: string[]) => {
    const urls = argv.filter((arg: string) => arg.startsWith("opencode://"))
    if (urls.length) {
      logger.log("deep link received via second-instance", { urls })
      emitDeepLinks(urls)
    }
    focusMainWindow()
  })

  app.on("open-url", (event: Event, url: string) => {
    event.preventDefault()
    logger.log("deep link received via open-url", { url })
    emitDeepLinks([url])
  })

  app.on("before-quit", () => {
    killSidecar()
    wslServers.stopAll()
  })

  app.on("will-quit", () => {
    killSidecar()
    wslServers.stopAll()
  })

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      killSidecar()
      wslServers.stopAll()
      app.exit(0)
    })
  }

  void app.whenReady().then(async () => {
    app.setAsDefaultProtocolClient("opencode")
    registerRendererProtocol()
    setDockIcon()
    setupAutoUpdater()
    await initialize()
  })
}

function emitDeepLinks(urls: string[]) {
  if (urls.length === 0) return
  pendingDeepLinks.push(...urls)
  if (mainWindow) sendDeepLinks(mainWindow, urls)
}

function focusMainWindow() {
  if (!mainWindow) return
  mainWindow.show()
  mainWindow.focus()
}

function setInitStep(step: InitStep) {
  initStep = step
  logger.log("init step", { step })
  initEmitter.emit("step", step)
}

async function initialize() {
  const needsMigration = !sqliteFileExists()
  let overlay: BrowserWindow | null = null

  const port = await allocatePort()
  const hostname = "127.0.0.1"
  const url = `http://${hostname}:${port}`
  const password = randomUUID()
  const key = "local:windows"

  const startupData: ServerReadyData = {
    url,
    username: "opencode",
    password,
    local: {
      key,
      url,
      username: "opencode",
      password,
    },
  }
  const loadingTask = (async () => {
    logger.log("sidecar connection started", { url })

    initEmitter.on("sqlite", (progress: SqliteMigrationProgress) => {
      setInitStep({ phase: "sqlite_waiting" })
      if (overlay) sendSqliteMigrationProgress(overlay, progress)
      if (mainWindow) sendSqliteMigrationProgress(mainWindow, progress)
    })

    if (needsMigration) {
      const { Database, JsonMigration } = await import("virtual:opencode-server")
      await JsonMigration.run(drizzle({ client: Database.Client().$client }), {
        progress: (event: { current: number; total: number }) => {
          const percent = Math.round((event.current / event.total) * 100)
          initEmitter.emit("sqlite", { type: "InProgress", value: percent })
        },
      })
      initEmitter.emit("sqlite", { type: "Done" })
    }

    logger.log("spawning windows sidecar", { url })
    let startupError: Error | null = null
    const startup = await (async () => {
      try {
        return await spawnLocalServer(hostname, port, password)
      } catch (error) {
        startupError = asError(error)
        logger.error("windows sidecar startup failed", startupError)
        return undefined
      }
    })()
    server = startup?.listener ?? null

    // Initialize WSL sidecars in parallel; failures do not block app startup.
    void wslServers.initialize().catch((error) => logger.error("wsl server initialization failed", asError(error)))

    if (startup) {
      await Promise.race([
        startup.health.wait,
        delay(30_000).then(() => {
          throw new Error("Sidecar health check timed out")
        }),
      ])
        .then(() => {
          serverReady.resolve(startupData)
        })
        .catch((error) => {
          startupError = asError(error)
          logger.error("sidecar health check failed", startupError)
          serverReady.reject(startupError)
        })
    } else {
      serverReady.reject(startupError ?? new Error("Local server startup failed"))
    }

    logger.log("loading task finished")
  })()

  if (needsMigration) {
    const show = await Promise.race([loadingTask.then(() => false), delay(1_000).then(() => true)])
    if (show) {
      overlay = createLoadingWindow()
      wireWindowDiagnostics(overlay, "loading")
      await delay(1_000)
    }
  }

  await loadingTask
  setInitStep({ phase: "done" })

  if (overlay) {
    await loadingComplete.promise
  }

  mainWindow = createMainWindow()
  wireWindowDiagnostics(mainWindow, "main")
  wireMenu()

  overlay?.close()
}

function wireWindowDiagnostics(win: BrowserWindow, label: string) {
  win.webContents.on("console-message", (_event, level, message, line, sourceId) => {
    // Render `message` as a block so multi-line stack traces survive; the
    // previous shape stuffed the message into a JSON object which escaped
    // `\n` and made stacks unreadable.
    const location = sourceId ? ` [${sourceId}:${line}]` : ""
    const text = `${label} renderer${location}\n${message}`
    if (level >= 3) {
      logger.error(text)
      return
    }
    if (level >= 2) {
      logger.warn(text)
      return
    }
    logger.log(text)
  })

  win.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    logger.error(`${label} renderer failed load`, {
      errorCode,
      errorDescription,
      validatedURL,
      isMainFrame,
    })
  })

  win.webContents.on("render-process-gone", (_event, details) => {
    logger.error(`${label} renderer process gone`, details)
  })

  win.webContents.on("preload-error", (_event, path, error) => {
    logger.error(`${label} preload error`, {
      path,
      error: error instanceof Error ? (error.stack ?? error.message) : String(error),
    })
  })

  // DevTools accelerators on Windows/Linux where the menu isn't created.
  win.webContents.on("before-input-event", (_event, input) => {
    if (input.type !== "keyDown") return
    const key = input.key
    const toggle =
      key === "F12" ||
      (input.control && input.shift && (key === "I" || key === "i")) ||
      (input.meta && input.alt && (key === "I" || key === "i"))
    if (!toggle) return
    win.webContents.toggleDevTools()
  })

  win.on("unresponsive", () => {
    logger.error(`${label} window became unresponsive`)
  })
}

function wireMenu() {
  if (!mainWindow) return
  createMenu({
    trigger: (id) => mainWindow && sendMenuCommand(mainWindow, id),
    checkForUpdates: () => {
      void checkForUpdates(true)
    },
    reload: () => mainWindow?.reload(),
    relaunch: () => relaunchApp(),
  })
}

registerIpcHandlers({
  httpFetch: (input) => bridgedHttpFetch(input),
  killSidecar: () => killSidecar(),
  relaunch: () => relaunchApp(),
  awaitInitialization: async (sendStep) => {
    sendStep(initStep)
    const listener = (step: InitStep) => sendStep(step)
    initEmitter.on("step", listener)
    try {
      logger.log("awaiting server ready")
      const res = await serverReady.promise
      logger.log("server ready", { url: res.url })
      return res
    } finally {
      initEmitter.off("step", listener)
    }
  },
  getWslServersState: () => wslServers.getState(),
  onWslServersEvent: (listener) => wslServers.subscribe(listener),
  wslServersProbeRuntime: () => wslServers.probeRuntime(),
  wslServersRefreshDistros: () => wslServers.refreshDistros(),
  wslServersInstallWsl: () => wslServers.installWsl(),
  wslServersInstallDistro: (name) => wslServers.installDistro(name),
  wslServersProbeDistro: (name) => wslServers.probeDistro(name),
  wslServersProbeOpencode: (name) => wslServers.probeOpencode(name),
  wslServersInstallOpencode: (name) => wslServers.installOpencode(name),
  wslServersOpenTerminal: (name) => wslServers.openTerminal(name),
  wslServersAddServer: (distro) => wslServers.addServer(distro),
  wslServersRemoveServer: (id) => wslServers.removeServer(id),
  wslServersStartServer: (id) => wslServers.startServer(id),
  wslServersStopServer: (id) => wslServers.stopServer(id),
  wslServersCancelJob: () => wslServers.cancelJob(),
  wslServersUpdateAcknowledgements: (id, acks) => wslServers.updateAcknowledgements(id, acks),
  getWindowConfig: () => ({ updaterEnabled: UPDATER_ENABLED }),
  consumeInitialDeepLinks: () => pendingDeepLinks.splice(0),
  getDefaultServerUrl: () => getDefaultServerUrl(),
  setDefaultServerUrl: (url) => setDefaultServerUrl(url),
  getDisplayBackend: async () => null,
  setDisplayBackend: async () => undefined,
  parseMarkdown: async (markdown) => parseMarkdown(markdown),
  checkAppExists: async (appName) => checkAppExists(appName),
  wslPath: async (path, mode, distro) => wslPath(path, mode, distro),
  resolveAppPath: async (appName) => resolveAppPath(appName),
  loadingWindowComplete: () => loadingComplete.resolve(),
  runUpdater: async (alertOnFail) => checkForUpdates(alertOnFail),
  checkUpdate: async () => checkUpdate(),
  installUpdate: async () => installUpdate(),
  setBackgroundColor: (color) => setBackgroundColor(color),
})

function killSidecar() {
  if (!server) return
  server.stop()
  server = null
}

function relaunchApp() {
  // app.exit() skips before-quit / will-quit, so relaunch callers must
  // explicitly stop sidecars here rather than relying on process hooks.
  killSidecar()
  wslServers.stopAll()
  app.relaunch()
  app.exit(0)
}

// Uses node http clients directly rather than global fetch (undici). On Windows,
// undici pools keep-alive sockets across requests; the WSL2 port proxy
// silently drops idle loopback sockets, so reusing one hangs until timeout.
// `agent: false` + `Connection: close` forces a fresh TCP connection per
// request, which is the only reliable way to hit a WSL-forwarded port.
const BRIDGED_HTTP_METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"])
const MAX_BRIDGED_HTTP_BODY_BYTES = 25 * 1024 * 1024

function bridgedHttpFetch(
  input: {
    url: string
    method: string
    headers: Record<string, string>
    body?: string
    timeoutMs?: number
  },
): Promise<{
  status: number
  statusText: string
  headers: Record<string, string>
  body: string
}> {
  return new Promise((resolve, reject) => {
    let parsed: URL
    try {
      parsed = new URL(input.url)
    } catch (error) {
      reject(new Error(`httpFetch: invalid url ${input.url}: ${String(error)}`))
      return
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      reject(new Error(`httpFetch: only http: and https: are supported (got ${parsed.protocol})`))
      return
    }
    const method = input.method.toUpperCase()
    if (!BRIDGED_HTTP_METHODS.has(method)) {
      reject(new Error(`httpFetch: unsupported method ${input.method}`))
      return
    }
    if (input.body && Buffer.byteLength(input.body) > MAX_BRIDGED_HTTP_BODY_BYTES) {
      reject(new Error(`httpFetch: request body exceeded ${MAX_BRIDGED_HTTP_BODY_BYTES} bytes`))
      return
    }

    const req = (parsed.protocol === "https:" ? nodeHttps : nodeHttp).request({
      host: parsed.hostname,
      port: parsed.port ? Number(parsed.port) : parsed.protocol === "https:" ? 443 : 80,
      path: `${parsed.pathname}${parsed.search}`,
      method,
      headers: { ...input.headers, connection: "close" },
      agent: false,
    })

    const timeoutMs = input.timeoutMs ?? 15_000
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`httpFetch: timeout after ${timeoutMs}ms (${input.method} ${input.url})`))
    })

    req.once("error", (error) => {
      const err = error as NodeJS.ErrnoException
      const detail = [err.name, err.code, err.message].filter(Boolean).join(" | ")
      reject(new Error(`httpFetch: ${detail || "unknown error"}`))
    })

    req.once("response", (res) => {
      const chunks: Buffer[] = []
      let bytes = 0
      res.on("data", (chunk: Buffer) => {
        bytes += chunk.length
        if (bytes <= MAX_BRIDGED_HTTP_BODY_BYTES) {
          chunks.push(chunk)
          return
        }
        res.destroy(new Error(`httpFetch: response exceeded ${MAX_BRIDGED_HTTP_BODY_BYTES} bytes`))
      })
      res.once("end", () => {
        const headers: Record<string, string> = {}
        for (const [key, value] of Object.entries(res.headers)) {
          if (value === undefined) continue
          headers[key] = Array.isArray(value) ? value.join(", ") : String(value)
        }
        resolve({
          status: res.statusCode ?? 0,
          statusText: res.statusMessage ?? "",
          headers,
          body: Buffer.concat(chunks).toString("utf8"),
        })
      })
      res.once("error", (error) => {
        reject(new Error(`httpFetch response error: ${String(error)}`))
      })
    })

    if (input.body !== undefined) req.write(input.body)
    req.end()
  })
}

function ensureLoopbackNoProxy() {
  const loopback = ["127.0.0.1", "localhost", "::1"]
  const upsert = (key: string) => {
    const items = (process.env[key] ?? "")
      .split(",")
      .map((value: string) => value.trim())
      .filter((value: string) => Boolean(value))

    for (const host of loopback) {
      if (items.some((value: string) => value.toLowerCase() === host)) continue
      items.push(host)
    }

    process.env[key] = items.join(",")
  }

  upsert("NO_PROXY")
  upsert("no_proxy")
}

function sqliteFileExists() {
  const xdg = process.env.XDG_DATA_HOME
  const base = xdg && xdg.length > 0 ? xdg : join(homedir(), ".local", "share")
  return existsSync(join(base, "opencode", "opencode.db"))
}

function setupAutoUpdater() {
  if (!UPDATER_ENABLED) return
  autoUpdater.logger = logger
  autoUpdater.channel = "latest"
  autoUpdater.allowPrerelease = false
  autoUpdater.allowDowngrade = true
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = true
  logger.log("auto updater configured", {
    channel: autoUpdater.channel,
    allowPrerelease: autoUpdater.allowPrerelease,
    allowDowngrade: autoUpdater.allowDowngrade,
    currentVersion: app.getVersion(),
  })
}

let downloadedUpdateVersion: string | undefined

async function checkUpdate() {
  if (!UPDATER_ENABLED) return { updateAvailable: false }
  if (downloadedUpdateVersion) {
    logger.log("returning cached downloaded update", {
      version: downloadedUpdateVersion,
    })
    return { updateAvailable: true, version: downloadedUpdateVersion }
  }
  logger.log("checking for updates", {
    currentVersion: app.getVersion(),
    channel: autoUpdater.channel,
    allowPrerelease: autoUpdater.allowPrerelease,
    allowDowngrade: autoUpdater.allowDowngrade,
  })
  try {
    const result = await autoUpdater.checkForUpdates()
    const updateInfo = result?.updateInfo
    logger.log("update metadata fetched", {
      releaseVersion: updateInfo?.version ?? null,
      releaseDate: updateInfo?.releaseDate ?? null,
      releaseName: updateInfo?.releaseName ?? null,
      files: updateInfo?.files?.map((file) => file.url) ?? [],
    })
    const version = result?.updateInfo?.version
    if (result?.isUpdateAvailable === false || !version) {
      logger.log("no update available", {
        reason: "provider returned no newer version",
      })
      return { updateAvailable: false }
    }
    logger.log("update available", { version })
    await autoUpdater.downloadUpdate()
    logger.log("update download completed", { version })
    downloadedUpdateVersion = version
    return { updateAvailable: true, version }
  } catch (error) {
    logger.error("update check failed", error)
    return { updateAvailable: false, failed: true }
  }
}

async function installUpdate() {
  if (!downloadedUpdateVersion) {
    logger.log("install update skipped", {
      reason: "no downloaded update ready",
    })
    return
  }
  logger.log("installing downloaded update", {
    version: downloadedUpdateVersion,
  })
  killSidecar()
  wslServers.stopAll()
  autoUpdater.quitAndInstall()
}

async function checkForUpdates(alertOnFail: boolean) {
  if (!UPDATER_ENABLED) return
  logger.log("checkForUpdates invoked", { alertOnFail })
  const result = await checkUpdate()
  if (!result.updateAvailable) {
    if (result.failed) {
      logger.log("no update decision", { reason: "update check failed" })
      if (!alertOnFail) return
      await dialog.showMessageBox({
        type: "error",
        message: "Update check failed.",
        title: "Update Error",
      })
      return
    }

    logger.log("no update decision", { reason: "already up to date" })
    if (!alertOnFail) return
    await dialog.showMessageBox({
      type: "info",
      message: "You're up to date.",
      title: "No Updates",
    })
    return
  }

  const response = await dialog.showMessageBox({
    type: "info",
    message: `Update ${result.version ?? ""} downloaded. Restart now?`,
    title: "Update Ready",
    buttons: ["Restart", "Later"],
    defaultId: 0,
    cancelId: 1,
  })
  logger.log("update prompt response", {
    version: result.version ?? null,
    restartNow: response.response === 0,
  })
  if (response.response === 0) {
    await installUpdate()
  }
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function asError(error: unknown) {
  return error instanceof Error ? error : new Error(String(error))
}

function defer<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}
