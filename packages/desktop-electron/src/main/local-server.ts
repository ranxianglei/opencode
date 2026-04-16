import type {
  LocalServerConfig,
  LocalServerDistroCheck,
  LocalServerEvent,
  LocalServerOpencodeCheck,
  LocalServerState,
  LocalServerStep,
  LocalServerTranscriptLine,
} from "../preload/types"
import { LOCAL_SERVER_KEY } from "./constants"
import { store } from "./store"
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
  resolveWslCommand,
  upgradeWslOpencode,
  wslNeedsRestart,
} from "./wsl"

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

export function createLocalServerController(appVersion: string) {
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

  const appendTranscript = (line: Omit<LocalServerTranscriptLine, "at">) => {
    update({
      ...state,
      transcript: [...state.transcript, { ...line, at: Date.now() }],
    })
  }

  const clearTranscript = () => {
    update({
      ...state,
      transcript: [],
    })
  }

  const persistConfig = (config: LocalServerConfig) => {
    const next = normalizeLocalServerConfig(config)
    store.set(LOCAL_SERVER_KEY, next)
    update({
      ...state,
      config: next,
    })
    return next
  }

  return {
    getState() {
      return state
    },
    setConfig(config: LocalServerConfig) {
      persistConfig(config)
    },
    subscribe(listener: (event: LocalServerEvent) => void) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    async runStep(step: LocalServerStep) {
      jobAbort?.abort()
      const abort = new AbortController()
      jobAbort = abort
      clearTranscript()
      appendTranscript({ stream: "system", text: `Running local server step: ${step}` })
      update({
        ...state,
        job: { step, startedAt: Date.now() },
        status: { kind: "running", step },
      })

      try {
        if (step === "wsl") {
          const wsl = await probeWslRuntime({
            signal: abort.signal,
            onLine: (line) => appendTranscript(line),
          })
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
            listInstalledWslDistros({
              signal: abort.signal,
              onLine: (line) => appendTranscript(line),
            }),
            listOnlineWslDistros({
              signal: abort.signal,
              onLine: (line) => appendTranscript(line),
            }),
          ])
          if (jobAbort !== abort) return

          const installed = installedResult.status === "fulfilled" ? installedResult.value : []
          const online = onlineResult.status === "fulfilled" ? onlineResult.value : []
          const selected = state.config.distro
            ? await probeWslDistro(state.config.distro, {
                signal: abort.signal,
                onLine: (line) => appendTranscript(line),
              })
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

        if (step === "opencode") {
          if (!state.config.distro) {
            update({
              ...state,
              job: null,
              status: { kind: "failed", step, message: "No WSL distro selected" },
            })
            return
          }

          const resolvedPath = await resolveWslCommand("opencode", state.config.distro, {
            signal: abort.signal,
            onLine: (line) => appendTranscript(line),
          })
          if (jobAbort !== abort) return
          const version = resolvedPath
            ? await readWslCommandVersion(resolvedPath, state.config.distro, {
                signal: abort.signal,
                onLine: (line) => appendTranscript(line),
              })
            : null
          if (jobAbort !== abort) return

          const opencode = opencodeCheck(resolvedPath, version, appVersion)
          update({
            ...state,
            job: null,
            status: opencode.error ? { kind: "failed", step, message: opencode.error } : { kind: "ready" },
            checks: {
              ...state.checks,
              opencode,
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
      appendTranscript({ stream: "system", text: "Canceled local server job" })
      update({
        ...state,
        job: null,
        status: { kind: "idle" },
      })
    },
    async installWsl() {
      jobAbort?.abort()
      const abort = new AbortController()
      jobAbort = abort
      clearTranscript()
      appendTranscript({ stream: "system", text: "Installing WSL runtime" })
      persistConfig({
        ...state.config,
        mode: "wsl",
        onboarding: {
          ...state.config.onboarding,
          step: "wsl",
          complete: false,
          pendingRestart: false,
        },
      })
      update({
        ...state,
        job: { step: "wsl", startedAt: Date.now() },
        status: { kind: "running", step: "wsl" },
      })

      try {
        const result = await installWslRuntimeElevated({
          signal: abort.signal,
          onLine: (line) => appendTranscript(line),
        })
        if (jobAbort !== abort) return
        if (result.code !== 0) throw new Error(commandFailure(result, "WSL installation failed"))

        const pendingRestart = wslNeedsRestart(result)
        const nextConfig = persistConfig({
          ...state.config,
          mode: "wsl",
          onboarding: {
            ...state.config.onboarding,
            step: pendingRestart ? "wsl" : "distro",
            complete: false,
            pendingRestart,
          },
        })

        if (pendingRestart) {
          const message = "Windows restart required to finish WSL installation"
          update({
            ...state,
            config: nextConfig,
            job: null,
            status: { kind: "failed", step: "wsl", message },
            checks: {
              ...state.checks,
              wsl: {
                available: false,
                version: null,
                status: null,
                error: message,
              },
            },
          })
          return
        }

        const wsl = await probeWslRuntime({
          signal: abort.signal,
          onLine: (line) => appendTranscript(line),
        })
        if (jobAbort !== abort) return
        update({
          ...state,
          config: nextConfig,
          job: null,
          status: wsl.available
            ? { kind: "ready" }
            : { kind: "failed", step: "wsl", message: wsl.error ?? "WSL is unavailable" },
          checks: {
            ...state.checks,
            wsl,
          },
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
          status: { kind: "failed", step: "wsl", message: error instanceof Error ? error.message : String(error) },
        })
      } finally {
        if (jobAbort === abort) jobAbort = undefined
      }
    },
    async installDistro(name: string) {
      jobAbort?.abort()
      const abort = new AbortController()
      jobAbort = abort
      clearTranscript()
      appendTranscript({ stream: "system", text: `Installing WSL distro: ${name}` })
      persistConfig({
        ...state.config,
        mode: "wsl",
        distro: name,
        onboarding: {
          ...state.config.onboarding,
          step: "distro",
          complete: false,
          pendingRestart: false,
        },
      })
      update({
        ...state,
        job: { step: "distro", startedAt: Date.now() },
        status: { kind: "running", step: "distro" },
      })

      try {
        const result = await installWslDistro(name, {
          signal: abort.signal,
          onLine: (line) => appendTranscript(line),
        })
        if (jobAbort !== abort) return
        if (result.code !== 0) throw new Error(commandFailure(result, `Failed to install distro: ${name}`))

        const [installedResult, onlineResult] = await Promise.allSettled([
          listInstalledWslDistros({
            signal: abort.signal,
            onLine: (line) => appendTranscript(line),
          }),
          listOnlineWslDistros({
            signal: abort.signal,
            onLine: (line) => appendTranscript(line),
          }),
        ])
        if (jobAbort !== abort) return

        const installed = installedResult.status === "fulfilled" ? installedResult.value : []
        const online = onlineResult.status === "fulfilled" ? onlineResult.value : []
        const selected = await probeWslDistro(name, {
          signal: abort.signal,
          onLine: (line) => appendTranscript(line),
        })
        if (jobAbort !== abort) return

        const error = distroError(name, installed, selected, installedResult, onlineResult)
        const nextConfig = persistConfig({
          ...state.config,
          mode: "wsl",
          distro: name,
          onboarding: {
            ...state.config.onboarding,
            step: error ? "distro" : "opencode",
            complete: false,
            pendingRestart: false,
          },
        })
        update({
          ...state,
          config: nextConfig,
          job: null,
          status: error ? { kind: "failed", step: "distro", message: error } : { kind: "ready" },
          checks: {
            ...state.checks,
            distro: {
              installed,
              online,
              selected,
              error,
            },
          },
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
          status: { kind: "failed", step: "distro", message: error instanceof Error ? error.message : String(error) },
        })
      } finally {
        if (jobAbort === abort) jobAbort = undefined
      }
    },
    async installOpencode() {
      if (!state.config.distro) throw new Error("No WSL distro selected")
      jobAbort?.abort()
      const abort = new AbortController()
      jobAbort = abort
      clearTranscript()
      appendTranscript({ stream: "system", text: `Installing OpenCode in ${state.config.distro}` })
      update({
        ...state,
        job: { step: "opencode", startedAt: Date.now() },
        status: { kind: "running", step: "opencode" },
      })

      try {
        const resolvedPath = await resolveWslCommand("opencode", state.config.distro, {
          signal: abort.signal,
          onLine: (line) => appendTranscript(line),
        })
        if (jobAbort !== abort) return

        const result = resolvedPath
          ? await upgradeWslOpencode(appVersion, state.config.distro, {
              signal: abort.signal,
              onLine: (line) => appendTranscript(line),
            })
          : await installWslOpencode(appVersion, state.config.distro, {
              signal: abort.signal,
              onLine: (line) => appendTranscript(line),
            })
        if (jobAbort !== abort) return
        if (result.code !== 0) throw new Error(commandFailure(result, "OpenCode installation failed"))

        const nextPath = await resolveWslCommand("opencode", state.config.distro, {
          signal: abort.signal,
          onLine: (line) => appendTranscript(line),
        })
        if (jobAbort !== abort) return
        const version = nextPath
          ? await readWslCommandVersion(nextPath, state.config.distro, {
              signal: abort.signal,
              onLine: (line) => appendTranscript(line),
            })
          : null
        if (jobAbort !== abort) return

        const opencode = opencodeCheck(nextPath, version, appVersion)
        update({
          ...state,
          job: null,
          status: opencode.error ? { kind: "failed", step: "opencode", message: opencode.error } : { kind: "ready" },
          checks: {
            ...state.checks,
            opencode,
          },
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
          status: { kind: "failed", step: "opencode", message: error instanceof Error ? error.message : String(error) },
        })
      } finally {
        if (jobAbort === abort) jobAbort = undefined
      }
    },
    async openTerminal() {
      if (!state.config.distro) throw new Error("No WSL distro selected")
      await openWslTerminal(state.config.distro)
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
    checks: current?.checks ?? { wsl: null, distro: null, opencode: null },
    transcript: current?.transcript ?? [],
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

function commandFailure(result: { stdout: string; stderr: string }, fallback: string) {
  const output = `${result.stderr}\n${result.stdout}`
    .split(/\r?\n/g)
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n")
  return output || fallback
}

function opencodeCheck(
  resolvedPath: string | null,
  version: string | null,
  expectedVersion: string,
): LocalServerOpencodeCheck {
  if (!resolvedPath) {
    return {
      resolvedPath: null,
      version: null,
      expectedVersion,
      matchesDesktop: null,
      error: "opencode is not installed in the selected distro",
    }
  }
  return {
    resolvedPath,
    version,
    expectedVersion,
    matchesDesktop: version ? version === expectedVersion : null,
    error: null,
  }
}
