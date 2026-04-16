import { Button } from "@opencode-ai/ui/button"
import { Spinner } from "@opencode-ai/ui/spinner"
import { showToast } from "@opencode-ai/ui/toast"
import { createEffect, createMemo, For, Match, on, onCleanup, Show, Switch } from "solid-js"
import { createStore, reconcile, unwrap } from "solid-js/store"
import { useLanguage } from "@/context/language"
import type { LocalServerConfig, LocalServerMode, LocalServerState, LocalServerStep } from "@/context/platform"
import { usePlatform } from "@/context/platform"

const WSL_STEPS: LocalServerStep[] = ["wsl", "distro", "opencode", "switch"]

export function DialogLocalServer(props: { targetMode?: "windows" | "wsl" }) {
  const language = useLanguage()
  const platform = usePlatform()
  const [store, setStore] = createStore({
    state: undefined as LocalServerState | undefined,
    loading: true,
    step: undefined as LocalServerStep | undefined,
    installTarget: undefined as string | undefined,
  })

  createEffect(() => {
    const localServer = platform.localServer
    if (!localServer) return
    let mounted = true
    void localServer
      .getState()
      .then((state) => {
        if (!mounted) return
        setStore({ state, loading: false })
      })
      .catch((err) => {
        if (!mounted) return
        requestError(language, err)
        setStore("loading", false)
      })
    const off = localServer.subscribe((event) => {
      setStore("state", reconcile(event.state))
      setStore("loading", false)
    })
    onCleanup(() => {
      mounted = false
      off()
    })
  })

  const current = () => store.state
  const localServer = () => platform.localServer
  const targetMode = createMemo<"windows" | "wsl">(
    () => props.targetMode ?? (current()?.config.mode === "wsl" ? "wsl" : "wsl"),
  )
  const configuredDistro = createMemo(() => current()?.config.distro ?? null)
  const busy = createMemo(() => !!current()?.job)
  const selectedProbe = createMemo(() => {
    const probe = current()?.checks.distro?.selected
    return probe?.name === configuredDistro() ? probe : null
  })
  const selectedInstalled = createMemo(() =>
    (current()?.checks.distro?.installed ?? []).find((item) => item.name === current()?.config.distro),
  )
  const defaultInstalledDistro = createMemo(
    () => (current()?.checks.distro?.installed ?? []).find((item) => item.isDefault) ?? null,
  )
  const opencodeCheck = createMemo(() => {
    const check = current()?.checks.opencode
    return check?.distro === configuredDistro() ? check : null
  })
  const distroWarningProbe = createMemo(() => {
    const probe = selectedProbe()
    if (!probe) return null
    if (distroReady() && !probe.isRoot) return null
    return probe
  })
  const distroUnavailableMessage = createMemo(() => {
    const probe = distroWarningProbe()
    const distro = configuredDistro()
    if (!probe || probe.canExecute || !distro) return null
    if (!selectedInstalled()) return `${distro} is not installed yet.`
    return `Open ${distro} once to finish setup.`
  })
  const distroMissingTools = createMemo(() => {
    const probe = distroWarningProbe()
    if (!probe?.canExecute) return null
    if (probe.hasBash && probe.hasCurl) return null
    return probe
  })
  const opencodeMismatchCheck = createMemo(() => {
    const check = opencodeCheck()
    return check?.matchesDesktop === false ? check : null
  })
  const installableDistros = createMemo(() => {
    const online = current()?.checks.distro?.online ?? []
    const installed = new Set((current()?.checks.distro?.installed ?? []).map((item) => item.name))
    const hasVersionedUbuntu = online.some((item) => /^Ubuntu-\d/.test(item.name))
    return online
      .filter((item) => !installed.has(item.name))
      .filter((item) => !(item.name === "Ubuntu" && hasVersionedUbuntu))
  })
  const installTarget = createMemo(() => installableDistros().find((item) => item.name === store.installTarget) ?? null)
  const configuredRuntime = createMemo(() => {
    const state = current()
    if (!state) return { mode: "windows" as const, distro: null as string | null }
    if (state.config.mode === "wsl" && state.config.distro) {
      return { mode: "wsl" as const, distro: state.config.distro }
    }
    return { mode: "windows" as const, distro: null as string | null }
  })
  const configuredRuntimeLabel = createMemo(() => runtimeLabel(configuredRuntime().mode, configuredRuntime().distro))
  const currentRuntimeLabel = createMemo(() =>
    runtimeLabel(current()?.runtime.mode ?? "windows", current()?.runtime.distro ?? null),
  )
  const needsRestart = createMemo(() => {
    const state = current()
    if (!state) return false
    return state.runtime.mode !== configuredRuntime().mode || state.runtime.distro !== configuredRuntime().distro
  })
  const wslReady = createMemo(() => !!current()?.checks.wsl?.available && !current()?.config.onboarding.pendingRestart)
  const distroReady = createMemo(() => {
    const probe = selectedProbe()
    if (!probe || !current()?.config.distro) return false
    if (selectedInstalled()?.version === 1) return false
    return probe.canExecute && probe.hasBash && probe.hasCurl
  })
  const opencodeReady = createMemo(() => {
    const check = opencodeCheck()
    return !!check?.resolvedPath && !check.error
  })
  const switchReady = createMemo(() => wslReady() && distroReady() && opencodeReady())
  const recommendedStep = createMemo<LocalServerStep>(() => {
    if (targetMode() === "windows") return "switch"
    if (!wslReady()) return "wsl"
    if (!distroReady()) return "distro"
    if (!opencodeReady()) return "opencode"
    return "switch"
  })
  const activeStep = createMemo(() => current()?.job?.step ?? store.step ?? recommendedStep())

  createEffect(
    on(recommendedStep, (next) => {
      setStore("step", next)
    }),
  )

  const autoProbe = createMemo(() => {
    const state = current()
    if (!state || !localServer() || busy() || targetMode() === "windows") return null
    if (state.config.onboarding.pendingRestart) return null
    if (!state.checks.wsl) return { key: "wsl", step: "wsl" as const }
    if (!wslReady()) return null
    if (!state.checks.distro) return { key: "distro:list", step: "distro" as const }
    if (state.config.distro && !selectedProbe()) {
      return { key: `distro:${state.config.distro}`, step: "distro" as const }
    }
    if (!state.config.distro || !distroReady()) return null
    if (!opencodeCheck()) {
      return { key: `opencode:${state.config.distro}`, step: "opencode" as const }
    }
    return null
  })

  let lastAutoProbe: string | null = null
  createEffect(() => {
    const probe = autoProbe()
    if (!probe || probe.key === lastAutoProbe) return
    lastAutoProbe = probe.key
    void run(() => localServer()!.runStep(probe.step))
  })

  createEffect(() => {
    const state = current()
    const distro = defaultInstalledDistro()
    if (!state || !distro || !localServer() || busy() || targetMode() !== "wsl") return
    if (state.config.distro) return
    void selectDistro(distro.name)
  })

  createEffect(() => {
    const distros = installableDistros()
    if (!distros.length) {
      if (store.installTarget) setStore("installTarget", undefined)
      return
    }
    if (store.installTarget && distros.some((item) => item.name === store.installTarget)) return
    setStore("installTarget", distros[0]!.name)
  })

  const wslMessage = createMemo(() => {
    const state = current()
    if (!state || state.job?.step === "wsl") return "Checking WSL..."
    if (state.config.onboarding.pendingRestart) return "Windows needs a restart to finish installing WSL."
    if (state.checks.wsl?.available) return state.checks.wsl.version ?? "WSL is ready."
    return state.checks.wsl?.error ?? "WSL is required to continue."
  })

  const distroMessage = createMemo(() => {
    const state = current()
    if (!state) return "Checking distros..."
    if (state.job?.step === "distro") {
      if (state.config.distro && !selectedInstalled()) return `Installing ${state.config.distro}...`
      return state.config.distro ? `Checking ${state.config.distro}...` : "Checking distros..."
    }
    if (distroUnavailableMessage()) return distroUnavailableMessage()!
    if (state.checks.distro?.error && !selectedProbe()) return state.checks.distro.error
    if (selectedProbe() && distroReady()) return `${selectedProbe()!.name} is ready.`
    if (state.config.distro) return `Finishing setup for ${state.config.distro}.`
    return "Pick a distro or install one below."
  })

  const opencodeMessage = createMemo(() => {
    const state = current()
    if (!state) return "Checking OpenCode..."
    if (state.job?.step === "opencode") {
      return state.config.distro ? `Checking OpenCode in ${state.config.distro}...` : "Checking OpenCode..."
    }
    if (opencodeCheck()?.error) return opencodeCheck()!.error
    if (opencodeCheck()?.matchesDesktop === false) {
      return state.config.distro ? `Update OpenCode in ${state.config.distro}.` : "Update OpenCode."
    }
    if (opencodeReady())
      return state.config.distro ? `OpenCode is ready in ${state.config.distro}.` : "OpenCode is ready."
    return state.config.distro ? `Install OpenCode in ${state.config.distro}.` : "Choose a distro first."
  })
  const installProgress = createMemo(() => {
    const state = current()
    if (!state?.job || state.status.kind !== "running") return null
    const transcript = state.transcript.filter((line) => line.text.trim())
    const title = transcript[0]?.text
    if (!title?.startsWith("Installing ")) return null
    return {
      title,
      lines: transcript.slice(1).slice(-8),
    }
  })

  const run = async (action: () => Promise<void>) => {
    try {
      await action()
    } catch (err) {
      requestError(language, err)
    }
  }

  const plainConfig = (config: LocalServerConfig): LocalServerConfig => structuredClone(unwrap(config))

  const selectDistro = async (name: string) => {
    const state = current()
    if (!state || !localServer()) return
    const config = plainConfig(state.config)
    setStore("step", "distro")
    await run(() =>
      localServer()!.setConfig({
        ...config,
        mode: "wsl",
        distro: name,
        onboarding: {
          ...config.onboarding,
          complete: false,
          step: "distro",
        },
      }),
    )
  }

  const swapToWindows = async () => {
    const state = current()
    if (!state || !localServer()) return
    const config = plainConfig(state.config)
    await run(() =>
      localServer()!.setConfig({
        ...config,
        mode: "windows",
        distro: null,
        onboarding: {
          ...config.onboarding,
          complete: true,
          pendingRestart: false,
          step: null,
        },
      }),
    )
  }

  const steps = createMemo(() =>
    WSL_STEPS.filter((step) => targetMode() === "wsl" || step === "switch").map((step) => ({
      step,
      title: stepTitle(step),
      state: stepState(step, {
        active: activeStep(),
        wslReady: wslReady(),
        distroReady: distroReady(),
        opencodeReady: opencodeReady(),
        opencodeMismatch: opencodeCheck()?.matchesDesktop === false,
        switchReady: switchReady(),
        needsRestart: needsRestart(),
      }),
      locked: stepIndex(step) > stepIndex(recommendedStep()),
    })),
  )

  return (
    <div class="px-5 pb-5 flex flex-col gap-4">
      <Show
        when={!store.loading}
        fallback={<div class="px-1 py-6 text-14-regular text-text-weak">Loading local server...</div>}
      >
        <Show when={targetMode() === "wsl"}>
          <div class="flex gap-2 overflow-x-auto pb-1">
            <For each={steps()}>
              {(item) => (
                <button
                  type="button"
                  class="min-w-[132px] rounded-md border px-3 py-2 text-left transition-colors"
                  classList={{
                    "border-border-strong-base bg-surface-base-hover": item.state === "current",
                    "border-icon-success-base/40 bg-surface-base": item.state === "done",
                    "border-border-weak-base bg-background-base opacity-60": item.state === "locked",
                    "border-icon-warning-base/40 bg-surface-base": item.state === "warning",
                  }}
                  disabled={item.locked}
                  onClick={() => setStore("step", item.step)}
                >
                  <div class="text-13-medium text-text-strong">{item.title}</div>
                </button>
              )}
            </For>
          </div>
        </Show>

        <Switch>
          <Match when={activeStep() === "wsl"}>
            <div class="rounded-md bg-surface-base p-4 flex flex-col gap-3">
              <div class="flex items-center justify-between gap-3">
                <div class="text-14-medium text-text-strong">WSL</div>
                <Show when={current()?.checks.wsl && !wslReady() && !current()?.config.onboarding.pendingRestart}>
                  <Button
                    variant="secondary"
                    size="large"
                    disabled={busy()}
                    onClick={() => void run(() => localServer()!.installWsl())}
                  >
                    Install WSL
                  </Button>
                </Show>
              </div>
              <div class="text-12-regular text-text-weak whitespace-pre-wrap break-words">{wslMessage()}</div>
              <Show when={current()?.config.onboarding.pendingRestart}>
                <div class="rounded-md border border-border-weak-base px-3 py-3 flex items-center justify-between gap-3">
                  <div class="text-12-regular text-text-warning-base">Windows restart required.</div>
                  <Button variant="secondary" size="large" onClick={() => void platform.restart()}>
                    Restart OpenCode
                  </Button>
                </div>
              </Show>
            </div>
          </Match>

          <Match when={activeStep() === "distro"}>
            <div class="rounded-md bg-surface-base p-4 flex flex-col gap-3">
              <div class="text-14-medium text-text-strong">Choose a distro</div>
              <div class="text-12-regular text-text-weak whitespace-pre-wrap break-words">{distroMessage()}</div>

              <div class="flex flex-col gap-2">
                <Show
                  when={(current()?.checks.distro?.installed.length ?? 0) > 0}
                  fallback={
                    <div class="text-12-regular text-text-weak">
                      {current()?.checks.distro ? "No distros detected yet." : "Checking distros..."}
                    </div>
                  }
                >
                  <For each={current()?.checks.distro?.installed ?? []}>
                    {(item) => (
                      <button
                        type="button"
                        class="rounded-md border border-border-weak-base px-3 py-2 text-left transition-colors"
                        classList={{ "bg-surface-raised-base": current()?.config.distro === item.name }}
                        onClick={() => void selectDistro(item.name)}
                      >
                        <div class="text-13-medium text-text-strong">{item.name}</div>
                        <div class="text-12-regular text-text-weak">
                          {[item.isDefault ? "default" : null, item.state, item.version ? `WSL ${item.version}` : null]
                            .filter(Boolean)
                            .join(" · ")}
                        </div>
                      </button>
                    )}
                  </For>
                </Show>
              </div>

              <Show when={installableDistros().length > 0}>
                <div class="rounded-md border border-border-weak-base p-2 flex flex-col gap-2">
                  <div class="px-1 flex items-center justify-between gap-3">
                    <div class="text-12-medium text-text-weak">Install</div>
                    <Button
                      variant="secondary"
                      size="small"
                      disabled={busy() || !installTarget()}
                      onClick={() => void run(() => localServer()!.installDistro(installTarget()!.name))}
                    >
                      Install
                    </Button>
                  </div>
                  <div
                    role="radiogroup"
                    aria-label="Install distro"
                    class="max-h-44 overflow-y-auto rounded-md bg-background-base"
                  >
                    <For each={installableDistros()}>
                      {(item) => {
                        const selected = () => store.installTarget === item.name
                        return (
                          <button
                            type="button"
                            role="radio"
                            aria-checked={selected()}
                            disabled={busy()}
                            class="w-full px-3 py-2 flex items-start gap-3 text-left border-b border-border-weak-base last:border-b-0 transition-colors"
                            classList={{
                              "bg-surface-raised-base": selected(),
                              "hover:bg-surface-base": !selected(),
                            }}
                            onClick={() => setStore("installTarget", item.name)}
                          >
                            <div
                              class="mt-0.5 h-4 w-4 rounded-full border border-border-strong-base flex items-center justify-center shrink-0"
                              classList={{ "border-text-strong": selected() }}
                            >
                              <div class="h-2 w-2 rounded-full bg-text-strong" classList={{ hidden: !selected() }} />
                            </div>
                            <div class="min-w-0 flex-1">
                              <div class="text-13-medium text-text-strong break-words">{item.label}</div>
                              <Show when={item.label !== item.name}>
                                <div class="text-12-regular text-text-weak break-words">{item.name}</div>
                              </Show>
                            </div>
                          </button>
                        )
                      }}
                    </For>
                  </div>
                </div>
              </Show>

              <Show
                when={
                  selectedInstalled()?.version === 1 ||
                  distroUnavailableMessage() ||
                  distroMissingTools() ||
                  distroWarningProbe()?.isRoot
                }
              >
                <div class="rounded-md border border-border-weak-base px-3 py-3 flex flex-col gap-1">
                  <Show when={selectedInstalled()?.version === 1}>
                    <div class="text-12-regular text-text-warning-base">WSL 2 is required.</div>
                  </Show>
                  <Show when={distroUnavailableMessage()}>
                    {(message) => <div class="text-12-regular text-text-warning-base">{message()}</div>}
                  </Show>
                  <Show when={distroMissingTools()}>
                    <div class="text-12-regular text-text-warning-base">This distro needs bash and curl.</div>
                  </Show>
                  <Show when={distroWarningProbe()?.isRoot}>
                    <div class="text-12-regular text-text-warning-base">
                      This distro is using the root user right now.
                    </div>
                  </Show>
                </div>
              </Show>

              <Button
                variant="secondary"
                size="large"
                disabled={busy() || !selectedInstalled()}
                onClick={() => void run(() => localServer()!.openTerminal())}
              >
                Open terminal
              </Button>
            </div>
          </Match>

          <Match when={activeStep() === "opencode"}>
            <div class="rounded-md bg-surface-base p-4 flex flex-col gap-3">
              <div class="flex items-center justify-between gap-3">
                <div class="text-14-medium text-text-strong">OpenCode</div>
                <Show when={!opencodeReady() || opencodeCheck()?.matchesDesktop === false}>
                  <Button
                    variant="secondary"
                    size="large"
                    disabled={busy()}
                    onClick={() => void run(() => localServer()!.installOpencode())}
                  >
                    {opencodeCheck()?.resolvedPath ? "Update OpenCode" : "Install OpenCode"}
                  </Button>
                </Show>
              </div>
              <div class="text-12-regular text-text-weak whitespace-pre-wrap break-words">{opencodeMessage()}</div>
              <Show when={opencodeMismatchCheck()}>
                {(check) => (
                  <div class="rounded-md border border-border-weak-base px-3 py-3 flex flex-col gap-1">
                    <div class="text-12-regular text-text-weak">Path: {check().resolvedPath ?? "not found"}</div>
                    <div class="text-12-regular text-text-weak">
                      Version: {check().version ?? "unknown"}
                      <Show when={check().expectedVersion}>
                        {(expected) => <span>{` · desktop ${expected()}`}</span>}
                      </Show>
                    </div>
                    <div class="text-12-regular text-text-warning-base">
                      Installed version does not match the desktop app version.
                    </div>
                  </div>
                )}
              </Show>
            </div>
          </Match>

          <Match when={activeStep() === "switch"}>
            <div class="rounded-md bg-surface-base p-4 flex flex-col gap-3">
              <div class="flex items-center justify-between gap-3">
                <div class="text-14-medium text-text-strong">Switch</div>
                <div class="flex gap-2 shrink-0">
                  <Show when={targetMode() === "windows" && configuredRuntime().mode !== "windows"}>
                    <Button variant="secondary" size="large" onClick={() => void swapToWindows()}>
                      Use Windows
                    </Button>
                  </Show>
                  <Button
                    variant="secondary"
                    size="large"
                    disabled={(targetMode() === "wsl" && !switchReady()) || !needsRestart()}
                    onClick={() => void platform.restart()}
                  >
                    Restart OpenCode
                  </Button>
                </div>
              </div>

              <div class="text-12-regular text-text-weak whitespace-pre-wrap break-words">
                {targetMode() === "windows"
                  ? needsRestart()
                    ? "Restart OpenCode to switch back to Windows."
                    : "Windows Local Server is active."
                  : needsRestart()
                    ? `Restart OpenCode to start using ${configuredRuntimeLabel()}.`
                    : `${configuredRuntimeLabel()} is active.`}
              </div>

              <div class="rounded-md border border-border-weak-base px-3 py-3 flex flex-col gap-1">
                <div class="text-12-regular text-text-weak">
                  After restart: <span class="text-text-strong">{configuredRuntimeLabel()}</span>
                </div>
                <div class="text-12-regular text-text-weak">
                  Using now: <span class="text-text-strong">{currentRuntimeLabel()}</span>
                </div>
                <Show when={targetMode() === "wsl" && !switchReady()}>
                  <div class="text-12-regular text-text-warning-base">Complete the earlier steps first.</div>
                </Show>
              </div>
            </div>
          </Match>
        </Switch>

        <Show when={installProgress()}>
          {(progress) => (
            <div class="rounded-md bg-surface-base p-4 flex flex-col gap-2">
              <div class="flex items-center gap-2 text-14-medium text-text-strong">
                <Spinner class="h-4 w-4 text-icon-info-base shrink-0" />
                <div>Progress</div>
              </div>
              <div class="text-12-regular text-text-weak whitespace-pre-wrap break-words">{progress().title}</div>
              <div
                data-scrollable
                class="max-h-32 overflow-y-auto rounded-md border border-border-weak-base bg-background-base px-3 py-2 font-mono text-12-regular whitespace-pre-wrap break-words"
              >
                <For
                  each={
                    progress().lines.length
                      ? progress().lines
                      : [{ stream: "system" as const, text: "Waiting for output...", at: 0 }]
                  }
                >
                  {(line) => (
                    <div
                      classList={{
                        "text-text-warning-base": line.stream === "stderr",
                        "text-text-weak": line.stream !== "stderr",
                      }}
                    >
                      {line.text}
                    </div>
                  )}
                </For>
              </div>
            </div>
          )}
        </Show>

        <Show when={current()?.status.kind === "failed" && (current()?.transcript.length ?? 0) > 0}>
          <div class="rounded-md bg-surface-base p-4 flex flex-col gap-2">
            <div class="text-14-medium text-text-strong">Diagnostics</div>
            <div class="max-h-56 overflow-y-auto rounded-md border border-border-weak-base bg-background-base px-3 py-2 font-mono text-12-regular text-text-weak whitespace-pre-wrap break-words">
              <For each={current()?.transcript ?? []}>{(line) => <div>{line.text}</div>}</For>
            </div>
          </div>
        </Show>
      </Show>
    </div>
  )
}

