# WSL Server Implementation Backlog

This backlog assumes Electron only.
It is ordered chronologically.
Each task is intended to be small enough for a new engineer to pick up directly.

## Direction

- Local Server is **always** Windows-native local on Windows.
- Local Server has no runtime swap and no WSL mode.
- WSL servers are a **separate, additive** concept.
- A Windows user can add zero or more WSL servers; each is bound to a specific distro.
- Each WSL server runs as its own sidecar alongside the Windows Local Server.
- Adding/removing a WSL server is hot; no app restart required.
- Manage Servers UI exposes an `Add WSL` button (Windows only) that opens the wizard.

## 01 Electron Config Split

- [x] Remove runtime `mode` / `distro` from the persisted Local Server config.
- [x] Introduce a new persisted `wslServers` key holding an array of `WslServerConfig`.
- [x] Define `WslServerConfig` as `{ id, distro, onboarding, acknowledgements }`.
- [x] Keep onboarding metadata per WSL server, not globally.
- [x] Keep acknowledgement state per WSL server.
- [x] Migrate any legacy `localServer.mode === "wsl"` entry into a single `wslServers` entry on read.
- [x] Drop all references to `LocalServerMode` from the preload types.

## 02 Main-Process Multi-Sidecar Startup

- [x] Always start the Windows local sidecar on app launch.
- [x] After Windows local is spawned, iterate each `WslServerConfig` and spawn a WSL sidecar per entry.
- [x] Give each WSL sidecar its own port and password.
- [x] Allocate the Windows local port/password once per launch (unchanged).
- [x] Track all sidecars in a single map keyed by server id.
- [x] Kill all sidecars on `before-quit` / `will-quit` / signal.
- [x] Include Windows local data in the startup payload unchanged.
- [x] Include the initial set of WSL servers (with url/password/status) in the startup payload.
- [x] Emit per-WSL-server lifecycle events (`starting`, `ready`, `failed`, `stopping`, `removed`).
- [x] On startup, do not block the main window on WSL sidecar health.
- [x] If a WSL sidecar fails health, keep it in the list and mark it failed instead of hanging startup.

## 03 WSL Server Controller

- [x] Create a main-process controller that owns `wslServers` persistence and runtime state.
- [x] Expose typed events (`state`, per-item status changes) from the controller.
- [x] Support one in-flight job per WSL server (not a global in-flight job).
- [x] Implement `addServer(distro)` that persists, then spawns and health-checks a new sidecar.
- [x] Implement `removeServer(id)` that stops the sidecar and removes it from config.
- [x] Implement per-server `runStep`, `cancelJob`, `installWsl`, `installDistro`, `installOpencode`, `openTerminal`.
- [x] Reuse the existing WSL process helpers unchanged.
- [x] Keep transcripts per server, only for the current app launch.

## 04 IPC / Preload Surface

- [x] Rename `localServer.*` IPC channels to `wslServers.*`.
- [x] Add `wslServers.getState()` returning the full list plus per-server runtime info.
- [x] Add `wslServers.subscribe()` with unsubscribe support.
- [x] Add `wslServers.add(distro)` (persists config + starts sidecar).
- [x] Add `wslServers.remove(id)`.
- [x] Add `wslServers.runStep(id, step)`.
- [x] Add `wslServers.cancelJob(id)`.
- [x] Add `wslServers.installWsl(id)`.
- [x] Add `wslServers.installDistro(id, distro)`.
- [x] Add `wslServers.installOpencode(id)`.
- [x] Add `wslServers.openTerminal(id)`.
- [x] Remove obsolete `localServer.setConfig` / `localServer.*` channels.
- [x] Include url/username/password for each WSL server in the state payload (after sidecar start).

## 05 Renderer Platform Wiring

- [x] Expose `platform.wslServers` as a reactive accessor (list + subscribe).
- [x] Remove `platform.localServer` runtime swap APIs.
- [x] Keep `platform.wslServers` API available on Windows only.
- [x] Keep distro-aware path conversion keyed by the active WSL server.
- [x] When the active server is a WSL sidecar, default pickers to that distro's home.
- [x] When the active server is the Windows Local Server, keep native Windows picker defaults.

## 06 Renderer Server List

- [x] Always include the Windows Local Server in the server list.
- [x] Include each configured WSL server in the server list with `ServerConnection.Sidecar` variant `wsl`.
- [x] Keep `ServerConnection.key` returning `local:windows` for the Windows Local Server.
- [x] Keep `ServerConnection.key` returning `wsl:<distro>` for WSL servers (one per distro).
- [x] Keep distinct `projectsKey` buckets for Windows local vs each WSL server.
- [x] Do not collapse a WSL server into the `local` projects bucket.

## 07 Manage Servers UI

- [x] Remove `Swap to WSL` and `Swap to Windows` buttons from the Local Server row.
- [x] Show the Local Server row exactly like any other server (health, name, active check).
- [x] Add an `Add WSL` button next to `Add server`, visible only on Windows when the platform supports WSL.
- [x] `Add WSL` opens the same wizard stepper, scoped to a new WSL server draft.
- [x] Each WSL server row behaves like a sidecar entry (selectable, default-able, removable).
- [x] Add a `Remove` action to the WSL server row menu.
- [x] Add a `Retry setup` action when a WSL server is unhealthy.

## 08 Add WSL Wizard

- [x] Replace the "Switch" step with a `Done` step.
- [x] Step order becomes `WSL -> Distro -> OpenCode -> Done`.
- [x] On `Done`, persist the new WSL server, start the sidecar, and close the dialog.
- [x] If the user cancels, do not persist anything.
- [x] Allow resuming an incomplete WSL server wizard from Manage Servers.
- [x] Remove restart-to-apply copy, restart toasts, and "Use Windows" CTA.
- [x] Keep failure-only diagnostics panel behavior.

## 09 Per-WSL Onboarding State

- [x] Keep `WslServerConfig.onboarding` per server.
- [x] Keep `WslServerConfig.acknowledgements` per server.
- [x] Resume the wizard for any server where `onboarding.complete === false`.
- [x] Mark onboarding complete only after the sidecar becomes healthy.

## 10 Connection Error Path

- [x] If the active server is a WSL sidecar and health fails, offer `Open setup` that deep-links into the wizard for that server.
- [x] Keep behavior unchanged for the Windows Local Server.
- [x] Keep behavior unchanged for remote HTTP servers.

## 11 Legacy Removal

- [x] Remove `Swap to WSL` / `Swap to Windows` popover components.
- [x] Remove `restart-to-apply` banner copy and helpers from `dialog-local-server.tsx`.
- [x] Remove legacy `wslEnabled` preload shims.
- [x] Remove the old `DialogSelectServer` `initialTargetMode` prop.
- [x] Drop `localServerKey(config)` distinguishing `wsl` vs `windows` in the controller (local is always Windows).

## 12 Verification

- [ ] Verify the Windows Local Server starts unchanged on app launch.
- [ ] Verify `Add WSL` opens the wizard with the default installed distro preselected.
- [ ] Verify adding a WSL server spawns a new sidecar without restarting the app.
- [ ] Verify removing a WSL server stops the sidecar and removes it from the list.
- [ ] Verify multiple WSL servers can coexist, one per distro.
- [ ] Verify Windows Local Server stays active while WSL sidecars come and go.
- [ ] Verify a failed WSL sidecar does not block app startup or window creation.
- [ ] Verify the `ConnectionError` deep-link reaches the right wizard scope.
- [ ] Verify legacy `localServer.mode === "wsl"` persisted config migrates into `wslServers` on first launch.
- [ ] Verify project histories stay separate per server key.
