// @refresh reload

// V8's default Error.stackTraceLimit truncates at 10 frames; raise it so
// reported errors come with a useful frame budget.
Error.stackTraceLimit = 200

// Install global error listeners before any other module runs so that
// uncaught errors and rejected promises reach the main process with their
// full stacks intact. Electron's `console-message` event only forwards the
// rethrow site, so without these we lose the originating frame.
window.addEventListener("error", (event) => {
  const err = event.error
  const stack = err instanceof Error ? err.stack : null
  console.error(
    "[renderer uncaught]",
    stack ?? event.message,
    stack ? "" : `${event.filename}:${event.lineno}:${event.colno}`,
  )
})

window.addEventListener("unhandledrejection", (event) => {
  const reason = event.reason
  // Log as much as possible: stack for Errors, JSON for plain objects with
  // a fallback to a tagged shape so we never end up with just
  // "[object Object]" in main.log.
  if (reason instanceof Error) {
    console.error("[renderer unhandled rejection]", reason.stack ?? reason.message ?? String(reason))
    return
  }
  let serialized: string
  try {
    serialized = JSON.stringify(
      reason,
      (_key, value) => {
        if (value instanceof Error) {
          return { __error: true, name: value.name, message: value.message, stack: value.stack }
        }
        return value
      },
      2,
    )
  } catch {
    serialized = String(reason)
  }
  console.error(
    "[renderer unhandled rejection]",
    `type=${typeof reason}`,
    `ctor=${reason?.constructor?.name ?? "null"}`,
    `keys=${reason && typeof reason === "object" ? Object.keys(reason).join(",") : "n/a"}`,
    "value:",
    serialized,
  )
})

import {
  ACCEPTED_FILE_EXTENSIONS,
  ACCEPTED_FILE_TYPES,
  AppBaseProviders,
  AppInterface,
  handleNotificationClick,
  loadLocaleDict,
  normalizeLocale,
  type Locale,
  type Platform,
  PlatformProvider,
  ServerConnection,
  useCommand,
  useWslServers,
} from "@opencode-ai/app"
import * as Sentry from "@sentry/solid"
import type { AsyncStorage } from "@solid-primitives/storage"
import { MemoryRouter } from "@solidjs/router"
import { createEffect, createMemo, createResource, onCleanup, onMount } from "solid-js"
import { render } from "solid-js/web"
import pkg from "../../package.json"
import { initI18n, t } from "./i18n"
import { webviewZoom, zoomIn, zoomOut, zoomReset } from "./webview-zoom"
import "./styles.css"
import { Button } from "@opencode-ai/ui/button"
import { Splash } from "@opencode-ai/ui/logo"
import { useTheme } from "@opencode-ai/ui/theme"

const root = document.getElementById("root")
if (import.meta.env.DEV && !(root instanceof HTMLElement)) {
  throw new Error(t("error.dev.rootNotFound"))
}

if (import.meta.env.VITE_SENTRY_DSN) {
  Sentry.init({
    dsn: import.meta.env.VITE_SENTRY_DSN,
    environment: import.meta.env.VITE_SENTRY_ENVIRONMENT ?? import.meta.env.MODE,
    release: import.meta.env.VITE_SENTRY_RELEASE ?? `desktop-electron@${pkg.version}`,
    initialScope: {
      tags: {
        platform: "desktop-electron",
      },
    },
    integrations: (integrations) => {
      return integrations.filter(
        (i) =>
          i.name !== "Breadcrumbs" && !(import.meta.env.OPENCODE_CHANNEL === "prod" && i.name === "GlobalHandlers"),
      )
    },
  })
}

void initI18n()

const deepLinkEvent = "opencode:deep-link"

const emitDeepLinks = (urls: string[]) => {
  if (urls.length === 0) return
  window.__OPENCODE__ ??= {}
  const pending = window.__OPENCODE__.deepLinks ?? []
  window.__OPENCODE__.deepLinks = [...pending, ...urls]
  window.dispatchEvent(new CustomEvent(deepLinkEvent, { detail: { urls } }))
}

const listenForDeepLinks = () => {
  void window.api.consumeInitialDeepLinks().then((urls) => emitDeepLinks(urls))
  return window.api.onDeepLink((urls) => emitDeepLinks(urls))
}

function LocalServerStartupError(props: { message: string }) {
  return (
    <div class="h-dvh w-screen flex flex-col items-center justify-center bg-background-base gap-6 p-6">
      <div class="flex flex-col items-center max-w-md text-center">
        <Splash class="w-12 h-15 mb-4" />
        <p class="text-16-medium text-text-strong">Local Server failed to start</p>
        <p class="mt-2 text-12-regular text-text-weak whitespace-pre-wrap break-words">{props.message}</p>
        <Button variant="secondary" size="large" class="mt-4" onClick={() => window.api.relaunch()}>
          Relaunch
        </Button>
      </div>
    </div>
  )
}

