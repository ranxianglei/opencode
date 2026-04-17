import type {
  WslDistroProbe,
  WslInstalledDistro,
  WslJob,
  WslOnlineDistro,
  WslOpencodeCheck,
  WslRuntimeCheck,
  WslServerAcknowledgements,
  WslServerConfig,
  WslServerItem,
  WslServerRuntime,
  WslServersEvent,
  WslServersState,
  WslTranscriptLine,
} from "../preload/types"
import { LEGACY_LOCAL_SERVER_KEY, WSL_SERVERS_KEY } from "./constants"
import { spawnWslSidecar } from "./server"
import { store } from "./store"
import type { WslCommandLine } from "./wsl"
import {
  installWslDistro,
  installWslOpencode,
  installWslRuntimeElevated,
  listInstalledWslDistros,
  listOnlineWslDistros,
  openWslTerminal,
  probeWslDistro,
  probeWslRuntime,
  readWslCommandVersion,
  resolveWslOpencode,
  upgradeWslOpencode,
  wslNeedsRestart,
} from "./wsl"

type RunningSidecar = {
  listener: { stop: () => void }
  url: string
  username: string | null
  password: string
}

type SpawnSidecar = (distro: string) => Promise<RunningSidecar>

export type WslServersController = ReturnType<typeof createWslServersController>

export function wslServerIdForDistro(distro: string) {
  return `wsl:${distro}`
}

