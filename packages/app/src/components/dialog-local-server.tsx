import { Button } from "@opencode-ai/ui/button"
import { showToast } from "@opencode-ai/ui/toast"
import { createEffect, createMemo, For, Match, onCleanup, Show, Switch } from "solid-js"
import { createStore, reconcile, unwrap } from "solid-js/store"
import { useLanguage } from "@/context/language"
import type { LocalServerConfig, LocalServerState, LocalServerStep } from "@/context/platform"
import { usePlatform } from "@/context/platform"

const WSL_STEPS: LocalServerStep[] = ["wsl", "distro", "opencode", "switch"]

export function DialogLocalServer(props: { targetMode?: "windows" | "wsl" }) {
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
  const targetMode = createMemo<"windows" | "wsl">(
    () => props.targetMode ?? (current()?.config.mode === "wsl" ? "wsl" : "wsl"),
  )
  const busy = createMemo(() => !!current()?.job)
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
    if (targetMode() === "windows") return "switch"
    if (!wslReady()) return "wsl"
    if (!distroReady()) return "distro"
    if (!opencodeReady()) return "opencode"
    return "switch"
  })
  const activeStep = createMemo(() => store.step ?? current()?.job?.step ?? recommendedStep())

  createEffect(() => {
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
                <div class="text-14-medium text-text-strong">Verify WSL</div>
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
              <div class="text-12-regular text-text-weak whitespace-pre-wrap break-words">
                {current()?.checks.wsl?.error ??
                  current()?.checks.wsl?.status ??
                  current()?.checks.wsl?.version ??
                  "WSL has not been checked yet."}
              </div>
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
              <div class="flex items-center justify-between gap-3">
                <div class="text-14-medium text-text-strong">Choose a distro</div>
                <Button
                  variant="secondary"
                  size="large"
                  disabled={busy()}
                  onClick={() => void run(() => localServer()!.runStep("distro"))}
                >
                  Check distros
                </Button>
              </div>
              <div class="text-12-regular text-text-weak whitespace-pre-wrap break-words">
                {current()?.checks.distro?.error ?? current()?.config.distro ?? "Pick a distro or install one below."}
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
              </Show>

              <div class="flex flex-col gap-2">
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
                          {[item.isDefault ? "default" : null, item.state, item.version ? `WSL ${item.version}` : null]
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
                      <div class="text-12-regular text-text-warning-base">WSL 2 is required.</div>
                    </Show>
                  </div>
                )}
              </Show>

              <Button
                variant="secondary"
                size="large"
                disabled={busy() || !current()?.config.distro}
                onClick={() => void run(() => localServer()!.openTerminal())}
              >
                Open terminal
              </Button>
            </div>
          </Match>

          <Match when={activeStep() === "opencode"}>
            <div class="rounded-md bg-surface-base p-4 flex flex-col gap-3">
              <div class="flex items-center justify-between gap-3">
                <div class="text-14-medium text-text-strong">Install OpenCode</div>
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
              <div class="text-12-regular text-text-weak whitespace-pre-wrap break-words">
                {current()?.checks.opencode?.error ??
                  current()?.checks.opencode?.resolvedPath ??
                  "OpenCode has not been checked in this distro yet."}
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
                <div class="text-14-medium text-text-strong">
                  {targetMode() === "windows" ? "Swap to Windows" : "Switch Local Server"}
                </div>
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
                  ? configuredRuntime().mode === "windows"
                    ? "Restart OpenCode to finish switching back to Windows."
                    : "Switch the Local Server target back to Windows."
                  : needsRestart()
                    ? "Restart OpenCode to finish switching to WSL."
                    : "WSL Local Server is active."}
              </div>

              <div class="rounded-md border border-border-weak-base px-3 py-3 flex flex-col gap-1">
                <div class="text-12-regular text-text-weak">
                  Configured:{" "}
                  {configuredRuntime().mode === "wsl" ? `wsl:${configuredRuntime().distro ?? "unknown"}` : "windows"}
                </div>
                <div class="text-12-regular text-text-weak">
                  Current:{" "}
                  {current()?.runtime.mode === "wsl" ? `wsl:${current()?.runtime.distro ?? "unknown"}` : "windows"}
                </div>
                <Show when={targetMode() === "wsl" && !switchReady()}>
                  <div class="text-12-regular text-text-warning-base">Complete the earlier steps first.</div>
                </Show>
              </div>
            </div>
          </Match>
        </Switch>

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
  return WSL_STEPS.indexOf(step)
}

function stepTitle(step: LocalServerStep) {
  if (step === "wsl") return "Verify WSL"
  if (step === "distro") return "Choose distro"
  if (step === "opencode") return "Install OpenCode"
  return "Switch"
}

function stepState(
  step: LocalServerStep,
  state: {
    active: LocalServerStep
    wslReady: boolean
    distroReady: boolean
    opencodeReady: boolean
    switchReady: boolean
    needsRestart: boolean
  },
) {
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