const createPlatform = (): Platform => {
  const os = (() => {
    const ua = navigator.userAgent
    if (ua.includes("Mac")) return "macos"
    if (ua.includes("Windows")) return "windows"
    if (ua.includes("Linux")) return "linux"
    return undefined
  })()

  const activeWslDistro = () => {
    const key = window.__OPENCODE__?.activeServer
    if (!key || !key.startsWith("wsl:")) return undefined
    return key.slice("wsl:".length)
  }

  const wslHome = async () => {
    const distro = activeWslDistro()
    if (!distro) return undefined
    return window.api.wslPath("~", "windows", distro)
  }

  const handleWslPicker = async <T extends string | string[] | null>(result: T): Promise<T> => {
    const distro = activeWslDistro()
    if (!result || !distro) return result
    const convert = (path: string) => window.api.wslPath(path, "linux", distro)
    if (Array.isArray(result)) {
      return (await Promise.all(result.map(convert))) as T
    }
    return (await convert(result)) as T
  }

  const storage = (() => {
    const cache = new Map<string, AsyncStorage>()

    const createStorage = (name: string) => {
      const api: AsyncStorage = {
        getItem: (key: string) => window.api.storeGet(name, key),
        setItem: (key: string, value: string) => window.api.storeSet(name, key, value),
        removeItem: (key: string) => window.api.storeDelete(name, key),
        clear: () => window.api.storeClear(name),
        key: async (index: number) => (await window.api.storeKeys(name))[index],
        getLength: () => window.api.storeLength(name),
        get length() {
          return api.getLength()
        },
      }
      return api
    }

    return (name = "default.dat") => {
      const cached = cache.get(name)
      if (cached) return cached
      const api = createStorage(name)
      cache.set(name, api)
      return api
    }
  })()

  const wslServersApi = os === "windows" ? window.api.wslServers : undefined

  return {
    platform: "desktop",
    os,
    version: pkg.version,

    async openDirectoryPickerDialog(opts) {
      const defaultPath = await wslHome()
      const result = await window.api.openDirectoryPicker({
        multiple: opts?.multiple ?? false,
        title: opts?.title ?? t("desktop.dialog.chooseFolder"),
        defaultPath,
      })
      return await handleWslPicker(result)
    },

    async openFilePickerDialog(opts) {
      const result = await window.api.openFilePicker({
        multiple: opts?.multiple ?? false,
        title: opts?.title ?? t("desktop.dialog.chooseFile"),
        accept: opts?.accept ?? ACCEPTED_FILE_TYPES,
        extensions: opts?.extensions ?? ACCEPTED_FILE_EXTENSIONS,
      })
      return handleWslPicker(result)
    },

    async saveFilePickerDialog(opts) {
      const result = await window.api.saveFilePicker({
        title: opts?.title ?? t("desktop.dialog.saveFile"),
        defaultPath: opts?.defaultPath,
      })
      return handleWslPicker(result)
    },

    openLink(url: string) {
      window.api.openLink(url)
    },
    async openPath(path: string, app?: string) {
      if (os === "windows") {
        const resolvedApp = app ? await window.api.resolveAppPath(app).catch(() => null) : null
        const resolvedPath = await (async () => {
          const distro = activeWslDistro()
          if (distro) return window.api.wslPath(path, "windows", distro)
          return path
        })()
        return window.api.openPath(resolvedPath, resolvedApp ?? undefined)
      }
      return window.api.openPath(path, app)
    },

    back() {
      window.history.back()
    },

    forward() {
      window.history.forward()
    },

    storage,

    checkUpdate: async () => {
      const config = await window.api.getWindowConfig().catch(() => ({ updaterEnabled: false }))
      if (!config.updaterEnabled) return { updateAvailable: false }
      return window.api.checkUpdate()
    },

    updateAndRestart: async () => {
      const config = await window.api.getWindowConfig().catch(() => ({ updaterEnabled: false }))
      if (!config.updaterEnabled) return
      await window.api.installUpdate()
    },

    restart: async () => {
      await window.api.killSidecar().catch(() => undefined)
      window.api.relaunch()
    },

    notify: async (title, description, href) => {
      const focused = await window.api.getWindowFocused().catch(() => document.hasFocus())
      if (focused) return

      const notification = new Notification(title, {
        body: description ?? "",
        icon: "https://opencode.ai/favicon-96x96-v3.png",
      })
      notification.onclick = () => {
        void window.api.showWindow()
        void window.api.setWindowFocus()
        handleNotificationClick(href)
        notification.close()
      }
    },

    fetch,

    getDefaultServer: async () => {
      const url = await window.api.getDefaultServerUrl().catch(() => null)
      if (!url) return null
      return ServerConnection.Key.make(url)
    },

    setDefaultServer: async (url: string | null) => {
      await window.api.setDefaultServerUrl(url)
    },

    wslServers: wslServersApi,

    getDisplayBackend: async () => {
      return window.api.getDisplayBackend().catch(() => null)
    },

    setDisplayBackend: async (backend) => {
      await window.api.setDisplayBackend(backend)
    },

    parseMarkdown: (markdown: string) => window.api.parseMarkdownCommand(markdown),

    webviewZoom,

    checkAppExists: async (appName: string) => {
      return window.api.checkAppExists(appName)
    },

    async readClipboardImage() {
      const image = await window.api.readClipboardImage().catch(() => null)
      if (!image) return null
      const blob = new Blob([image.buffer], { type: "image/png" })
      return new File([blob], `pasted-image-${Date.now()}.png`, {
        type: "image/png",
      })
    },
  }
}