export function createWslServersController(appVersion: string, spawnSidecar: SpawnSidecar) {
  let state: WslServersState = initialState()
  const listeners = new Set<(event: WslServersEvent) => void>()
  const sidecars = new Map<string, RunningSidecar>()
  let jobAbort: AbortController | undefined

  const emit = () => {
    for (const listener of listeners) listener({ type: "state", state })
  }

  const setState = (next: Partial<WslServersState>) => {
    state = { ...state, ...next }
    emit()
  }

  const appendTranscript = (line: Omit<WslTranscriptLine, "at">) => {
    setState({ transcript: [...state.transcript, { ...line, at: Date.now() }] })
  }

  const clearTranscript = () => setState({ transcript: [] })

  const persistServers = (servers: WslServerConfig[]) => {
    store.set(WSL_SERVERS_KEY, { servers })
  }

  const updateServer = (id: string, update: (item: WslServerItem) => WslServerItem) => {
    const next = state.servers.map((item) => (item.config.id === id ? update(item) : item))
    setState({ servers: next })
  }

  const beginJob = (job: WslJob, opts: { keepTranscript?: boolean } = {}): AbortController => {
    jobAbort?.abort()
    const abort = new AbortController()
    jobAbort = abort
    if (!opts.keepTranscript) clearTranscript()
    setState({ job, lastError: null })
    return abort
  }

  const endJob = (abort: AbortController, error?: Error | null) => {
    if (jobAbort !== abort) return
    jobAbort = undefined
    setState({ job: null, lastError: error?.message ?? null })
  }

  const onLine = (line: WslCommandLine) => appendTranscript(line)

  const refreshFromStore = () => {
    const persisted = readPersistedServers()
    const items: WslServerItem[] = persisted.map((config) => {
      const existing = state.servers.find((item) => item.config.id === config.id)
      return {
        config,
        runtime: existing?.runtime ?? { kind: "stopped" },
      }
    })
    setState({ servers: items })
  }

  const setRuntime = (id: string, runtime: WslServerRuntime) => {
    updateServer(id, (item) => ({ ...item, runtime }))
  }

  const startServer = async (id: string) => {
    const item = state.servers.find((x) => x.config.id === id)
    if (!item) return
    await stopServerInternal(id)
    setRuntime(id, { kind: "starting" })
    try {
      const sidecar = await spawnSidecar(item.config.distro)
      sidecars.set(id, sidecar)
      setRuntime(id, {
        kind: "ready",
        url: sidecar.url,
        username: sidecar.username,
        password: sidecar.password,
      })
    } catch (error) {
      setRuntime(id, {
        kind: "failed",
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }

  const stopServerInternal = async (id: string) => {
    const existing = sidecars.get(id)
    if (!existing) return
    try {
      existing.listener.stop()
    } catch {
      // ignore stop errors
    }
    sidecars.delete(id)
  }

  const runJob = async <T>(job: WslJob, runner: (abort: AbortController) => Promise<T>) => {
    const abort = beginJob(job)
    try {
      const value = await runner(abort)
      endJob(abort)
      return value
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        endJob(abort)
        return undefined
      }
      const err = error instanceof Error ? error : new Error(String(error))
      endJob(abort, err)
      throw err
    }
  }

  return {
    getState() {
      return state
    },
    subscribe(listener: (event: WslServersEvent) => void) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },

    async initialize() {
      refreshFromStore()
      await Promise.all(state.servers.map((item) => startServer(item.config.id)))
    },

    async probeRuntime() {
      await runJob({ kind: "runtime", startedAt: Date.now() }, async (abort) => {
        appendTranscript({ stream: "system", text: "Checking WSL runtime" })
        const runtime = await probeWslRuntime({ signal: abort.signal, onLine })
        setState({
          runtime,
          pendingRestart: state.pendingRestart && !runtime.available ? state.pendingRestart : false,
        })
      })
    },

    async refreshDistros() {
      await runJob({ kind: "distros", startedAt: Date.now() }, async (abort) => {
        appendTranscript({ stream: "system", text: "Listing WSL distros" })
        const [installedResult, onlineResult] = await Promise.allSettled([
          listInstalledWslDistros({ signal: abort.signal, onLine }),
          listOnlineWslDistros({ signal: abort.signal, onLine }),
        ])
        const installed = installedResult.status === "fulfilled" ? installedResult.value : []
        const online = onlineResult.status === "fulfilled" ? onlineResult.value : []
        setState({ installed, online })
      })
    },

    async installWsl() {
      await runJob({ kind: "install-wsl", startedAt: Date.now() }, async (abort) => {
        appendTranscript({ stream: "system", text: "Installing WSL runtime" })
        const result = await installWslRuntimeElevated({ signal: abort.signal, onLine })
        if (result.code !== 0) {
          const message = summarize(result.stderr || result.stdout) || "WSL installation failed"
          throw new Error(message)
        }
        const pendingRestart = wslNeedsRestart(result)
        setState({ pendingRestart })
        if (!pendingRestart) {
          const runtime = await probeWslRuntime({ signal: abort.signal, onLine })
          setState({ runtime })
        }
      })
    },

    async installDistro(name: string) {
      await runJob({ kind: "install-distro", distro: name, startedAt: Date.now() }, async (abort) => {
        appendTranscript({ stream: "system", text: `Installing WSL distro: ${name}` })
        const result = await installWslDistro(name, { signal: abort.signal, onLine })
        if (result.code !== 0) {
          const message = summarize(result.stderr || result.stdout) || `Failed to install distro: ${name}`
          throw new Error(message)
        }
        const [installedResult, onlineResult] = await Promise.allSettled([
          listInstalledWslDistros({ signal: abort.signal, onLine }),
          listOnlineWslDistros({ signal: abort.signal, onLine }),
        ])
        const installed = installedResult.status === "fulfilled" ? installedResult.value : []
        const online = onlineResult.status === "fulfilled" ? onlineResult.value : []
        const probe = await probeWslDistro(name, { signal: abort.signal, onLine })
        setState({
          installed,
          online,
          distroProbes: { ...state.distroProbes, [name]: probe },
        })
      })
    },

    async probeDistro(name: string) {
      await runJob({ kind: "probe-distro", distro: name, startedAt: Date.now() }, async (abort) => {
        appendTranscript({ stream: "system", text: `Checking ${name}` })
        const probe = await probeWslDistro(name, { signal: abort.signal, onLine })
        setState({ distroProbes: { ...state.distroProbes, [name]: probe } })
      })
    },

    async probeOpencode(name: string) {
      await runJob({ kind: "probe-opencode", distro: name, startedAt: Date.now() }, async (abort) => {
        appendTranscript({ stream: "system", text: `Checking OpenCode in ${name}` })
        const resolved = await resolveWslOpencode(name, { signal: abort.signal, onLine })
        const version = resolved ? await readWslCommandVersion(resolved, name, { signal: abort.signal, onLine }) : null
        setState({
          opencodeChecks: {
            ...state.opencodeChecks,
            [name]: opencodeCheck(name, resolved, version, appVersion),
          },
        })
      })
    },

    async installOpencode(name: string) {
      await runJob({ kind: "install-opencode", distro: name, startedAt: Date.now() }, async (abort) => {
        appendTranscript({ stream: "system", text: `Installing OpenCode in ${name}` })
        const resolved = await resolveWslOpencode(name, { signal: abort.signal, onLine })
        const existingVersion = resolved
          ? await readWslCommandVersion(resolved, name, { signal: abort.signal, onLine })
          : null
        const result =
          resolved && existingVersion
            ? await upgradeWslOpencode(appVersion, resolved, name, { signal: abort.signal, onLine })
            : await installWslOpencode(appVersion, name, { signal: abort.signal, onLine })
        if (result.code !== 0) {
          throw new Error(summarize(result.stderr || result.stdout) || "OpenCode installation failed")
        }
        const nextPath = await resolveWslOpencode(name, { signal: abort.signal, onLine })
        const nextVersion = nextPath
          ? await readWslCommandVersion(nextPath, name, { signal: abort.signal, onLine })
          : null
        setState({
          opencodeChecks: {
            ...state.opencodeChecks,
            [name]: opencodeCheck(name, nextPath, nextVersion, appVersion),
          },
        })
      })
    },

    async openTerminal(name: string) {
      await openWslTerminal(name)
    },

    async cancelJob() {
      jobAbort?.abort()
      jobAbort = undefined
      appendTranscript({ stream: "system", text: "Canceled" })
      setState({ job: null })
    },

    async addServer(distro: string): Promise<WslServerConfig> {
      const id = wslServerIdForDistro(distro)
      if (state.servers.some((item) => item.config.id === id)) {
        throw new Error(`${distro} is already added`)
      }
      const config: WslServerConfig = {
        id,
        distro,
        acknowledgements: { root: false, mismatch: null },
      }
      persistServers([...readPersistedServers(), config])
      setState({
        servers: [...state.servers, { config, runtime: { kind: "starting" } }],
      })
      void startServer(id)
      return config
    },

    async removeServer(id: string) {
      await stopServerInternal(id)
      const remaining = readPersistedServers().filter((item) => item.id !== id)
      persistServers(remaining)
      setState({ servers: state.servers.filter((item) => item.config.id !== id) })
    },

    startServer,

    async stopServer(id: string) {
      await stopServerInternal(id)
      setRuntime(id, { kind: "stopped" })
    },

    async updateAcknowledgements(id: string, acks: Partial<WslServerAcknowledgements>) {
      const persisted = readPersistedServers()
      const next = persisted.map((config) =>
        config.id === id ? { ...config, acknowledgements: { ...config.acknowledgements, ...acks } } : config,
      )
      persistServers(next)
      refreshFromStore()
    },

    stopAll() {
      for (const [id] of sidecars) {
        const existing = sidecars.get(id)
        try {
          existing?.listener.stop()
        } catch {
          // ignore
        }
      }
      sidecars.clear()
    },
  }
}

function initialState(): WslServersState {
  return {
    runtime: null,
    installed: [],
    online: [],
    distroProbes: {},
    opencodeChecks: {},
    pendingRestart: false,
    servers: [],
    job: null,
    transcript: [],
    lastError: null,
  }
}

function readPersistedServers(): WslServerConfig[] {
  const existing = store.get(WSL_SERVERS_KEY)
  if (existing && typeof existing === "object") {
    const record = existing as { servers?: unknown }
    const list = Array.isArray(record.servers) ? record.servers : []
    return list.flatMap(normalizePersistedServer)
  }
  const migrated = migrateLegacyLocalServer()
  if (migrated.length) store.set(WSL_SERVERS_KEY, { servers: migrated })
  return migrated
}

function migrateLegacyLocalServer(): WslServerConfig[] {
  const legacy = store.get(LEGACY_LOCAL_SERVER_KEY)
  if (!legacy || typeof legacy !== "object") return []
  const record = legacy as Record<string, unknown>
  if (record.mode !== "wsl") return []
  const distro = typeof record.distro === "string" ? record.distro : null
  if (!distro) return []
  return [
    {
      id: wslServerIdForDistro(distro),
      distro,
      acknowledgements: { root: false, mismatch: null },
    },
  ]
}

function normalizePersistedServer(value: unknown): WslServerConfig[] {
  if (!value || typeof value !== "object") return []
  const record = value as Record<string, unknown>
  const distro = typeof record.distro === "string" && record.distro.length > 0 ? record.distro : null
  if (!distro) return []
  const id = typeof record.id === "string" && record.id.length > 0 ? record.id : wslServerIdForDistro(distro)
  return [
    {
      id,
      distro,
      acknowledgements: normalizeAcks(record.acknowledgements),
    },
  ]
}

function normalizeAcks(value: unknown): WslServerAcknowledgements {
  const record = value && typeof value === "object" ? (value as Record<string, unknown>) : {}
  const mismatch =
    record.mismatch && typeof record.mismatch === "object" ? (record.mismatch as Record<string, unknown>) : null
  return {
    root: record.root === true,
    mismatch:
      mismatch && typeof mismatch.path === "string" && typeof mismatch.version === "string"
        ? { path: mismatch.path, version: mismatch.version }
        : null,
  }
}

function opencodeCheck(
  distro: string,
  resolvedPath: string | null,
  version: string | null,
  expectedVersion: string,
): WslOpencodeCheck {
  if (!resolvedPath) {
    return {
      distro,
      resolvedPath: null,
      version: null,
      expectedVersion,
      matchesDesktop: null,
      error: "opencode is not installed in this distro",
    }
  }
  if (!version) {
    return {
      distro,
      resolvedPath,
      version: null,
      expectedVersion,
      matchesDesktop: null,
      error: "opencode is installed but could not run",
    }
  }
  return {
    distro,
    resolvedPath,
    version,
    expectedVersion,
    matchesDesktop: version === expectedVersion,
    error: null,
  }
}

function summarize(value: string) {
  return value
    .split(/\r?\n/g)
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n")
}

// Re-export types used by callers
export type {
  WslInstalledDistro,
  WslOnlineDistro,
  WslRuntimeCheck,
  WslDistroProbe,
  WslOpencodeCheck,
  WslServerConfig,
  WslServerItem,
  WslServerRuntime,
  WslServersEvent,
  WslServersState,
}
