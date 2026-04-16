import { Button } from "@opencode-ai/ui/button"
import { showToast } from "@opencode-ai/ui/toast"
import { createEffect, createMemo, For, Match, onCleanup, Show, Switch } from "solid-js"
import { createStore, reconcile, unwrap } from "solid-js/store"
import { useLanguage } from "@/context/language"
import type { LocalServerConfig, LocalServerState, LocalServerStep } from "@/context/platform"
import { usePlatform } from "@/context/platform"

const STEP_ORDER: LocalServerStep[] = ["wsl", "distro", "opencode", "switch"]

export function DialogLocalServer() {
  const language = useLanguage()
  const platform = usePlatform()
  const [store, setStore] = createStore({
    state: undefined as LocalServerState | undefined,
    loading: true,
    step: undefined as LocalServerStep | undefined,
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
  const busy = createMemo(() => !!current()?.job)
  const mode = createMemo(() => current()?.config.mode ?? "windows")
  const selectedProbe = createMemo(() => current()?.checks.distro?.selected)
  const selectedInstalled = createMemo(() =>
    (current()?.checks.distro?.installed ?? []).find((item) => item.name === current()?.config.distro),
  )
  const otherDistros = createMemo(() =>
    (current()?.checks.distro?.online ?? [])
      .filter((item) => item.name !== "Debian" && item.name !== "Ubuntu-24.04")
      .slice(0, 8),
  )
  const configuredRuntime = createMemo(() => {
    const state = current()
    if (!state) return { mode: "windows" as const, distro: null as string | null }
    if (state.config.mode === "wsl" && state.config.distro) {
      return { mode: "wsl" as const, distro: state.config.distro }
    }
    return { mode: "windows" as const, distro: null as string | null }
  })
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
  const opencodeReady = createMemo(() => !!current()?.checks.opencode?.resolvedPath)
  const switchReady = createMemo(() => wslReady() && distroReady() && opencodeReady())
  const recommendedStep = createMemo<LocalServerStep>(() => {
    if (!wslReady()) return "wsl"
    if (!distroReady()) return "distro"
    if (!opencodeReady()) return "opencode"
    return "switch"
  })
  const activeStep = createMemo(() => store.step ?? current()?.job?.step ?? recommendedStep())

  createEffect(() => {
    if (mode() !== "wsl") {
      if (store.step) setStore("step", undefined)
      return
    }
    const next = current()?.job?.step ?? recommendedStep()
    if (!store.step || stepIndex(store.step) > stepIndex(next)) {
      setStore("step", next)
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

  const setMode = async (next: "windows" | "wsl") => {
    const state = current()
    if (!state || !localServer()) return
    const config = plainConfig(state.config)
    if (next === "wsl") setStore("step", "wsl")
    await run(() =>
      localServer()!.setConfig({
        ...config,
        mode: next,
        onboarding: {
          ...config.onboarding,
          complete: next === "windows",
          pendingRestart: next === "windows" ? false : config.onboarding.pendingRestart,
          step: next === "windows" ? null : (config.onboarding.step ?? "wsl"),
        },
      }),
    )
  }

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

  const steps = createMemo(() =>
    STEP_ORDER.map((step) => ({
      step,
      title: stepTitle(step),
      subtitle: stepSubtitle(step, {
        current: current(),
        selectedInstalled: selectedInstalled(),
        selectedProbe: selectedProbe(),
        wslReady: wslReady(),
        distroReady: distroReady(),
        opencodeReady: opencodeReady(),
        switchReady: switchReady(),
        needsRestart: needsRestart(),
      }),
      locked: stepIndex(step) > stepIndex(recommendedStep()),
      state: stepState(step, {
        active: activeStep(),
        current: current(),
        wslReady: wslReady(),
        distroReady: distroReady(),
        opencodeReady: opencodeReady(),
        switchReady: switchReady(),
        needsRestart: needsRestart(),
      }),
    })),
  )

  return (
    <div class="px-5 pb-5 flex flex-col gap-4">
      <Show
        when={!store.loading}
        fallback={<div class="px-1 py-6 text-14-regular text-text-weak">Loading local server...</div>}
      >
        <div class="rounded-md bg-surface-base p-4 flex flex-col gap-3">
          <div class="flex items-start justify-between gap-3">
            <div class="flex flex-col gap-1 min-w-0">
              <div class="text-14-medium text-text-strong">Local runtime</div>
              <div class="text-12-regular text-text-weak">Choose where the managed Local Server should run.</div>
            </div>
            <div class="flex gap-2 shrink-0">
              <Button
                variant={mode() === "windows" ? "primary" : "secondary"}
                size="large"
                onClick={() => void setMode("windows")}
              >
                Run on Windows
              </Button>
              <Button
                variant={mode() === "wsl" ? "primary" : "secondary"}
                size="large"
                onClick={() => void setMode("wsl")}
              >
                Run in WSL
              </Button>
            </div>
          </div>
          <div class="text-12-regular text-text-weak">
            Current runtime:{" "}
            {current()?.runtime.mode === "wsl" ? `wsl:${current()?.runtime.distro ?? "unknown"}` : "windows"}
          </div>
          <Show when={mode() !== "wsl"}>
            <div class="rounded-md border border-border-weak-base px-3 py-3 text-12-regular text-text-weak">
              Select <span class="text-text-strong">Run in WSL</span> to start the WSL setup flow.
            </div>
          </Show>
        </div>

        <Show when={mode() === "wsl"}>
          <div class="rounded-md bg-surface-base p-4 flex flex-col gap-3">
            <div class="text-14-medium text-text-strong">Setup flow</div>
            <div class="flex gap-2 overflow-x-auto pb-1">
              <For each={steps()}>
                {(item) => (
                  <button
                    type="button"
                    class="min-w-[148px] rounded-md border px-3 py-3 text-left transition-colors"
                    classList={{
                      "border-border-strong-base bg-surface-base-hover": item.state === "current",
                      "border-icon-success-base/40 bg-surface-base": item.state === "done",
                      "border-border-weak-base bg-background-base opacity-60": item.state === "locked",
                      "border-icon-warning-base/40 bg-surface-base": item.state === "warning",
                    }}
                    disabled={item.locked}
                    onClick={() => setStore("step", item.step)}
                  >
                    <div class="text-11-medium uppercase tracking-wide text-text-weaker">{stepNumber(item.step)}</div>
                    <div class="mt-1 text-13-medium text-text-strong">{item.title}</div>
                    <div class="mt-1 text-11-regular text-text-weak whitespace-pre-wrap break-words">
                      {item.subtitle}
                    </div>
                  </button>
                )}
              </For>
            </div>
          </div>

          <Switch>
            <Match when={activeStep() === "wsl"}>
              <div class="rounded-md bg-surface-base p-4 flex flex-col gap-3">
                <div class="flex items-center justify-between gap-3">
                  <div class="flex flex-col gap-1 min-w-0">
                    <div class="text-14-medium text-text-strong">Step 1: Verify WSL</div>
                    <div class="text-12-regular text-text-weak whitespace-pre-wrap break-words">
                      {current()?.checks.wsl?.error ??
                        current()?.checks.wsl?.status ??
                        current()?.checks.wsl?.version ??
                        "WSL has not been checked yet."}
                    </div>
                  </div>
                  <div class="flex gap-2 shrink-0">
                    <Button
                      variant="secondary"
                      size="large"
                      disabled={busy()}
                      onClick={() => void run(() => localServer()!.runStep("wsl"))}
                    >
                      Check WSL
                    </Button>
                    <Button
                      variant="secondary"
                      size="large"
                      disabled={busy()}
                      onClick={() => void run(() => localServer()!.installWsl())}
                    >
                      Install WSL
                    </Button>
                  </div>
                </div>
                <Show when={current()?.config.onboarding.pendingRestart}>
                  <div class="rounded-md border border-border-weak-base px-3 py-3 flex items-center justify-between gap-3">
                    <div class="text-12-regular text-text-warning-base">
                      Windows restart required to finish WSL installation.
                    </div>
                    <Button variant="secondary" size="large" onClick={() => void platform.restart()}>
                      Restart OpenCode
                    </Button>
                  </div>
                </Show>
              </div>
            </Match>

            <Match when={activeStep() === "distro"}>
              <div class="rounded-md bg-surface-base p-4 flex flex-col gap-3">
                <div class="flex items-center justify-between gap-3">
                  <div class="flex flex-col gap-1 min-w-0">
                    <div class="text-14-medium text-text-strong">Step 2: Choose a distro</div>
                    <div class="text-12-regular text-text-weak whitespace-pre-wrap break-words">
                      {current()?.checks.distro?.error ??
                        current()?.config.distro ??
                        "Pick a distro or install one below."}
                    </div>
                  </div>
                  <Button
                    variant="secondary"
                    size="large"
                    disabled={busy()}
                    onClick={() => void run(() => localServer()!.runStep("distro"))}
                  >
                    Check distros
                  </Button>
                </div>

                <div class="flex flex-wrap gap-2">
                  <Button
                    variant="secondary"
                    size="large"
                    disabled={busy()}
                    onClick={() => void run(() => localServer()!.installDistro("Debian"))}
                  >
                    Install Debian
                  </Button>
                  <Button
                    variant="secondary"
                    size="large"
                    disabled={busy()}
                    onClick={() => void run(() => localServer()!.installDistro("Ubuntu-24.04"))}
                  >
                    Install Ubuntu 24
                  </Button>
                </div>

                <Show when={otherDistros().length > 0}>
                  <div class="flex flex-col gap-2">
                    <div class="text-12-medium text-text-strong">Other distros</div>
                    <div class="flex flex-wrap gap-2">
                      <For each={otherDistros()}>
                        {(item) => (
                          <Button
                            variant="secondary"
                            size="large"
                            disabled={busy()}
                            onClick={() => void run(() => localServer()!.installDistro(item.name))}
                          >
                            {item.label}
                          </Button>
                        )}
                      </For>
                    </div>
                  </div>
                </Show>

                <div class="flex flex-col gap-2">
                  <div class="text-12-medium text-text-strong">Installed distros</div>
                  <Show
                    when={(current()?.checks.distro?.installed.length ?? 0) > 0}
                    fallback={<div class="text-12-regular text-text-weak">No distros detected yet.</div>}
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
                            {[
                              item.isDefault ? "default" : null,
                              item.state,
                              item.version ? `WSL ${item.version}` : null,
                            ]
                              .filter(Boolean)
                              .join(" · ")}
                          </div>
                        </button>
                      )}
                    </For>
                  </Show>
                </div>

                <Show when={selectedProbe()}>
                  {(probe) => (
                    <div class="rounded-md border border-border-weak-base px-3 py-3 flex flex-col gap-1">
                      <div class="text-12-medium text-text-strong">Selected distro checks</div>
                      <div class="text-12-regular text-text-weak">
                        User: {probe().username ?? "unknown"}
                        {probe().isRoot ? " · root" : ""}
                        {selectedInstalled()?.version === 1 ? " · WSL 1" : ""}
                      </div>
                      <div class="text-12-regular text-text-weak">
                        bash: {probe().hasBash ? "yes" : "no"} · curl: {probe().hasCurl ? "yes" : "no"} · exec:{" "}
                        {probe().canExecute ? "yes" : "no"}
                      </div>
                      <Show when={selectedInstalled()?.version === 1}>
                        <div class="text-12-regular text-text-warning-base">
                          WSL 2 is required. Convert this distro before continuing.
                        </div>
                      </Show>
                    </div>
                  )}
                </Show>

                <div class="flex gap-2">
                  <Button
                    variant="secondary"
                    size="large"
                    disabled={busy() || !current()?.config.distro}
                    onClick={() => void run(() => localServer()!.openTerminal())}
                  >
                    Open terminal
                  </Button>
                </div>
              </div>
            </Match>

            <Match when={activeStep() === "opencode"}>
              <div class="rounded-md bg-surface-base p-4 flex flex-col gap-3">
                <div class="flex items-center justify-between gap-3">
                  <div class="flex flex-col gap-1 min-w-0">
                    <div class="text-14-medium text-text-strong">Step 3: Install OpenCode</div>
                    <div class="text-12-regular text-text-weak whitespace-pre-wrap break-words">
                      {current()?.checks.opencode?.error ??
                        current()?.checks.opencode?.resolvedPath ??
                        "OpenCode has not been checked in this distro yet."}
                    </div>
                  </div>
                  <div class="flex gap-2 shrink-0">
                    <Button
                      variant="secondary"
                      size="large"
                      disabled={busy()}
                      onClick={() => void run(() => localServer()!.runStep("opencode"))}
                    >
                      Check OpenCode
                    </Button>
                    <Button
                      variant="secondary"
                      size="large"
                      disabled={busy()}
                      onClick={() => void run(() => localServer()!.installOpencode())}
                    >
                      Install OpenCode
                    </Button>
                  </div>
                </div>

                <Show when={current()?.checks.opencode}>
                  {(check) => (
                    <div class="rounded-md border border-border-weak-base px-3 py-3 flex flex-col gap-1">
                      <div class="text-12-regular text-text-weak">Path: {check().resolvedPath ?? "not found"}</div>
                      <div class="text-12-regular text-text-weak">
                        Version: {check().version ?? "unknown"}
                        <Show when={check().expectedVersion}>
                          {(expected) => <span>{` · desktop ${expected()}`}</span>}
                        </Show>
                      </div>
                      <Show when={check().matchesDesktop === false}>
                        <div class="text-12-regular text-text-warning-base">
                          Installed version does not match the desktop app version.
                        </div>
                      </Show>
                    </div>
                  )}
                </Show>
              </div>
            </Match>

            <Match when={activeStep() === "switch"}>
              <div class="rounded-md bg-surface-base p-4 flex flex-col gap-3">
                <div class="flex items-center justify-between gap-3">
                  <div class="flex flex-col gap-1 min-w-0">
                    <div class="text-14-medium text-text-strong">Step 4: Switch Local Server</div>
                    <div class="text-12-regular text-text-weak whitespace-pre-wrap break-words">
                      {needsRestart()
                        ? "Restart OpenCode to apply your WSL local runtime configuration."
                        : "WSL local runtime is configured and active."}
                    </div>
                  </div>
                  <Button
                    variant="secondary"
                    size="large"
                    disabled={!switchReady() || !needsRestart()}
                    onClick={() => void platform.restart()}
                  >
                    Restart OpenCode
                  </Button>
                </div>

                <div class="rounded-md border border-border-weak-base px-3 py-3 flex flex-col gap-1">
                  <div class="text-12-regular text-text-weak">
                    Configured runtime:{" "}
                    {configuredRuntime().mode === "wsl" ? `wsl:${configuredRuntime().distro ?? "unknown"}` : "windows"}
                  </div>
                  <div class="text-12-regular text-text-weak">
                    Current runtime:{" "}
                    {current()?.runtime.mode === "wsl" ? `wsl:${current()?.runtime.distro ?? "unknown"}` : "windows"}
                  </div>
                  <Show when={!switchReady()}>
                    <div class="text-12-regular text-text-warning-base">
                      Complete the earlier setup steps before switching.
                    </div>
                  </Show>
                </div>
              </div>
            </Match>
          </Switch>
        </Show>

        <Show when={(current()?.transcript.length ?? 0) > 0}>
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
  return STEP_ORDER.indexOf(step)
}

function stepNumber(step: LocalServerStep) {
  return `${stepIndex(step) + 1}`
}

function stepTitle(step: LocalServerStep) {
  if (step === "wsl") return "WSL"
  if (step === "distro") return "Distro"
  if (step === "opencode") return "OpenCode"
  return "Switch"
}

function stepSubtitle(
  step: LocalServerStep,
  state: {
    current?: LocalServerState
    selectedInstalled?: LocalServerState["checks"]["distro"] extends infer T ? any : never
    selectedProbe?: LocalServerState["checks"]["distro"] extends infer T ? any : never
    wslReady: boolean
    distroReady: boolean
    opencodeReady: boolean
    switchReady: boolean
    needsRestart: boolean
  },
) {
  if (step === "wsl") {
    if (state.wslReady) return "Ready"
    return state.current?.checks.wsl?.error ?? "Install or verify WSL"
  }
  if (step === "distro") {
    if (state.distroReady) return state.current?.config.distro ?? "Ready"
    if (state.selectedInstalled?.version === 1) return "Convert to WSL 2"
    return state.current?.checks.distro?.error ?? state.current?.config.distro ?? "Choose a distro"
  }
  if (step === "opencode") {
    if (state.opencodeReady) return state.current?.checks.opencode?.version ?? "Ready"
    return state.current?.checks.opencode?.error ?? "Install OpenCode"
  }
  if (!state.switchReady) return "Complete prior steps"
  return state.needsRestart ? "Restart to apply" : "Active"
}

function stepState(
  step: LocalServerStep,
  state: {
    active: LocalServerStep
    current?: LocalServerState
    wslReady: boolean
    distroReady: boolean
    opencodeReady: boolean
    switchReady: boolean
    needsRestart: boolean
  },
) {
  if (state.current?.job?.step === step) return "current"
  if (state.active === step) return "current"
  if (step === "wsl") return state.wslReady ? "done" : "warning"
  if (step === "distro")
    return state.distroReady ? "done" : stepIndex(step) > stepIndex(state.active) ? "locked" : "warning"
  if (step === "opencode")
    return state.opencodeReady ? "done" : stepIndex(step) > stepIndex(state.active) ? "locked" : "warning"
  if (state.switchReady && !state.needsRestart) return "done"
  if (stepIndex(step) > stepIndex(state.active)) return "locked"
  return "warning"
}
