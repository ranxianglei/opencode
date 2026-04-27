import { createStore, produce } from "solid-js/store"
import { createSimpleContext } from "@opencode-ai/ui/context"
import { batch, createEffect, createMemo, createRoot, on, onCleanup } from "solid-js"
import { useParams } from "@solidjs/router"
import { useSDK } from "./sdk"
import { useServer } from "./server"
import type { Platform } from "./platform"
import { defaultTitle, titleNumber } from "./terminal-title"
import { Persist, persisted, removePersisted } from "@/utils/persist"

export type LocalPTY = {
  id: string
  title: string
  titleNumber: number
  rows?: number
  cols?: number
  buffer?: string
  scrollY?: number
  cursor?: number
}

const WORKSPACE_KEY = "__workspace__"
const MAX_TERMINAL_SESSIONS = 20

const debugTerminal = (phase: string, input: Record<string, unknown>) => {
  if (!import.meta.env.DEV) return
  console.log(`[terminal context] ${JSON.stringify({ phase, ...input })}`)
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function text(value: unknown) {
  return typeof value === "string" ? value : undefined
}

function num(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function numberFromTitle(title: string) {
  return titleNumber(title, MAX_TERMINAL_SESSIONS)
}

function pty(value: unknown): LocalPTY | undefined {
  if (!record(value)) return

  const id = text(value.id)
  if (!id) return

  const title = text(value.title) ?? ""
  const number = num(value.titleNumber)
  const rows = num(value.rows)
  const cols = num(value.cols)
  const buffer = text(value.buffer)
  const scrollY = num(value.scrollY)
  const cursor = num(value.cursor)

  return {
    id,
    title,
    titleNumber: number && number > 0 ? number : (numberFromTitle(title) ?? 0),
    ...(rows !== undefined ? { rows } : {}),
    ...(cols !== undefined ? { cols } : {}),
    ...(buffer !== undefined ? { buffer } : {}),
    ...(scrollY !== undefined ? { scrollY } : {}),
    ...(cursor !== undefined ? { cursor } : {}),
  }
}

export function migrateTerminalState(value: unknown) {
  if (!record(value)) return value

  const seen = new Set<string>()
  const all = (Array.isArray(value.all) ? value.all : []).flatMap((item) => {
    const next = pty(item)
    if (!next || seen.has(next.id)) return []
    seen.add(next.id)
    return [next]
  })

  const active = text(value.active)

  return {
    active: active && seen.has(active) ? active : all[0]?.id,
    all,
  }
}

export function getWorkspaceTerminalCacheKey(dir: string) {
  return `${dir}:${WORKSPACE_KEY}`
}

export function getLegacyTerminalStorageKeys(dir: string, legacySessionID?: string) {
  if (!legacySessionID) return [`${dir}/terminal.v1`]
  return [`${dir}/terminal/${legacySessionID}.v1`, `${dir}/terminal.v1`]
}

type TerminalSession = ReturnType<typeof createWorkspaceTerminalSession>

type TerminalCacheEntry = {
  value: TerminalSession
  dispose: VoidFunction
}

const caches = new Set<Map<string, TerminalCacheEntry>>()

const trimTerminal = (pty: LocalPTY) => {
  if (!pty.buffer && pty.cursor === undefined && pty.scrollY === undefined) return pty
  return {
    ...pty,
    buffer: undefined,
    cursor: undefined,
    scrollY: undefined,
  }
}

export function clearWorkspaceTerminals(dir: string, sessionIDs?: string[], platform?: Platform) {
  for (const cache of caches) {
    for (const [key, entry] of cache.entries()) {
      if (!key.startsWith(`${dir}:`) || !key.endsWith(`:${WORKSPACE_KEY}`)) continue
      entry.value.clear()
    }
  }

  void removePersisted(Persist.workspace(dir, "terminal"), platform)

  const legacy = new Set(getLegacyTerminalStorageKeys(dir))
  for (const id of sessionIDs ?? []) {
    for (const key of getLegacyTerminalStorageKeys(dir, id)) {
      legacy.add(key)
    }
  }
  for (const key of legacy) {
    void removePersisted({ key }, platform)
  }
}

function createWorkspaceTerminalSession(
  sdk: ReturnType<typeof useSDK>,
  dir: string,
  serverKey: string,
  legacySessionID?: string,
) {
  const legacy = getLegacyTerminalStorageKeys(dir, legacySessionID)
  const target = {
    ...Persist.workspace(dir, `${serverKey}:terminal`, legacy),
    migrate: migrateTerminalState,
  }

  // Scope persisted terminal state by server so switching servers behaves
  // like switching projects: a fresh session for the new server+dir pair,
  // while the other server's state stays intact until you swap back. PTY
  // ids, scrollback, and WebSocket connections are all server-scoped, so
  // cross-server persistence was showing stale output on swap.
  const [store, setStore, _, ready] = persisted(
    target,
    createStore<{
      active?: string
      all: LocalPTY[]
    }>({
      all: [],
    }),
  )

  debugTerminal("session.create", {
    dir,
    serverKey,
    storage: target.storage,
    key: target.key,
    legacySessionID: legacySessionID ?? null,
  })

  const pickNextTerminalNumber = () => {
    const existingTitleNumbers = new Set(
      store.all.flatMap((pty) => {
        const direct = Number.isFinite(pty.titleNumber) && pty.titleNumber > 0 ? pty.titleNumber : undefined
        if (direct !== undefined) return [direct]
        const parsed = numberFromTitle(pty.title)
        if (parsed === undefined) return []
        return [parsed]
      }),
    )

    return (
      Array.from({ length: existingTitleNumbers.size + 1 }, (_, index) => index + 1).find(
        (number) => !existingTitleNumbers.has(number),
      ) ?? 1
    )
  }

  const removeExited = (id: string) => {
    const all = store.all
    const index = all.findIndex((x) => x.id === id)
    if (index === -1) return
    const active = store.active === id ? (index === 0 ? all[1]?.id : all[0]?.id) : store.active
    batch(() => {
      setStore("active", active)
      setStore(
        "all",
        produce((draft) => {
          draft.splice(index, 1)
        }),
      )
    })
  }

  const unsub = sdk.event.on("pty.exited", (event: { properties: { id: string } }) => {
    removeExited(event.properties.id)
  })
  onCleanup(unsub)

  const update = (client: ReturnType<typeof useSDK>["client"], pty: Partial<LocalPTY> & { id: string }) => {
    debugTerminal("session.update", {
      dir,
      serverKey,
      id: pty.id,
      title: pty.title ?? null,
      hasBuffer: typeof pty.buffer === "string",
      bufferLength: typeof pty.buffer === "string" ? pty.buffer.length : 0,
      cursor: pty.cursor ?? null,
      scrollY: pty.scrollY ?? null,
    })
    const index = store.all.findIndex((x) => x.id === pty.id)
    const previous = index >= 0 ? store.all[index] : undefined
    if (index >= 0) {
      setStore("all", index, (item) => ({ ...item, ...pty }))
    }
    client.pty
      .update({
        ptyID: pty.id,
        title: pty.title,
        size: pty.cols && pty.rows ? { rows: pty.rows, cols: pty.cols } : undefined,
      })
      .catch((error: unknown) => {
        if (previous) {
          const currentIndex = store.all.findIndex((item) => item.id === pty.id)
          if (currentIndex >= 0) setStore("all", currentIndex, previous)
        }
        console.error(
          `Failed to update terminal ${JSON.stringify({
            ptyID: pty.id,
            title: pty.title,
            error: error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : error,
          })}`,
        )
      })
  }

  const clone = async (client: ReturnType<typeof useSDK>["client"], id: string) => {
    debugTerminal("session.clone.start", { dir, serverKey, id })
    const index = store.all.findIndex((x) => x.id === id)
    const pty = store.all[index]
    if (!pty) return
    const next = await client.pty
      .create({
        title: pty.title,
      })
      .catch((error: unknown) => {
        console.error("Failed to clone terminal", error)
        return undefined
      })
    if (!next?.data) return

    debugTerminal("session.clone.done", {
      dir,
      serverKey,
      id,
      nextID: next.data.id ?? null,
      title: next.data.title ?? pty.title,
    })

    const active = store.active === pty.id

    batch(() => {
      setStore("all", index, {
        id: next.data.id,
        title: next.data.title ?? pty.title,
        titleNumber: pty.titleNumber,
        buffer: undefined,
        cursor: undefined,
        scrollY: undefined,
        rows: undefined,
        cols: undefined,
      })
      if (active) {
        setStore("active", next.data.id)
      }
    })
  }

  return {
    ready,
    all: createMemo(() => store.all),
    active: createMemo(() => store.active),
    clear() {
      batch(() => {
        setStore("active", undefined)
        setStore("all", [])
      })
    },
    new() {
      const nextNumber = pickNextTerminalNumber()

      debugTerminal("session.new", { dir, serverKey, nextNumber })

      sdk.client.pty
        .create({ title: defaultTitle(nextNumber) })
        .then((pty: { data?: { id?: string; title?: string } }) => {
          const id = pty.data?.id
          if (!id) return
          debugTerminal("session.new.done", {
            dir,
            serverKey,
            id,
            title: pty.data?.title ?? defaultTitle(nextNumber),
          })
          const newTerminal = {
            id,
            title: pty.data?.title ?? defaultTitle(nextNumber),
            titleNumber: nextNumber,
          }
          setStore("all", store.all.length, newTerminal)
          setStore("active", id)
        })
        .catch((error: unknown) => {
          console.error("Failed to create terminal", error)
        })
    },
    update(pty: Partial<LocalPTY> & { id: string }) {
      update(sdk.client, pty)
    },
    trim(id: string) {
      const index = store.all.findIndex((x) => x.id === id)
      if (index === -1) return
      setStore("all", index, (pty) => trimTerminal(pty))
    },
    trimAll() {
      setStore("all", (all) => {
        const next = all.map(trimTerminal)
        if (next.every((pty, index) => pty === all[index])) return all
        return next
      })
    },
    async clone(id: string) {
      await clone(sdk.client, id)
    },
    bind() {
      const client = sdk.client
      debugTerminal("session.bind", {
        dir,
        serverKey,
        active: store.active ?? null,
        all: store.all.map((item) => item.id),
      })
      return {
        trim(id: string) {
          const index = store.all.findIndex((x) => x.id === id)
          if (index === -1) return
          setStore("all", index, (pty) => trimTerminal(pty))
        },
        update(pty: Partial<LocalPTY> & { id: string }) {
          update(client, pty)
        },
        async clone(id: string) {
          await clone(client, id)
        },
      }
    },
    open(id: string) {
      setStore("active", id)
    },
    next() {
      const index = store.all.findIndex((x) => x.id === store.active)
      if (index === -1) return
      const nextIndex = (index + 1) % store.all.length
      setStore("active", store.all[nextIndex]?.id)
    },
    previous() {
      const index = store.all.findIndex((x) => x.id === store.active)
      if (index === -1) return
      const prevIndex = index === 0 ? store.all.length - 1 : index - 1
      setStore("active", store.all[prevIndex]?.id)
    },
    async close(id: string) {
      const index = store.all.findIndex((f) => f.id === id)
      if (index !== -1) {
        batch(() => {
          if (store.active === id) {
            const next = index > 0 ? store.all[index - 1]?.id : store.all[1]?.id
            setStore("active", next)
          }
          setStore(
            "all",
            produce((all) => {
              all.splice(index, 1)
            }),
          )
        })
      }

      await sdk.client.pty.remove({ ptyID: id }).catch((error: unknown) => {
        console.error("Failed to close terminal", error)
      })
    },
    move(id: string, to: number) {
      const index = store.all.findIndex((f) => f.id === id)
      if (index === -1) return
      setStore(
        "all",
        produce((all) => {
          all.splice(to, 0, all.splice(index, 1)[0])
        }),
      )
    },
  }
}

export const { use: useTerminal, provider: TerminalProvider } = createSimpleContext({
  name: "Terminal",
  gate: false,
  init: () => {
    const sdk = useSDK()
    const server = useServer()
    const params = useParams()
    const cache = new Map<string, TerminalCacheEntry>()

    caches.add(cache)
    onCleanup(() => caches.delete(cache))

    const disposeAll = () => {
      const pending = Array.from(cache.values(), (entry) => entry.dispose)
      cache.clear()
      for (const dispose of pending) dispose()
    }

    onCleanup(disposeAll)

    const prune = () => {
      while (cache.size > MAX_TERMINAL_SESSIONS) {
        const first = cache.keys().next().value
        if (!first) return
        const entry = cache.get(first)
        entry?.dispose()
        cache.delete(first)
      }
    }

    const loadWorkspace = (dir: string, serverKey: string, legacySessionID?: string) => {
      const key = getWorkspaceTerminalCacheKey(dir)
      const existing = cache.get(key)
      if (existing) {
        debugTerminal("workspace.cache.hit", {
          dir,
          serverKey,
          key,
          legacySessionID: legacySessionID ?? null,
        })
        cache.delete(key)
        cache.set(key, existing)
        return existing.value
      }

      debugTerminal("workspace.cache.miss", {
        dir,
        serverKey,
        key,
        legacySessionID: legacySessionID ?? null,
      })

      const entry = createRoot((dispose) => ({
        value: createWorkspaceTerminalSession(sdk, dir, serverKey, legacySessionID),
        dispose,
      }))

      cache.set(key, entry)
      prune()
      return entry.value
    }

    const workspace = createMemo(() => {
      const key = server.key
      if (!key) return loadWorkspace(params.dir!, "", params.id)
      return loadWorkspace(params.dir!, key, params.id)
    })

    createEffect(
      on(
        () => ({ dir: params.dir, id: params.id }),
        (next, prev) => {
          const prevKey = server.key
          if (!prev?.dir || !prevKey) return
          if (next.dir === prev.dir && next.id === prev.id) return
          if (next.dir === prev.dir && next.id) return
          loadWorkspace(prev.dir, prevKey, prev.id).trimAll()
        },
        { defer: true },
      ),
    )

    return {
      ready: () => workspace().ready(),
      all: () => workspace().all(),
      active: () => workspace().active(),
      new: () => workspace().new(),
      update: (pty: Partial<LocalPTY> & { id: string }) => workspace().update(pty),
      trim: (id: string) => workspace().trim(id),
      trimAll: () => workspace().trimAll(),
      clone: (id: string) => workspace().clone(id),
      bind: () => workspace().bind(),
      open: (id: string) => workspace().open(id),
      close: (id: string) => workspace().close(id),
      move: (id: string, to: number) => workspace().move(id, to),
      next: () => workspace().next(),
      previous: () => workspace().previous(),
    }
  },
})