function requestError(language: ReturnType<typeof useLanguage>, err: unknown) {
  console.error("Local Server request failed", err instanceof Error ? (err.stack ?? err.message) : String(err))
  showToast({
    variant: "error",
    title: language.t("common.requestFailed"),
    description: err instanceof Error ? err.message : String(err),
  })
}

function stepIndex(step: LocalServerStep) {
  return WSL_STEPS.indexOf(step)
}

function stepTitle(step: LocalServerStep) {
  if (step === "wsl") return "WSL"
  if (step === "distro") return "Choose distro"
  if (step === "opencode") return "OpenCode"
  return "Switch"
}

function runtimeLabel(mode: LocalServerMode, distro: string | null) {
  if (mode === "windows") return "Windows"
  return distro ? `WSL on ${distro}` : "WSL"
}

function stepState(
  step: LocalServerStep,
  state: {
    active: LocalServerStep
    wslReady: boolean
    distroReady: boolean
    opencodeReady: boolean
    opencodeMismatch: boolean
    switchReady: boolean
    needsRestart: boolean
  },
) {
  if (state.active === step) return "current"
  if (step === "wsl") return state.wslReady ? "done" : "warning"
  if (step === "distro")
    return state.distroReady ? "done" : stepIndex(step) > stepIndex(state.active) ? "locked" : "warning"
  if (step === "opencode")
    return state.opencodeMismatch
      ? "warning"
      : state.opencodeReady
        ? "done"
        : stepIndex(step) > stepIndex(state.active)
          ? "locked"
          : "warning"
  if (state.switchReady && !state.needsRestart) return "done"
  if (stepIndex(step) > stepIndex(state.active)) return "locked"
  return "warning"
}
