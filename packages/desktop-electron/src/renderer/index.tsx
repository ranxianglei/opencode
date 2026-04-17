// @refresh reload

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
  const stack = reason instanceof Error ? reason.stack : null
  console.error("[renderer unhandled rejection]", stack ?? reason)
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
  type WslServersEvent,
  type WslServersState,
} from "@opencode-ai/app"
import type { AsyncStorage } from "@solid-primitives/storage"
import { MemoryRouter } from "@solidjs/router"
import { createEffect, createResource, createSignal, onCleanup, onMount, Show } from "solid-js"
import { render } from "solid-js/web"
import pkg from "../../package.json"
import { initI18n, t } from "./i18n"
import { UPDATER_ENABLED } from "./updater"
import { webviewZoom, zoomIn, zoomOut, zoomReset } from "./webview-zoom"
import "./styles.css"
import { Button } from "@opencode-ai/ui/button"
import { Splash } from "@opencode-ai/ui/logo"
import { useTheme } from "@opencode-ai/ui/theme"

const root = document.getElementById("root")
if (import.meta.env.DEV && !(root instanceof HTMLElement)) {
  throw new Error(t("error.dev.rootNotFound"))
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
  const startUrls = window.__OPENCODE__?.deepLinks ?? []
  if (startUrls.length) emitDeepLinks(startUrls)
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
    return window.api.wslPath("~", "windows", distro).catch(() => undefined)
  }

  const handleWslPicker = async <T extends string | string[]>(result: T | null): Promise<T | null> => {
    const distro = activeWslDistro()
    if (!result || !distro) return result
    if (Array.isArray(result)) {
      return Promise.all(result.map((path) => window.api.wslPath(path, "linux", distro).catch(() => path))) as any
    }
    return window.api.wslPath(result, "linux", distro).catch(() => result) as any
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
          if (distro) {
            const converted = await window.api.wslPath(path, "windows", distro).catch(() => null)
            if (converted) return converted
          }
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
      if (!UPDATER_ENABLED()) return { updateAvailable: false }
      return window.api.checkUpdate()
    },

    update: async () => {
      if (!UPDATER_ENABLED()) return
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

    fetch: (input, init) => {
      if (input instanceof Request) return fetch(input)
      return fetch(input, init)
    },

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

  const [defaultServer] = createResource(() =>
    platform.getDefaultServer?.().then((url) => {
      if (url) return ServerConnection.key({ type: "http", http: { url } })
    }),
  )
  const [locale] = createResource(loadLocale)

  const [wslServers, setWslServers] = createSignal<WslServersState | null>(null)
  if (platform.wslServers) {
    void platform.wslServers.getState().then((state) => setWslServers(state))
    const off = platform.wslServers.subscribe((event: WslServersEvent) => setWslServers(event.state))
    onCleanup(off)
  }

  const servers = () => {
    const data = startup.latest?.sidecar
    const list: ServerConnection.Any[] = []
    if (data) {
      list.push({
        displayName: "Local Server",
        type: "sidecar",
        variant: "base",
        http: {
          url: data.local.url,
          username: data.local.username ?? undefined,
          password: data.local.password ?? undefined,
        },
      })
    }
    const wsl = wslServers()
    if (wsl) {
      for (const item of wsl.servers) {
        const runtime = item.runtime
        const http =
          runtime.kind === "ready"
            ? {
                url: runtime.url,
                username: runtime.username ?? undefined,
                password: runtime.password ?? undefined,
              }
            : {
                url: `http://wsl-${item.config.distro}.invalid`,
              }
        list.push({
          displayName: `WSL: ${item.config.distro}`,
          type: "sidecar",
          variant: "wsl",
          distro: item.config.distro,
          http,
        })
      }
    }
    return list
  }

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

  onMount(() => {
    document.addEventListener("click", handleClick)
    onCleanup(() => {
      document.removeEventListener("click", handleClick)
    })
  })

  return (
    <PlatformProvider value={platform}>
      <AppBaseProviders locale={locale.latest}>
        <Show when={!defaultServer.loading && !startup.loading && !windowCount.loading && !locale.loading}>
          {(_) => {
            if (startup.latest?.error) {
              return <LocalServerStartupError message={startup.latest.error} />
            }
            return (
              <AppInterface
                defaultServer={
                  defaultServer.latest ??
                  ServerConnection.Key.make(startup.latest?.sidecar?.local.key ?? "local:windows")
                }
                servers={servers()}
                router={MemoryRouter}
              >
                <Inner />
              </AppInterface>
            )
          }}
        </Show>
      </AppBaseProviders>
    </PlatformProvider>
  )
}, root!)
