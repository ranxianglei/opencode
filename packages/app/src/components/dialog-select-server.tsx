import { Button } from "@opencode-ai/ui/button"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Dialog } from "@opencode-ai/ui/dialog"
import { DropdownMenu } from "@opencode-ai/ui/dropdown-menu"
import { Icon } from "@opencode-ai/ui/icon"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { List } from "@opencode-ai/ui/list"
import { TextField } from "@opencode-ai/ui/text-field"
import { useMutation } from "@tanstack/solid-query"
import { showToast } from "@opencode-ai/ui/toast"
import { batch, createEffect, createMemo, createResource, onCleanup, Show, untrack } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { DialogWslServer } from "@/components/dialog-wsl-server"
import { ServerHealthIndicator, ServerRow } from "@/components/server/server-row"
import { useLanguage } from "@/context/language"
import type { WslServersState } from "@/context/platform"
import { usePlatform } from "@/context/platform"
import { normalizeServerUrl, ServerConnection, useServer } from "@/context/server"
import { isPlaceholderServerUrl, type ServerHealth, useCheckServerHealth } from "@/utils/server-health"
import { withServerSwitchOverlay } from "@/utils/server-switch"

const DEFAULT_USERNAME = "opencode"
const cachedServerStatus = new Map<ServerConnection.Key, ServerHealth>()

function versionOlderThan(current: string | null | undefined, expected: string | null | undefined) {
  if (!current || !expected) return false

  const parse = (value: string) => {
    const match = value.match(/v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/)
    if (!match) return
    return {
      major: Number(match[1]),
      minor: Number(match[2]),
      patch: Number(match[3]),
      prerelease: match[4] ?? null,
    }
  }

  const left = parse(current)
  const right = parse(expected)
  if (!left || !right) return false
  if (left.major !== right.major) return left.major < right.major
  if (left.minor !== right.minor) return left.minor < right.minor
  if (left.patch !== right.patch) return left.patch < right.patch
  return !!left.prerelease && !right.prerelease
}

interface DialogSelectServerProps {
  initialView?: "list" | "add-wsl"
  onNavigateHome?: () => void
}

interface ServerFormProps {
  value: string
  name: string
  username: string
  password: string
  placeholder: string
  busy: boolean
  error: string
  status: boolean | undefined
  onChange: (value: string) => void
  onNameChange: (value: string) => void
  onUsernameChange: (value: string) => void
  onPasswordChange: (value: string) => void
  onSubmit: () => void
  onBack: () => void
}

function showRequestError(language: ReturnType<typeof useLanguage>, err: unknown) {
  showToast({
    variant: "error",
    title: language.t("common.requestFailed"),
    description: err instanceof Error ? err.message : String(err),
  })
}

function useDefaultServer() {
  const language = useLanguage()
  const platform = usePlatform()
  const [defaultKey, defaultUrlActions] = createResource(
    async () => {
      try {
        const key = await platform.getDefaultServer?.()
        if (!key) return null
        return key
      } catch (err) {
        showRequestError(language, err)
        return null
      }
    },
    { initialValue: null },
  )

  const canDefault = createMemo(() => !!platform.getDefaultServer && !!platform.setDefaultServer)
  const setDefault = async (key: ServerConnection.Key | null) => {
    try {
      await platform.setDefaultServer?.(key)
      defaultUrlActions.mutate(key)
    } catch (err) {
      showRequestError(language, err)
    }
  }

  return { defaultKey, canDefault, setDefault }
}

