import type { LocalServerConfig, LocalServerEvent, LocalServerState, LocalServerStep } from "../preload/types"
import { LOCAL_SERVER_KEY } from "./constants"
import { store } from "./store"

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

  const emit = (event: LocalServerEvent) => {
    for (const listener of listeners) listener(event)
  }

  return {
    getState() {
      return state
    },
    setConfig(config: LocalServerConfig) {
      const next = normalizeLocalServerConfig(config)
      store.set(LOCAL_SERVER_KEY, next)
      state = toState(next, state)
      emit({ type: "state", state })
    },
    subscribe(listener: (event: LocalServerEvent) => void) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}

function readLocalServerConfig() {
  return normalizeLocalServerConfig(store.get(LOCAL_SERVER_KEY))
}

function toState(config: LocalServerConfig, current?: LocalServerState): LocalServerState {
  return {
    config,
    runtime: {
      key: localServerKey(config),
      mode: config.mode,
      distro: config.distro,
    },
    status: current?.status ?? { kind: "idle" },
    job: current?.job ?? null,
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