let menuTrigger = null as null | ((id: string) => void)
window.api.onMenuCommand((id) => {
  if (id === "zoom.in") return zoomIn()
  if (id === "zoom.out") return zoomOut()
  if (id === "zoom.reset") return zoomReset()
  menuTrigger?.(id)
})
listenForDeepLinks()

render(() => {
  const platform = createPlatform()
  const loadLocale = async () => {
    const current = await platform.storage?.("opencode.global.dat").getItem("language")
    const legacy = current ? undefined : await platform.storage?.().getItem("language.v1")
    const raw = current ?? legacy
    if (!raw) return
    const locale = raw.match(/"locale"\s*:\s*"([^"]+)"/)?.[1]
    if (!locale) return
    const next = normalizeLocale(locale)
    if (next !== "en") await loadLocaleDict(next)
    return next satisfies Locale
  }

  const [windowCount] = createResource(() => window.api.getWindowCount())

  const [startup] = createResource(async () => {
    try {
      return {
        error: null,
        sidecar: await window.api.awaitInitialization(() => undefined),
      }
    } catch (error) {
      return {
        error: error instanceof Error ? error.message : String(error),
        sidecar: null,
      }
    }
  })

  const [defaultServer] = createResource(() => platform.getDefaultServer?.())
  const [locale] = createResource(loadLocale)

  function handleClick(e: MouseEvent) {
    const link = (e.target as HTMLElement).closest("a.external-link") as HTMLAnchorElement | null
    if (link?.href) {
      e.preventDefault()
      platform.openLink(link.href)
    }
  }

  function Inner() {
    const cmd = useCommand()
    menuTrigger = (id) => cmd.trigger(id)

    const theme = useTheme()

    createEffect(() => {
      theme.themeId()
      theme.mode()
      const bg = getComputedStyle(document.documentElement).getPropertyValue("--background-base").trim()
      if (bg) {
        void window.api.setBackgroundColor(bg)
      }
    })

    return null
  }

  function App() {
    const wslServers = useWslServers()
    const splash = (
      <div class="h-dvh w-screen flex flex-col items-center justify-center bg-background-base">
        <Splash class="w-16 h-20 opacity-50 animate-pulse" />
      </div>
    )

    const ready = createMemo(
      () =>
        !defaultServer.loading &&
        !startup.loading &&
        !windowCount.loading &&
        !locale.loading,
    )
    const servers = createMemo(() => {
      const data = startup.latest?.sidecar
      const list: ServerConnection.Any[] = []
      if (data) {
        list.push({
          displayName: "Local Server",
          type: "sidecar",
          variant: "base",
          http: {
            url: data.url,
            username: data.username ?? undefined,
            password: data.password ?? undefined,
          },
        })
      }
      for (const item of wslServers.data?.servers ?? []) {
        const runtime = item.runtime
        if (runtime.kind !== "ready") continue
        list.push({
          displayName: item.config.distro,
          type: "sidecar",
          variant: "wsl",
          distro: item.config.distro,
          http: {
            url: runtime.url,
            username: runtime.username ?? undefined,
            password: runtime.password ?? undefined,
          },
        })
      }
      return list
    })
    if (!ready()) return splash
    if (startup.latest?.error) {
      return <LocalServerStartupError message={startup.latest.error} />
    }

    return (
      <AppInterface
        defaultServer={defaultServer.latest ?? ServerConnection.Key.make("local:windows")}
        serversReady={!platform.wslServers || !wslServers.isPending}
        servers={servers()}
        router={MemoryRouter}
      >
        <Inner />
      </AppInterface>
    )
  }

  onMount(() => {
    document.addEventListener("click", handleClick)
    onCleanup(() => {
      document.removeEventListener("click", handleClick)
    })
  })

  return (
    <PlatformProvider value={platform}>
      <AppBaseProviders locale={locale.latest}>
        <App />
      </AppBaseProviders>
    </PlatformProvider>
  )
}, root!)
