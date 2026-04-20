import { createSimpleContext } from "@opencode-ai/ui/context"
import { type Accessor, batch, createEffect, createMemo, onCleanup, untrack } from "solid-js"
import { createStore } from "solid-js/store"
import { Persist, persisted } from "@/utils/persist"
import { isPlaceholderServerUrl, useCheckServerHealth } from "@/utils/server-health"

type StoredProject = { worktree: string; expanded: boolean }
type StoredServer = string | ServerConnection.HttpBase | ServerConnection.Http
const HEALTH_POLL_INTERVAL_MS = 10_000

export function normalizeServerUrl(input: string) {
  const trimmed = input.trim()
  if (!trimmed) return
  const withProtocol = /^https?:\/\//.test(trimmed) ? trimmed : `http://${trimmed}`
  return withProtocol.replace(/\/+$/, "")
}

export function serverName(conn?: ServerConnection.Any, ignoreDisplayName = false) {
  if (!conn) return ""
  if (conn.displayName && !ignoreDisplayName) return conn.displayName
  return conn.http.url.replace(/^https?:\/\//, "").replace(/\/+$/, "")
}

function projectsKey(key: ServerConnection.Key) {
  if (!key) return ""
  if (key === "sidecar" || key === "local:windows") return "local"
  if (isLocalHost(key)) return "local"
  return key
}

function isLocalHost(url: string) {
  const host = url.replace(/^https?:\/\//, "").split(":")[0]
  if (host === "localhost" || host === "127.0.0.1") return "local"
}

export namespace ServerConnection {
  type Base = { displayName?: string }

  export type HttpBase = {
    url: string
    username?: string
    password?: string
  }

  // Regular web connections
  export type Http = {
    type: "http"
    http: HttpBase
  } & Base

  export type Sidecar = {
    type: "sidecar"
    http: HttpBase
  } & (
    | // Regular desktop server
    { variant: "base" }
    // WSL server (windows only)
    | {
        variant: "wsl"
        distro: string
      }
  ) &
    Base

  // Remote server desktop can SSH into
  export type Ssh = {
    type: "ssh"
    host: string
    // SSH client exposes an HTTP server for the app to use as a proxy
    http: HttpBase
  } & Base

  export type Any =
    | Http
    // All these are desktop-only
    | (Sidecar | Ssh)

  export const key = (conn: Any): Key => {
    switch (conn.type) {
      case "http":
        return Key.make(conn.http.url)
      case "sidecar": {
        if (conn.variant === "wsl") return Key.make(`wsl:${conn.distro}`)
        return Key.make("local:windows")
      }
      case "ssh":
        return Key.make(`ssh:${conn.host}`)
    }
  }

  export type Key = string & { _brand: "Key" }
  export const Key = { make: (v: string) => v as Key }
}

export const { use: useServer, provider: ServerProvider } = createSimpleContext({
  name: "Server",
  init: (props: {
    defaultServer: ServerConnection.Key
    disableHealthCheck?: boolean
    serversReady?: boolean
    servers?: Array<ServerConnection.Any>
  }) => {
    const checkServerHealth = useCheckServerHealth()
    const serversReady = () => props.serversReady ?? true

    const [store, setStore, _, ready] = persisted(
      Persist.global("server", ["server.v3"]),
      createStore({
        list: [] as StoredServer[],
        projects: {} as Record<string, StoredProject[]>,
        lastProject: {} as Record<string, string>,
      }),
    )

    const url = (x: StoredServer) => (typeof x === "string" ? x : "type" in x ? x.http.url : x.url)

    const allServers = createMemo((): Array<ServerConnection.Any> => {
      const servers = [
        ...(props.servers ?? []),
        ...store.list.map((value) =>
          typeof value === "string"
            ? {
                type: "http" as const,
                http: { url: value },
              }
            : value,
        ),
      ]

      const deduped = new Map(
        servers.map((value) => {
          const conn: ServerConnection.Any = "type" in value ? value : { type: "http", http: value }
          return [ServerConnection.key(conn), conn]
        }),
      )

      return [...deduped.values()]
    })

    const [state, setState] = createStore({
      active: props.defaultServer,
      healthy: undefined as boolean | undefined,
    })

    const healthy = () => state.healthy

    function startHealthPolling(conn: ServerConnection.Any) {
      let alive = true
      let busy = false

      const run = () => {
        if (busy) return
        busy = true
        void check(conn)
          .then((next) => {
            if (!alive) return
            setState("healthy", next)
          })
          .finally(() => {
            busy = false
          })
      }

      run()
      const interval = setInterval(run, HEALTH_POLL_INTERVAL_MS)
      return () => {
        alive = false
        clearInterval(interval)
      }
    }

    function setActive(input: ServerConnection.Key) {
      if (state.active !== input) setState("active", input)
    }

    function nextActiveKey(exclude?: ServerConnection.Key) {
      const available = allServers().filter((conn) => ServerConnection.key(conn) !== exclude)
      const preferred = available.find((conn) => ServerConnection.key(conn) === props.defaultServer)
      const next = preferred ?? available[0]
      return next ? ServerConnection.key(next) : props.defaultServer
    }

    function add(input: ServerConnection.Http) {
      const url_ = normalizeServerUrl(input.http.url)
      if (!url_) return
      const conn = { ...input, http: { ...input.http, url: url_ } }
      return batch(() => {
        const existing = store.list.findIndex((x) => url(x) === url_)
        if (existing !== -1) {
          setStore("list", existing, conn)
        } else {
          setStore("list", store.list.length, conn)
        }
        setState("active", ServerConnection.key(conn))
        return conn
      })
    }

    function remove(key: ServerConnection.Key) {
      const list = store.list.filter((x) => url(x) !== key)
      batch(() => {
        setStore("list", list)
        if (state.active === key) {
          setState("active", nextActiveKey(key))
        }
      })
    }

    const check = (conn: ServerConnection.Any) =>
      checkServerHealth(conn.http).then((x) => {
        if (!x.healthy) {
          // Electron's console-message bridge only preserves the first
          // console argument, so pre-stringify everything into one string.
          console.warn(
            `[server health] unhealthy key=${ServerConnection.key(conn)} url=${conn.http.url} hasAuth=${!!(
              conn.http.username || conn.http.password
            )}`,
          )
        }
        return x.healthy
      })

    createEffect(() => {
      const key = state.active
      if (typeof window === "undefined") return
      window.__OPENCODE__ ??= {}
      window.__OPENCODE__.activeServer = key
    })

    const origin = createMemo(() => projectsKey(state.active))
    const projectsList = createMemo(() => store.projects[origin()] ?? [])
    const current: Accessor<ServerConnection.Any | undefined> = createMemo(() => {
      const list = allServers()
      const active = list.find((s) => ServerConnection.key(s) === state.active)
      if (active) return active
      if (!serversReady()) return
      return list[0]
    })
    const healthTarget = createMemo(() => {
      const conn = current()
      if (!conn) return ""
      return [ServerConnection.key(conn), conn.http.url, conn.http.username ?? "", conn.http.password ?? ""].join("\n")
    })
    const isReady = createMemo(() => ready() && !!current())

    createEffect(() => {
      healthTarget()
      const current_ = untrack(current)
      if (!current_) return

      if (props.disableHealthCheck) {
        setState("healthy", true)
        return
      }
      if (isPlaceholderServerUrl(current_.http.url)) {
        setState("healthy", false)
        return
      }
      setState("healthy", undefined)
      console.log(`[server health] start polling key=${ServerConnection.key(current_)} url=${current_.http.url}`)
      onCleanup(startHealthPolling(current_))
    })

    createEffect(() => {
      if (!serversReady()) return
      const list = allServers()
      if (!list.length) return
      if (list.some((conn) => ServerConnection.key(conn) === state.active)) return
      setState("active", nextActiveKey(state.active))
    })

    const isLocal = createMemo(() => {
      const c = current()
      return c?.type === "sidecar" || (c?.type === "http" && isLocalHost(c.http.url))
    })

    return {
      ready: isReady,
      healthy,
      isLocal,
      get key() {
        return state.active
      },
      get name() {
        return serverName(current())
      },
      get list() {
        return allServers()
      },
      get current() {
        return current()
      },
      setActive,
      add,
      remove,
      projects: {
        list: projectsList,
        open(directory: string) {
          const key = origin()
          if (!key) return
          const current = store.projects[key] ?? []
          if (current.find((x) => x.worktree === directory)) return
          setStore("projects", key, [{ worktree: directory, expanded: true }, ...current])
        },
        close(directory: string) {
          const key = origin()
          if (!key) return
          const current = store.projects[key] ?? []
          setStore(
            "projects",
            key,
            current.filter((x) => x.worktree !== directory),
          )
        },
        expand(directory: string) {
          const key = origin()
          if (!key) return
          const current = store.projects[key] ?? []
          const index = current.findIndex((x) => x.worktree === directory)
          if (index !== -1) setStore("projects", key, index, "expanded", true)
        },
        collapse(directory: string) {
          const key = origin()
          if (!key) return
          const current = store.projects[key] ?? []
          const index = current.findIndex((x) => x.worktree === directory)
          if (index !== -1) setStore("projects", key, index, "expanded", false)
        },
        move(directory: string, toIndex: number) {
          const key = origin()
          if (!key) return
          const current = store.projects[key] ?? []
          const fromIndex = current.findIndex((x) => x.worktree === directory)
          if (fromIndex === -1 || fromIndex === toIndex) return
          const result = [...current]
          const [item] = result.splice(fromIndex, 1)
          result.splice(toIndex, 0, item)
          setStore("projects", key, result)
        },
        last() {
          const key = origin()
          if (!key) return
          return store.lastProject[key]
        },
        touch(directory: string) {
          const key = origin()
          if (!key) return
          setStore("lastProject", key, directory)
        },
      },
    }
  },
})