function useServerPreview() {
  const checkServerHealth = useCheckServerHealth()

  const looksComplete = (value: string) => {
    const normalized = normalizeServerUrl(value)
    if (!normalized) return false
    const host = normalized.replace(/^https?:\/\//, "").split("/")[0]
    if (!host) return false
    if (host.includes("localhost") || host.startsWith("127.0.0.1")) return true
    return host.includes(".") || host.includes(":")
  }

  const previewStatus = async (
    value: string,
    username: string,
    password: string,
    setStatus: (value: boolean | undefined) => void,
  ) => {
    setStatus(undefined)
    if (!looksComplete(value)) return
    const normalized = normalizeServerUrl(value)
    if (!normalized) return
    const http: ServerConnection.HttpBase = { url: normalized }
    if (username) http.username = username
    if (password) http.password = password
    const result = await checkServerHealth(http)
    setStatus(result.healthy)
  }

  return { previewStatus }
}

function ServerForm(props: ServerFormProps) {
  const language = useLanguage()
  const keyDown = (event: KeyboardEvent) => {
    event.stopPropagation()
    if (event.key === "Escape") {
      event.preventDefault()
      props.onBack()
      return
    }
    if (event.key !== "Enter" || event.isComposing) return
    event.preventDefault()
    props.onSubmit()
  }

  return (
    <div class="px-5">
      <div class="bg-surface-base rounded-md p-5 flex flex-col gap-3">
        <div class="flex-1 min-w-0 [&_[data-slot=input-wrapper]]:relative">
          <TextField
            type="text"
            label={language.t("dialog.server.add.url")}
            placeholder={props.placeholder}
            value={props.value}
            autofocus
            validationState={props.error ? "invalid" : "valid"}
            error={props.error}
            disabled={props.busy}
            onChange={props.onChange}
            onKeyDown={keyDown}
          />
        </div>
        <TextField
          type="text"
          label={language.t("dialog.server.add.name")}
          placeholder={language.t("dialog.server.add.namePlaceholder")}
          value={props.name}
          disabled={props.busy}
          onChange={props.onNameChange}
          onKeyDown={keyDown}
        />
        <div class="grid grid-cols-2 gap-2 min-w-0">
          <TextField
            type="text"
            label={language.t("dialog.server.add.username")}
            placeholder={language.t("dialog.server.add.usernamePlaceholder")}
            value={props.username}
            disabled={props.busy}
            onChange={props.onUsernameChange}
            onKeyDown={keyDown}
          />
          <TextField
            type="password"
            label={language.t("dialog.server.add.password")}
            placeholder={language.t("dialog.server.add.passwordPlaceholder")}
            value={props.password}
            disabled={props.busy}
            onChange={props.onPasswordChange}
            onKeyDown={keyDown}
          />
        </div>
      </div>
    </div>
  )
}

export function DialogSelectServer(props: DialogSelectServerProps = {}) {
  const dialog = useDialog()
  const server = useServer()
  const platform = usePlatform()
  const language = useLanguage()
  const { defaultKey, canDefault, setDefault } = useDefaultServer()
  const { previewStatus } = useServerPreview()
  const checkServerHealth = useCheckServerHealth()
  const [store, setStore] = createStore({
    status: {} as Record<ServerConnection.Key, ServerHealth | undefined>,
    wslState: undefined as WslServersState | undefined,
    addServer: {
      url: "",
      name: "",
      username: DEFAULT_USERNAME,
      password: "",
      error: "",
      showForm: false,
      status: undefined as boolean | undefined,
    },
    addWsl: {
      showWizard: props.initialView === "add-wsl",
      pendingSelectKey: undefined as ServerConnection.Key | undefined,
    },
    editServer: {
      id: undefined as string | undefined,
      value: "",
      name: "",
      username: "",
      password: "",
      error: "",
      status: undefined as boolean | undefined,
    },
  })

  const resetAdd = () => {
    setStore("addServer", {
      url: "",
      name: "",
      username: DEFAULT_USERNAME,
      password: "",
      error: "",
      showForm: false,
      status: undefined,
    })
  }
  const resetEdit = () => {
    setStore("editServer", {
      id: undefined,
      value: "",
      name: "",
      username: "",
      password: "",
      error: "",
      status: undefined,
    })
  }

  const addMutation = useMutation(() => ({
    mutationFn: async (value: string) => {
      const normalized = normalizeServerUrl(value)
      if (!normalized) {
        resetAdd()
        return
      }

      const conn: ServerConnection.Http = {
        type: "http",
        http: { url: normalized },
      }
      if (store.addServer.name.trim()) conn.displayName = store.addServer.name.trim()
      if (store.addServer.password) conn.http.password = store.addServer.password
      if (store.addServer.password && store.addServer.username) conn.http.username = store.addServer.username
      const result = await checkServerHealth(conn.http)
      if (!result.healthy) {
        setStore("addServer", { error: language.t("dialog.server.add.error") })
        return
      }

      resetAdd()
      await select(conn, true)
    },
  }))

  const editMutation = useMutation(() => ({
    mutationFn: async (input: { original: ServerConnection.Any; value: string }) => {
      if (input.original.type !== "http") return
      const normalized = normalizeServerUrl(input.value)
      if (!normalized) {
        resetEdit()
        return
      }

      const name = store.editServer.name.trim() || undefined
      const username = store.editServer.username || undefined
      const password = store.editServer.password || undefined
      const existingName = input.original.displayName
      if (
        normalized === input.original.http.url &&
        name === existingName &&
        username === input.original.http.username &&
        password === input.original.http.password
      ) {
        resetEdit()
        return
      }

      const conn: ServerConnection.Http = {
        type: "http",
        displayName: name,
        http: { url: normalized, username, password },
      }
      const result = await checkServerHealth(conn.http)
      if (!result.healthy) {
        setStore("editServer", { error: language.t("dialog.server.add.error") })
        return
      }
      if (normalized === input.original.http.url) {
        server.add(conn)
      } else {
        replaceServer(input.original, conn)
      }

      resetEdit()
    },
  }))

  const replaceServer = (original: ServerConnection.Http, next: ServerConnection.Http) => {
    const active = server.key
    const newConn = server.add(next)
    if (!newConn) return
    const nextActive = active === ServerConnection.key(original) ? ServerConnection.key(newConn) : active
    if (nextActive) server.setActive(nextActive)
    server.remove(ServerConnection.key(original))
  }

  const items = createMemo(() => {
    const current = server.current
    const list = server.list
    if (!current) return list
    if (!list.includes(current)) return [current, ...list]
    return [current, ...list.filter((x) => x !== current)]
  })

  const current = createMemo(() => items().find((x) => ServerConnection.key(x) === server.key) ?? items()[0])
  let resolvePendingWslSelection: VoidFunction | undefined
  const healthPollKey = createMemo(() =>
    items()
      .map((conn) =>
        [ServerConnection.key(conn), conn.http.url, conn.http.username ?? "", conn.http.password ?? ""].join("\n"),
      )
      .join("\n\n"),
  )
  const health = (key: ServerConnection.Key) => store.status[key] ?? cachedServerStatus.get(key)
  const isSelectable = (conn: ServerConnection.Any) => !isPlaceholderServerUrl(conn.http.url)
  const wslRuntime = (conn: ServerConnection.Any) => {
    if (conn.type !== "sidecar" || conn.variant !== "wsl") return
    return store.wslState?.servers.find((item) => item.config.id === ServerConnection.key(conn))?.runtime
  }
  const canRetryWsl = (conn: ServerConnection.Any) => {
    const runtime = wslRuntime(conn)
    return runtime?.kind === "failed" || runtime?.kind === "stopped"
  }

  const sortedItems = createMemo(() => {
    const list = items()
    if (!list.length) return list
    const active = current()
    const order = new Map(list.map((url, index) => [url, index] as const))
    const rank = (value?: ServerHealth) => {
      if (value?.healthy === true) return 0
      if (value?.healthy === false) return 2
      return 1
    }
    return list.slice().sort((a, b) => {
      if (a === active) return -1
      if (b === active) return 1
      const diff = rank(health(ServerConnection.key(a))) - rank(health(ServerConnection.key(b)))
      if (diff !== 0) return diff
      return (order.get(a) ?? 0) - (order.get(b) ?? 0)
    })
  })

  async function refreshHealth() {
    const results: Record<ServerConnection.Key, ServerHealth> = {}
    const list = untrack(items)
    await Promise.all(
      list.map(async (conn) => {
        results[ServerConnection.key(conn)] = await checkServerHealth(conn.http)
      }),
    )
    for (const [key, value] of Object.entries(results)) {
      cachedServerStatus.set(ServerConnection.Key.make(key), value)
    }
    setStore("status", reconcile(results))
  }

  createEffect(() => {
    healthPollKey()
    void refreshHealth()
    const interval = setInterval(refreshHealth, 10_000)
    onCleanup(() => clearInterval(interval))
  })

  createEffect(() => {
    const api = platform.wslServers
    if (!api) return
    let dead = false
    void api
      .getState()
      .then((state) => {
        if (dead) return
        setStore("wslState", reconcile(state))
      })
      .catch((err) => {
        if (dead) return
        showRequestError(language, err)
      })
    const off = api.subscribe((event) => {
      setStore("wslState", reconcile(event.state))
    })
    onCleanup(() => {
      dead = true
      off()
    })
  })

  const wslCheck = (conn: ServerConnection.Any) => {
    if (conn.type !== "sidecar" || conn.variant !== "wsl") return null
    return store.wslState?.opencodeChecks[conn.distro] ?? null
  }

  const displayVersion = (conn: ServerConnection.Any) => {
    if (conn.type === "sidecar" && conn.variant === "wsl") return wslCheck(conn)?.version ?? undefined
    return undefined
  }

  async function select(conn: ServerConnection.Any, persist?: boolean) {
    if (!isSelectable(conn)) return
    if (!persist && store.status[ServerConnection.key(conn)]?.healthy === false) return
    const nextKey = ServerConnection.key(conn)
    const changed = server.key !== nextKey

    const apply = () => {
      dialog.close()
      if (persist && conn.type === "http") {
        server.add(conn)
        if (changed && typeof window !== "undefined" && window.history?.replaceState) {
          window.history.replaceState(null, "", "/")
        } else {
          props.onNavigateHome?.()
        }
        return
      }

      batch(() => {
        if (changed && typeof window !== "undefined" && window.history?.replaceState) {
          window.history.replaceState(null, "", "/")
        } else {
          props.onNavigateHome?.()
        }
        server.setActive(nextKey)
      })
    }

    if (!changed) {
      apply()
      return
    }

    await withServerSwitchOverlay(apply)
  }

  createEffect(() => {
    const key = store.addWsl.pendingSelectKey
    if (!key) return
    const conn = items().find((item) => ServerConnection.key(item) === key)
    if (!conn || !isSelectable(conn)) return
    const resolve = resolvePendingWslSelection
    resolvePendingWslSelection = undefined
    setStore("addWsl", "pendingSelectKey", undefined)
    void select(conn).finally(() => resolve?.())
  })

  const handleAddChange = (value: string) => {
    if (addMutation.isPending) return
    setStore("addServer", { url: value, error: "" })
    void previewStatus(value, store.addServer.username, store.addServer.password, (next) =>
      setStore("addServer", { status: next }),
    )
  }

  const handleAddNameChange = (value: string) => {
    if (addMutation.isPending) return
    setStore("addServer", { name: value, error: "" })
  }

  const handleAddUsernameChange = (value: string) => {
    if (addMutation.isPending) return
    setStore("addServer", { username: value, error: "" })
    void previewStatus(store.addServer.url, value, store.addServer.password, (next) =>
      setStore("addServer", { status: next }),
    )
  }

  const handleAddPasswordChange = (value: string) => {
    if (addMutation.isPending) return
    setStore("addServer", { password: value, error: "" })
    void previewStatus(store.addServer.url, store.addServer.username, value, (next) =>
      setStore("addServer", { status: next }),
    )
  }

  const handleEditChange = (value: string) => {
    if (editMutation.isPending) return
    setStore("editServer", { value, error: "" })
    void previewStatus(value, store.editServer.username, store.editServer.password, (next) =>
      setStore("editServer", { status: next }),
    )
  }

  const handleEditNameChange = (value: string) => {
    if (editMutation.isPending) return
    setStore("editServer", { name: value, error: "" })
  }

  const handleEditUsernameChange = (value: string) => {
    if (editMutation.isPending) return
    setStore("editServer", { username: value, error: "" })
    void previewStatus(store.editServer.value, value, store.editServer.password, (next) =>
      setStore("editServer", { status: next }),
    )
  }

  const handleEditPasswordChange = (value: string) => {
    if (editMutation.isPending) return
    setStore("editServer", { password: value, error: "" })
    void previewStatus(store.editServer.value, store.editServer.username, value, (next) =>
      setStore("editServer", { status: next }),
    )
  }

  const mode = createMemo<"list" | "add-wsl" | "add" | "edit">(() => {
    if (store.addWsl.showWizard) return "add-wsl"
    if (store.editServer.id) return "edit"
    if (store.addServer.showForm) return "add"
    return "list"
  })

  const editing = createMemo(() => {
    if (!store.editServer.id) return
    return items().find((x) => x.type === "http" && x.http.url === store.editServer.id)
  })

  const resetForm = () => {
    resetAdd()
    resetEdit()
    resolvePendingWslSelection?.()
    resolvePendingWslSelection = undefined
    setStore("addWsl", "pendingSelectKey", undefined)
    setStore("addWsl", "showWizard", false)
  }

  const startAdd = () => {
    setStore("addWsl", "showWizard", false)
    resetEdit()
    setStore("addServer", {
      showForm: true,
      url: "",
      name: "",
      username: DEFAULT_USERNAME,
      password: "",
      error: "",
      status: undefined,
    })
  }

  const startEdit = (conn: ServerConnection.Http) => {
    setStore("addWsl", "showWizard", false)
    resetAdd()
    setStore("editServer", {
      id: conn.http.url,
      value: conn.http.url,
      name: conn.displayName ?? "",
      username: conn.http.username ?? "",
      password: conn.http.password ?? "",
      error: "",
      status: store.status[ServerConnection.key(conn)]?.healthy,
    })
  }

  const startAddWsl = () => {
    resetAdd()
    resetEdit()
    setStore("addWsl", "pendingSelectKey", undefined)
    setStore("addWsl", "showWizard", true)
  }

  const handleAddedWsl = async (distro: string) => {
    const key = ServerConnection.Key.make(`wsl:${distro}`)
    const conn = items().find((item) => ServerConnection.key(item) === key)
    if (conn && isSelectable(conn)) {
      await select(conn)
      return
    }
    await new Promise<void>((resolve) => {
      resolvePendingWslSelection = resolve
      setStore("addWsl", "pendingSelectKey", key)
    })
  }

  const submitForm = () => {
    if (mode() === "add") {
      if (addMutation.isPending) return
      setStore("addServer", { error: "" })
      addMutation.mutate(store.addServer.url)
      return
    }
    const original = editing()
    if (!original) return
    if (editMutation.isPending) return
    setStore("editServer", { error: "" })
    editMutation.mutate({ original, value: store.editServer.value })
  }

  const isFormMode = createMemo(() => mode() !== "list")
  const isAddMode = createMemo(() => mode() === "add")
  const isAddWslMode = createMemo(() => mode() === "add-wsl")
  const formBusy = createMemo(() => (isAddMode() ? addMutation.isPending : editMutation.isPending))
  const canAddWsl = createMemo(() => !!platform.wslServers && platform.os === "windows")

  const formTitle = createMemo(() => {
    if (!isFormMode()) return language.t("dialog.server.title")
    return (
      <div class="flex items-center gap-2 -ml-2">
        <IconButton icon="arrow-left" variant="ghost" onClick={resetForm} aria-label={language.t("common.goBack")} />
        <span>
          {isAddWslMode()
            ? "Add WSL server"
            : isAddMode()
              ? language.t("dialog.server.add.title")
              : language.t("dialog.server.edit.title")}
        </span>
      </div>
    )
  })

  createEffect(() => {
    if (!store.editServer.id) return
    if (editing()) return
    resetEdit()
  })

  async function handleRemove(key: ServerConnection.Key) {
    server.remove(key)
    if ((await platform.getDefaultServer?.()) === key) {
      void platform.setDefaultServer?.(null)
    }
  }

  async function handleRemoveWsl(conn: ServerConnection.Any) {
    if (conn.type !== "sidecar" || conn.variant !== "wsl") return
    const key = ServerConnection.key(conn)
    try {
      await platform.wslServers?.removeServer(key)
      server.remove(key)
      if ((await platform.getDefaultServer?.()) === key) {
        void platform.setDefaultServer?.(null)
      }
    } catch (err) {
      showRequestError(language, err)
    }
  }

  async function handleRetryWsl(conn: ServerConnection.Any) {
    if (conn.type !== "sidecar" || conn.variant !== "wsl") return
    try {
      await platform.wslServers?.startServer(ServerConnection.key(conn))
    } catch (err) {
      showRequestError(language, err)
    }
  }

  async function handleUpdateWsl(conn: ServerConnection.Any) {
    if (conn.type !== "sidecar" || conn.variant !== "wsl") return
    const api = platform.wslServers
    if (!api) return
    try {
      await api.installOpencode(conn.distro)
      await refreshHealth()
    } catch (err) {
      showRequestError(language, err)
    }
  }

  return (
    <Dialog
      title={formTitle()}
      dismissOutside={!isAddWslMode()}
      fit={isAddWslMode()}
      class={isAddWslMode() ? "[&_[data-slot=dialog-body]]:flex-none [&_[data-slot=dialog-body]]:overflow-visible" : undefined}
    >
      <div class="flex flex-col gap-2">
        <Show
          when={!isFormMode()}
          fallback={
            <Show
              when={isAddWslMode()}
              fallback={
                <ServerForm
                  value={isAddMode() ? store.addServer.url : store.editServer.value}
                  name={isAddMode() ? store.addServer.name : store.editServer.name}
                  username={isAddMode() ? store.addServer.username : store.editServer.username}
                  password={isAddMode() ? store.addServer.password : store.editServer.password}
                  placeholder={language.t("dialog.server.add.placeholder")}
                  busy={formBusy()}
                  error={isAddMode() ? store.addServer.error : store.editServer.error}
                  status={isAddMode() ? store.addServer.status : store.editServer.status}
                  onChange={isAddMode() ? handleAddChange : handleEditChange}
                  onNameChange={isAddMode() ? handleAddNameChange : handleEditNameChange}
                  onUsernameChange={isAddMode() ? handleAddUsernameChange : handleEditUsernameChange}
                  onPasswordChange={isAddMode() ? handleAddPasswordChange : handleEditPasswordChange}
                  onSubmit={submitForm}
                  onBack={resetForm}
                />
              }
            >
              <DialogWslServer onAdded={handleAddedWsl} />
            </Show>
          }
        >
          <List
            search={{
              placeholder: language.t("dialog.server.search.placeholder"),
              autofocus: false,
            }}
            noInitialSelection
            emptyMessage={language.t("dialog.server.empty")}
            items={sortedItems}
            key={(x) => ServerConnection.key(x)}
            onSelect={(x) => {
              if (x) void select(x)
            }}
            divider={true}
            class="px-5 [&_[data-slot=list-search-wrapper]]:w-full [&_[data-slot=list-scroll]]h-[300px] [&_[data-slot=list-scroll]]:overflow-y-auto [&_[data-slot=list-items]]:bg-surface-base [&_[data-slot=list-items]]:rounded-md [&_[data-slot=list-item]]:min-h-14 [&_[data-slot=list-item]]:p-3 [&_[data-slot=list-item]]:!bg-transparent"
          >
            {(i) => {
              const key = ServerConnection.key(i)
              const isWslSidecar = i.type === "sidecar" && i.variant === "wsl"
              const wslDistro = i.type === "sidecar" && i.variant === "wsl" ? i.distro : undefined
              const blocked = () => !isSelectable(i) || health(key)?.healthy === false
              const hasMenuActionsBeforeDelete = () => i.type === "http" || (isWslSidecar && canRetryWsl(i))
              const outdated = () => {
                const check = wslCheck(i)
                return versionOlderThan(check?.version, check?.expectedVersion)
              }
              const opencodeAction = () => {
                const check = wslCheck(i)
                if (!check) return null
                if (!check.resolvedPath) return "Install OpenCode"
                if (outdated()) return "Update OpenCode"
                return null
              }
              const updating = () =>
                store.wslState?.job?.kind === "install-opencode" && store.wslState.job.distro === wslDistro
              return (
                <div class="flex items-center gap-3 min-w-0 flex-1 w-full group/item">
                  <div class="flex flex-col h-full items-start w-5">
                    <ServerHealthIndicator health={health(key)} />
                  </div>
                  <ServerRow
                    conn={i}
                    dimmed={blocked()}
                    status={health(key)}
                    version={displayVersion(i)}
                    class="flex items-center gap-3 min-w-0 flex-1"
                    badge={
                      <Show when={defaultKey() === ServerConnection.key(i)}>
                        <span class="text-text-base bg-surface-base text-14-regular px-1.5 rounded-xs">
                          {language.t("dialog.server.status.default")}
                        </span>
                      </Show>
                    }
                    showCredentials
                  />
                  <div class="flex items-center justify-center gap-3 pl-4">
                    <Show when={isWslSidecar && opencodeAction()}>
                      {(label) => (
                        <Button
                          variant="secondary"
                          size="small"
                          disabled={!!store.wslState?.job}
                          class="shrink-0"
                          onPointerDown={(e: PointerEvent) => e.stopPropagation()}
                          onClick={(e: MouseEvent) => {
                            e.stopPropagation()
                            void handleUpdateWsl(i)
                          }}
                        >
                          {updating() ? "Updating OpenCode..." : label()}
                        </Button>
                      )}
                    </Show>
                    <Show when={ServerConnection.key(current()) === key}>
                      <Icon name="check" class="h-6" />
                    </Show>

                    <Show when={i.type === "http" || isWslSidecar}>
                      <DropdownMenu>
                        <DropdownMenu.Trigger
                          as={IconButton}
                          icon="dot-grid"
                          variant="ghost"
                          class="shrink-0 size-8 hover:bg-surface-base-hover data-[expanded]:bg-surface-base-active"
                          onClick={(e: MouseEvent) => e.stopPropagation()}
                          onPointerDown={(e: PointerEvent) => e.stopPropagation()}
                        />
                        <DropdownMenu.Portal>
                          <DropdownMenu.Content class="mt-1">
                            <Show when={i.type === "http"}>
                              <DropdownMenu.Item
                                onSelect={() => {
                                  if (i.type !== "http") return
                                  startEdit(i)
                                }}
                              >
                                <DropdownMenu.ItemLabel>{language.t("dialog.server.menu.edit")}</DropdownMenu.ItemLabel>
                              </DropdownMenu.Item>
                            </Show>
                            <Show when={isWslSidecar && canRetryWsl(i)}>
                              <DropdownMenu.Item onSelect={() => void handleRetryWsl(i)}>
                                <DropdownMenu.ItemLabel>Retry start</DropdownMenu.ItemLabel>
                              </DropdownMenu.Item>
                            </Show>
                            <Show when={i.type === "http" && canDefault() && defaultKey() !== key}>
                              <DropdownMenu.Item onSelect={() => setDefault(key)}>
                                <DropdownMenu.ItemLabel>
                                  {language.t("dialog.server.menu.default")}
                                </DropdownMenu.ItemLabel>
                              </DropdownMenu.Item>
                            </Show>
                            <Show when={i.type === "http" && canDefault() && defaultKey() === key}>
                              <DropdownMenu.Item onSelect={() => setDefault(null)}>
                                <DropdownMenu.ItemLabel>
                                  {language.t("dialog.server.menu.defaultRemove")}
                                </DropdownMenu.ItemLabel>
                              </DropdownMenu.Item>
                            </Show>
                            <Show when={hasMenuActionsBeforeDelete()}>
                              <DropdownMenu.Separator />
                            </Show>
                            <Show when={i.type === "http" || isWslSidecar}>
                              <DropdownMenu.Item
                                onSelect={() => (isWslSidecar ? void handleRemoveWsl(i) : handleRemove(key))}
                                class="text-text-on-critical-base hover:bg-surface-critical-weak"
                              >
                                <DropdownMenu.ItemLabel>
                                  {language.t("dialog.server.menu.delete")}
                                </DropdownMenu.ItemLabel>
                              </DropdownMenu.Item>
                            </Show>
                          </DropdownMenu.Content>
                        </DropdownMenu.Portal>
                      </DropdownMenu>
                    </Show>
                  </div>
                </div>
              )
            }}
          </List>
        </Show>

        <div class="px-5 pb-5">
          <Show
            when={!isAddWslMode() && isFormMode()}
            fallback={
              <Show when={!isAddWslMode()}>
                <div class="flex items-center gap-2">
                  <Button
                    variant="secondary"
                    icon="plus-small"
                    size="large"
                    onClick={startAdd}
                    class="py-1.5 pl-1.5 pr-3 flex items-center gap-1.5"
                  >
                    {language.t("dialog.server.add.button")}
                  </Button>
                  <Show when={canAddWsl()}>
                    <Button
                      variant="secondary"
                      icon="plus-small"
                      size="large"
                      onClick={startAddWsl}
                      class="py-1.5 pl-1.5 pr-3 flex items-center gap-1.5"
                    >
                      Add WSL
                    </Button>
                  </Show>
                </div>
              </Show>
            }
          >
            <Button variant="primary" size="large" onClick={submitForm} disabled={formBusy()} class="px-3 py-1.5">
              {formBusy()
                ? language.t("dialog.server.add.checking")
                : isAddMode()
                  ? language.t("dialog.server.add.button")
                  : language.t("common.save")}
            </Button>
          </Show>
        </div>
      </div>
    </Dialog>
  )
}
