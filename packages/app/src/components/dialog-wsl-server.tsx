import { Button } from "@opencode-ai/ui/button"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Spinner } from "@opencode-ai/ui/spinner"
import { showToast } from "@opencode-ai/ui/toast"
import { createEffect, createMemo, For, Match, onCleanup, Show, Switch } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { useLanguage } from "@/context/language"
import type { WslServerStep, WslServersState } from "@/context/platform"
import { usePlatform } from "@/context/platform"

const STEPS: WslServerStep[] = ["wsl", "distro", "opencode"]

function isHiddenDistro(name: string) {
  return /^docker-desktop(?:-data)?$/i.test(name)
}

function parseProgressPercent(text: string) {
  const match = text.match(/(\d{1,3}(?:[.,]\d+)?)\s*%/)
  if (!match) return null
  const value = Number.parseFloat(match[1]!.replace(",", "."))
  if (!Number.isFinite(value)) return null
  return Math.max(0, Math.min(99, Math.floor(value)))
}

interface DialogWslServerProps {
  onAdded?: () => void
}

export function DialogWslServer(props: DialogWslServerProps = {}) {
  const language = useLanguage()
  const platform = usePlatform()
  const dialog = useDialog()
  const [store, setStore] = createStore({
    state: undefined as WslServersState | undefined,
    loading: true,
    step: undefined as WslServerStep | undefined,
    selectedDistro: null as string | null,
    installTarget: undefined as string | undefined,
    adding: false,
  })

  createEffect(() => {
    const wslServers = platform.wslServers
    if (!wslServers) return
    let mounted = true
    void wslServers
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
    const off = wslServers.subscribe((event) => {
      setStore("state", reconcile(event.state))
      setStore("loading", false)
    })
    onCleanup(() => {
      mounted = false
      off()
    })
  })

  const current = () => store.state
  const wslServers = () => platform.wslServers
  const busy = createMemo(() => !!current()?.job || store.adding)
  const selectedDistro = () => store.selectedDistro
  const selectedProbe = createMemo(() => {
    const distro = selectedDistro()
    if (!distro) return null
    return current()?.distroProbes[distro] ?? null
  })
  const selectedInstalled = createMemo(() => {
    const distro = selectedDistro()
    if (!distro) return null
    return (current()?.installed ?? []).find((item) => item.name === distro) ?? null
  })
  const visibleInstalledDistros = createMemo(() =>
    (current()?.installed ?? []).filter((item) => !isHiddenDistro(item.name)),
  )
  const visibleOnlineDistros = createMemo(() => (current()?.online ?? []).filter((item) => !isHiddenDistro(item.name)))
  const defaultInstalledDistro = createMemo(() => visibleInstalledDistros().find((item) => item.isDefault) ?? null)
  const opencodeCheck = createMemo(() => {
    const distro = selectedDistro()
    if (!distro) return null
    return current()?.opencodeChecks[distro] ?? null
  })
  const distroWarningProbe = createMemo(() => {
    const probe = selectedProbe()
    if (!probe) return null
    if (distroReady() && !probe.isRoot) return null
    return probe
  })
  const distroUnavailableMessage = createMemo(() => {
    const probe = distroWarningProbe()
    const distro = selectedDistro()
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
  const existingServerDistros = createMemo(() => new Set((current()?.servers ?? []).map((item) => item.config.distro)))
  const addableInstalledDistros = createMemo(() => {
    return visibleInstalledDistros().filter((item) => !existingServerDistros().has(item.name))
  })
  const installableDistros = createMemo(() => {
    const online = visibleOnlineDistros()
    const installed = new Set(visibleInstalledDistros().map((item) => item.name))
    const hasVersionedUbuntu = online.some((item) => /^Ubuntu-\d/.test(item.name))
    return online
      .filter((item) => !installed.has(item.name))
      .filter((item) => !(item.name === "Ubuntu" && hasVersionedUbuntu))
  })
  const installTarget = createMemo(() => installableDistros().find((item) => item.name === store.installTarget) ?? null)
  const installingDistro = createMemo(() => current()?.job?.kind === "install-distro")
  const installDistroPercent = createMemo(() => {
    if (!installingDistro()) return null
    const transcript = current()?.transcript ?? []
    for (let i = transcript.length - 1; i >= 0; i--) {
      const percent = parseProgressPercent(transcript[i]!.text)
      if (percent !== null) return percent
    }
    return null
  })
  const wslReady = createMemo(() => !!current()?.runtime?.available && !current()?.pendingRestart)
  const distroReady = createMemo(() => {
    const probe = selectedProbe()
    if (!probe || !selectedDistro()) return false
    if (selectedInstalled()?.version === 1) return false
    return probe.canExecute && probe.hasBash && probe.hasCurl
  })
  const opencodeReady = createMemo(() => {
    const check = opencodeCheck()
    return !!check?.resolvedPath && !check.error
  })
  const allReady = createMemo(() => wslReady() && distroReady() && opencodeReady())
  const recommendedStep = createMemo<WslServerStep>(() => {
    if (!wslReady()) return "wsl"
    if (!distroReady()) return "distro"
    return "opencode"
  })
  // activeStep falls back to recommendedStep when the user hasn't picked one.
  // Once the user clicks a step tab we respect their choice rather than snapping
  // them back when a probe result updates recommendedStep.
  const activeStep = createMemo(() => store.step ?? recommendedStep())

  const autoProbe = createMemo(() => {
    const state = current()
    if (!state || !wslServers() || busy()) return null
    if (state.pendingRestart) return null
    if (!state.runtime) return { key: "runtime", run: () => wslServers()!.probeRuntime() }
    if (!wslReady()) return null
    if (!state.installed.length && !state.online.length) {
      return { key: "distros", run: () => wslServers()!.refreshDistros() }
    }
    const distro = selectedDistro()
    if (distro && !state.distroProbes[distro]) {
      return { key: `probe-distro:${distro}`, run: () => wslServers()!.probeDistro(distro) }
    }
    if (!distro || !distroReady()) return null
    if (!state.opencodeChecks[distro]) {
      return { key: `probe-opencode:${distro}`, run: () => wslServers()!.probeOpencode(distro) }
    }
    return null
  })

  let lastAutoProbe: string | null = null
  createEffect(() => {
    const probe = autoProbe()
    if (!probe || probe.key === lastAutoProbe) return
    const key = probe.key
    lastAutoProbe = key
    void (async () => {
      try {
        await probe.run()
      } catch (err) {
        // Allow the same probe to run again when reactive inputs next change
        // (e.g. user reselects a distro). Without this the user would be stuck
        // on a transient wsl.exe failure until they pick a different distro.
        if (lastAutoProbe === key) lastAutoProbe = null
        requestError(language, err)
      }
    })()
  })

  createEffect(() => {
    const state = current()
    const distro = defaultInstalledDistro()
    if (!state || !distro || busy()) return
    if (selectedDistro()) return
    if (existingServerDistros().has(distro.name)) return
    setStore("selectedDistro", distro.name)
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
    if (!state || state.job?.kind === "runtime") return "Checking WSL..."
    if (state.pendingRestart) return "Windows needs a restart to finish installing WSL."
    if (state.runtime?.available) return state.runtime.version ?? "WSL is ready."
    return state.runtime?.error ?? "WSL is required to continue."
  })

  const distroMessage = createMemo(() => {
    const state = current()
    if (!state) return "Checking distros..."
    const distro = selectedDistro()
    if (state.job?.kind === "install-distro") return `Installing ${state.job.distro}...`
    if (state.job?.kind === "probe-distro") return `Checking ${state.job.distro}...`
    if (state.job?.kind === "distros") return "Listing distros..."
    if (distroUnavailableMessage()) return distroUnavailableMessage()!
    if (selectedProbe() && distroReady()) return `${selectedProbe()!.name} is ready.`
    if (distro) return `Finishing setup for ${distro}.`
    return "Pick a distro or install one below."
  })

  const opencodeMessage = createMemo(() => {
    const state = current()
    if (!state) return "Checking OpenCode..."
    const distro = selectedDistro()
    if (state.job?.kind === "probe-opencode" || state.job?.kind === "install-opencode") {
      return distro ? `Checking OpenCode in ${distro}...` : "Checking OpenCode..."
    }
    if (opencodeCheck()?.error) return opencodeCheck()!.error
    if (opencodeCheck()?.matchesDesktop === false) {
      return distro ? `Update OpenCode in ${distro}.` : "Update OpenCode."
    }
    if (opencodeReady()) return distro ? `OpenCode is ready in ${distro}.` : "OpenCode is ready."
    return distro ? `Install OpenCode in ${distro}.` : "Choose a distro first."
  })

  const installProgress = createMemo(() => {
    const state = current()
    if (!state?.job) return null
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

  const selectDistro = (name: string) => {
    setStore("selectedDistro", name)
    setStore("step", "distro")
  }

  const finish = async () => {
    const distro = selectedDistro()
    if (!distro) return
    const api = wslServers()
    if (!api) return
    setStore("adding", true)
    try {
      await api.addServer(distro)
      props.onAdded?.()
      dialog.close()
    } catch (err) {
      requestError(language, err)
    } finally {
      setStore("adding", false)
    }
  }

  const steps = createMemo(() =>
    STEPS.map((step) => ({
      step,
      title: stepTitle(step),
      state: stepState(step, {
        active: activeStep(),
        wslReady: wslReady(),
        distroReady: distroReady(),
        opencodeReady: opencodeReady(),
        opencodeMismatch: opencodeCheck()?.matchesDesktop === false,
      }),
      locked: stepIndex(step) > stepIndex(recommendedStep()),
    })),
  )

  return (
    <div class="px-5 pb-5 flex flex-col gap-4">
      <Show when={!store.loading} fallback={<div class="px-1 py-6 text-14-regular text-text-weak">Loading...</div>}>
        <div class="flex gap-2 pb-1">
          <For each={steps()}>
            {(item) => (
              <button
                type="button"
                class="basis-0 flex-1 min-w-0 rounded-md border px-3 py-2 text-left transition-colors"
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

        <Switch>
          <Match when={activeStep() === "wsl"}>
            <div class="rounded-md bg-surface-base p-4 flex flex-col gap-3">
              <div class="flex items-center justify-between gap-3">
                <div class="text-14-medium text-text-strong">WSL</div>
                <Show when={current()?.runtime && !wslReady() && !current()?.pendingRestart}>
                  <Button
                    variant="secondary"
                    size="large"
                    disabled={busy()}
                    onClick={() => void run(() => wslServers()!.installWsl())}
                  >
                    Install WSL
                  </Button>
                </Show>
              </div>
              <div class="text-12-regular text-text-weak whitespace-pre-wrap break-words">{wslMessage()}</div>
              <Show when={current()?.pendingRestart}>
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
                  when={addableInstalledDistros().length > 0}
                  fallback={
                    <div class="text-12-regular text-text-weak">
                      {visibleInstalledDistros().length
                        ? "All installed distros are already added."
                        : current()?.runtime?.available
                          ? "No distros detected yet."
                          : "Checking distros..."}
                    </div>
                  }
                >
                  <For each={addableInstalledDistros()}>
                    {(item) => (
                      <button
                        type="button"
                        class="rounded-md border border-border-weak-base px-3 py-2 text-left transition-colors"
                        classList={{ "bg-surface-raised-base": selectedDistro() === item.name }}
                        onClick={() => selectDistro(item.name)}
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
                    <div class="flex items-center gap-2 shrink-0">
                      <Show when={installingDistro() && installDistroPercent() !== null}>
                        <span class="text-12-regular text-text-weak shrink-0 tabular-nums min-w-[3ch] text-right">
                          {installDistroPercent()}%
                        </span>
                      </Show>
                      <Show when={installingDistro()}>
                        <Spinner class="h-4 w-4 text-icon-info-base shrink-0" />
                      </Show>
                      <Button
                        variant="secondary"
                        size="small"
                        disabled={busy() || !installTarget()}
                        onClick={() => void run(() => wslServers()!.installDistro(installTarget()!.name))}
                      >
                        {installingDistro() ? "Installing..." : "Install"}
                      </Button>
                    </div>
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
                onClick={() => {
                  const distro = selectedDistro()
                  if (!distro) return
                  void run(() => wslServers()!.openTerminal(distro))
                }}
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
                    onClick={() => {
                      const distro = selectedDistro()
                      if (!distro) return
                      void run(() => wslServers()!.installOpencode(distro))
                    }}
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

        <Show when={current()?.lastError && (current()?.transcript.length ?? 0) > 0}>
          <div class="rounded-md bg-surface-base p-4 flex flex-col gap-2">
            <div class="text-14-medium text-text-strong">Diagnostics</div>
            <div class="max-h-56 overflow-y-auto rounded-md border border-border-weak-base bg-background-base px-3 py-2 font-mono text-12-regular text-text-weak whitespace-pre-wrap break-words">
              <For each={current()?.transcript ?? []}>{(line) => <div>{line.text}</div>}</For>
            </div>
          </div>
        </Show>

        <div class="flex items-center justify-end gap-2">
          <Button variant="ghost" size="large" disabled={store.adding} onClick={() => dialog.close()}>
            Cancel
          </Button>
          <Button
            variant="primary"
            size="large"
            disabled={!allReady() || !selectedDistro() || store.adding || busy()}
            onClick={() => void finish()}
          >
            {store.adding ? "Adding..." : "Add WSL server"}
          </Button>
        </div>
      </Show>
    </div>
  )
}

function requestError(language: ReturnType<typeof useLanguage>, err: unknown) {
  console.error("WSL servers request failed", err instanceof Error ? (err.stack ?? err.message) : String(err))
  showToast({
    variant: "error",
    title: language.t("common.requestFailed"),
    description: err instanceof Error ? err.message : String(err),
  })
}

function stepIndex(step: WslServerStep) {
  return STEPS.indexOf(step)
}

function stepTitle(step: WslServerStep) {
  if (step === "wsl") return "WSL"
  if (step === "distro") return "Choose distro"
  return "OpenCode"
}

function stepState(
  step: WslServerStep,
  state: {
    active: WslServerStep
    wslReady: boolean
    distroReady: boolean
    opencodeReady: boolean
    opencodeMismatch: boolean
  },
) {
  if (state.active === step) return "current"
  if (step === "wsl") return state.wslReady ? "done" : "warning"
  if (step === "distro")
    return state.distroReady ? "done" : stepIndex(step) > stepIndex(state.active) ? "locked" : "warning"
  return state.opencodeMismatch
    ? "warning"
    : state.opencodeReady
      ? "done"
      : stepIndex(step) > stepIndex(state.active)
        ? "locked"
        : "warning"
}
