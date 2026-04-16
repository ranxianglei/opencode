import type {
  LocalServerConfig,
  LocalServerDistroCheck,
  LocalServerEvent,
  LocalServerState,
  LocalServerStep,
} from "../preload/types"
import { LOCAL_SERVER_KEY } from "./constants"
import { store } from "./store"
import { listInstalledWslDistros, listOnlineWslDistros, probeWslDistro, probeWslRuntime } from "./wsl"

export function defaultLocalServerConfig(): LocalServerConfig {
  return {
    mode: "windows",
    distro: null,
    onboarding: {
      step: null,
      complete: true,
      pendingRestart: false,
    },
    acknowledgements: {
      root: [],
      mismatch: [],
    },
  }
}

export function createLocalServerController() {
  let state = toState(readLocalServerConfig())
  const listeners = new Set<(event: LocalServerEvent) => void>()
  let jobAbort: AbortController | undefined

  const emit = (event: LocalServerEvent) => {
    for (const listener of listeners) listener(event)
  }

  const update = (next: LocalServerState) => {
    state = next
    emit({ type: "state", state })
  }

  return {
    getState() {
      return state
    },
    setConfig(config: LocalServerConfig) {
      const next = normalizeLocalServerConfig(config)
      store.set(LOCAL_SERVER_KEY, next)
      update({
        ...state,
        config: next,
      })
    },
    subscribe(listener: (event: LocalServerEvent) => void) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    async runStep(step: LocalServerStep) {
      jobAbort?.abort()
      const abort = new AbortController()
      jobAbort = abort
      update({
        ...state,
        job: { step, startedAt: Date.now() },
        status: { kind: "running", step },
      })

      try {
        if (step === "wsl") {
          const wsl = await probeWslRuntime({ signal: abort.signal })
          if (jobAbort !== abort) return
          update({
            ...state,
            job: null,
            status: wsl.available
              ? { kind: "ready" }
              : { kind: "failed", step, message: wsl.error ?? "WSL is unavailable" },
            checks: {
              ...state.checks,
              wsl,
            },
          })
          return
        }

        if (step === "distro") {
          const [installedResult, onlineResult] = await Promise.allSettled([
            listInstalledWslDistros({ signal: abort.signal }),
            listOnlineWslDistros({ signal: abort.signal }),
          ])
          if (jobAbort !== abort) return

          const installed = installedResult.status === "fulfilled" ? installedResult.value : []
          const online = onlineResult.status === "fulfilled" ? onlineResult.value : []
          const selected = state.config.distro
            ? await probeWslDistro(state.config.distro, { signal: abort.signal })
            : null
          if (jobAbort !== abort) return

          const error = distroError(state.config.distro, installed, selected, installedResult, onlineResult)
          const distro: LocalServerDistroCheck = {
            installed,
            online,
            selected,
            error,
          }

          update({
            ...state,
            job: null,
            status: error ? { kind: "failed", step, message: error } : { kind: "ready" },
            checks: {
              ...state.checks,
              distro,
            },
          })
          return
        }

        update({
          ...state,
          job: null,
          status: { kind: "idle" },
        })
      } catch (error) {
        if (jobAbort !== abort) return
        if (error instanceof Error && error.name === "AbortError") {
          update({
            ...state,
            job: null,
            status: { kind: "idle" },
          })
          return
        }
        update({
          ...state,
          job: null,
          status: { kind: "failed", step, message: error instanceof Error ? error.message : String(error) },
        })
      } finally {
        if (jobAbort === abort) jobAbort = undefined
      }
    },
    cancelJob() {
      jobAbort?.abort()
      jobAbort = undefined
      update({
        ...state,
        job: null,
        status: { kind: "idle" },
      })
    },
    setRuntime(runtime: LocalServerState["runtime"]) {
      update({
        ...state,
        runtime,
      })
    },
    setStatus(status: LocalServerState["status"]) {
      update({
        ...state,
        status,
      })
    },
  }
}

function readLocalServerConfig() {
  return normalizeLocalServerConfig(store.get(LOCAL_SERVER_KEY))
}

function toState(config: LocalServerConfig, current?: LocalServerState): LocalServerState {
  return {
    config,
    runtime: current?.runtime ?? windowsRuntime(),
    status: current?.status ?? { kind: "idle" },
    job: current?.job ?? null,
    checks: current?.checks ?? { wsl: null, distro: null },
  }
}

function normalizeLocalServerConfig(value: unknown): LocalServerConfig {
  const fallback = defaultLocalServerConfig()
  if (!value || typeof value !== "object") return fallback
  const record = value as Record<string, unknown>
  const mode = record.mode === "wsl" ? "wsl" : "windows"
  const distro = typeof record.distro === "string" && record.distro.length > 0 ? record.distro : null
  return {
    mode,
    distro,
    onboarding: normalizeOnboarding(record.onboarding, mode),
    acknowledgements: normalizeAcknowledgements(record.acknowledgements),
  }
}

function normalizeOnboarding(value: unknown, mode: LocalServerConfig["mode"]): LocalServerConfig["onboarding"] {
  const record = value && typeof value === "object" ? (value as Record<string, unknown>) : {}
  return {
    step: normalizeStep(record.step),
    complete: typeof record.complete === "boolean" ? record.complete : mode === "windows",
    pendingRestart: typeof record.pendingRestart === "boolean" ? record.pendingRestart : false,
  }
}

function normalizeAcknowledgements(value: unknown): LocalServerConfig["acknowledgements"] {
  const record = value && typeof value === "object" ? (value as Record<string, unknown>) : {}
  return {
    root: Array.isArray(record.root)
      ? record.root.filter((item): item is string => typeof item === "string" && item.length > 0)
      : [],
    mismatch: Array.isArray(record.mismatch)
      ? record.mismatch.flatMap((item) => {
          if (!item || typeof item !== "object") return []
          const path = typeof item.path === "string" ? item.path : ""
          const version = typeof item.version === "string" ? item.version : ""
          if (!path || !version) return []
          return [{ path, version }]
        })
      : [],
  }
}

function normalizeStep(value: unknown): LocalServerStep | null {
  if (value === "wsl") return value
  if (value === "distro") return value
  if (value === "opencode") return value
  if (value === "switch") return value
  return null
}

function localServerKey(config: LocalServerConfig) {
  if (config.mode === "windows") return "local:windows"
  if (!config.distro) return "local:wsl"
  return `local:wsl:${config.distro}`
}

function windowsRuntime(): LocalServerState["runtime"] {
  return {
    key: localServerKey({
      ...defaultLocalServerConfig(),
      mode: "windows",
    }),
    mode: "windows",
    distro: null,
  }
}

function distroError(
  configured: string | null,
  installed: LocalServerDistroCheck["installed"],
  selected: LocalServerDistroCheck["selected"],
  installedResult: PromiseSettledResult<LocalServerDistroCheck["installed"]>,
  onlineResult: PromiseSettledResult<LocalServerDistroCheck["online"]>,
) {
  if (installedResult.status === "rejected") {
    return installedResult.reason instanceof Error ? installedResult.reason.message : String(installedResult.reason)
  }
  if (onlineResult.status === "rejected") {
    return onlineResult.reason instanceof Error ? onlineResult.reason.message : String(onlineResult.reason)
  }
  if (configured && !installed.find((item) => item.name === configured)) {
    return `Selected distro is not installed: ${configured}`
  }
  if (selected?.error) return selected.error
  return null
}
