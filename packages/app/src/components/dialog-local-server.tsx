import { Button } from "@opencode-ai/ui/button"
import { showToast } from "@opencode-ai/ui/toast"
import { createEffect, createMemo, For, onCleanup, Show } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { useLanguage } from "@/context/language"
import type { LocalServerState } from "@/context/platform"
import { usePlatform } from "@/context/platform"

export function DialogLocalServer() {
  const language = useLanguage()
  const platform = usePlatform()
  const [store, setStore] = createStore({
    state: undefined as LocalServerState | undefined,
    loading: true,
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
  const selected = createMemo(() => current()?.checks.distro?.selected)
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

  const run = async (action: () => Promise<void>) => {
    try {
      await action()
    } catch (err) {
      requestError(language, err)
    }
  }

  const setMode = async (next: "windows" | "wsl") => {
    const state = current()
    if (!state || !localServer()) return
    await run(() =>
      localServer()!.setConfig({
        ...state.config,
        mode: next,
        onboarding: {
          ...state.config.onboarding,
          complete: next === "windows",
          pendingRestart: next === "windows" ? false : state.config.onboarding.pendingRestart,
          step: next === "windows" ? null : state.config.onboarding.step,
        },
      }),
    )
  }

  const selectDistro = async (name: string) => {
    const state = current()
    if (!state || !localServer()) return
    await run(() =>
      localServer()!.setConfig({
        ...state.config,
        mode: "wsl",
        distro: name,
        onboarding: {
          ...state.config.onboarding,
          complete: false,
          step: "distro",
        },
      }),
    )
  }

  return (
    <div class="px-5 pb-5 flex flex-col gap-4">
      <Show
        when={!store.loading}
        fallback={<div class="px-1 py-6 text-14-regular text-text-weak">Loading local server...</div>}
      >
        <div class="rounded-md bg-surface-base p-4 flex flex-col gap-3">
          <div class="text-14-medium text-text-strong">Runtime</div>
          <div class="flex flex-wrap gap-2">
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
          <div class="text-12-regular text-text-weak">
            Current runtime:{" "}
            {current()?.runtime.mode === "wsl"
              ? `wsl${current()?.runtime.distro ? `:${current()?.runtime.distro}` : ""}`
              : "windows"}
          </div>
          <Show when={needsRestart()}>
            <div class="rounded-md border border-border-weak-base px-3 py-3 flex items-center justify-between gap-3">
              <div class="text-12-regular text-text-weak">Restart OpenCode to apply local runtime changes.</div>
              <Button variant="secondary" size="large" onClick={() => void platform.restart()}>
                Restart OpenCode
              </Button>
            </div>
          </Show>
        </div>

        <Show when={mode() === "wsl"}>
          <div class="rounded-md bg-surface-base p-4 flex flex-col gap-3">
            <div class="flex items-center justify-between gap-3">
              <div class="flex flex-col gap-1 min-w-0">
                <div class="text-14-medium text-text-strong">WSL</div>
                <div class="text-12-regular text-text-weak whitespace-pre-wrap break-words">
                  {current()?.checks.wsl?.error ??
                    current()?.checks.wsl?.status ??
                    current()?.checks.wsl?.version ??
                    "Not checked yet"}
                </div>
              </div>
              <div class="flex gap-2">
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
              <div class="text-12-regular text-text-warning-base">
                Windows restart required to finish WSL installation.
              </div>
            </Show>
          </div>

          <div class="rounded-md bg-surface-base p-4 flex flex-col gap-3">
            <div class="flex items-center justify-between gap-3">
              <div class="flex flex-col gap-1 min-w-0">
                <div class="text-14-medium text-text-strong">Distro</div>
                <div class="text-12-regular text-text-weak whitespace-pre-wrap break-words">
                  {current()?.checks.distro?.error ??
                    selected()?.name ??
                    current()?.config.distro ??
                    "No distro selected"}
                </div>
              </div>
              <div class="flex gap-2">
                <Button
                  variant="secondary"
                  size="large"
                  disabled={busy()}
                  onClick={() => void run(() => localServer()!.runStep("distro"))}
                >
                  Check distros
                </Button>
              </div>
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

            <div class="flex flex-col gap-2">
              <div class="text-12-medium text-text-strong">Installed distros</div>
              <Show
                when={(current()?.checks.distro?.installed?.length ?? 0) > 0}
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

            <Show when={selected()}>
              {(probe) => (
                <div class="rounded-md border border-border-weak-base px-3 py-3 flex flex-col gap-1">
                  <div class="text-12-medium text-text-strong">Selected distro checks</div>
                  <div class="text-12-regular text-text-weak">
                    User: {probe().username ?? "unknown"}
                    {probe().isRoot ? " · root" : ""}
                  </div>
                  <div class="text-12-regular text-text-weak">
                    bash: {probe().hasBash ? "yes" : "no"} · curl: {probe().hasCurl ? "yes" : "no"} · exec:{" "}
                    {probe().canExecute ? "yes" : "no"}
                  </div>
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

          <Show when={current()?.config.distro}>
            <div class="rounded-md bg-surface-base p-4 flex flex-col gap-3">
              <div class="flex items-center justify-between gap-3">
                <div class="flex flex-col gap-1 min-w-0">
                  <div class="text-14-medium text-text-strong">OpenCode</div>
                  <div class="text-12-regular text-text-weak whitespace-pre-wrap break-words">
                    {current()?.checks.opencode?.error ?? current()?.checks.opencode?.resolvedPath ?? "Not checked yet"}
                  </div>
                </div>
                <div class="flex gap-2">
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
          </Show>
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
  showToast({
    variant: "error",
    title: language.t("common.requestFailed"),
    description: err instanceof Error ? err.message : String(err),
  })
}
