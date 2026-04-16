# WSL Local Server Implementation Backlog

This backlog assumes Electron only.
It is ordered chronologically.
Each task is intended to be small enough for a new engineer to pick up directly.

## 01 Foundation

- [ ] Add a new persisted `localServer` settings key in `packages/desktop-electron/src/main/constants.ts`.
- [ ] Define a `LocalServerMode` type with `"windows" | "wsl"` in the Electron preload types.
- [ ] Define a persisted `LocalServerConfig` shape in the Electron preload types.
- [ ] Include `mode`, `distro`, onboarding metadata, root acknowledgements, and mismatch acknowledgements in `LocalServerConfig`.
- [ ] Remove the old `WslConfig` type from `packages/desktop-electron/src/preload/types.ts`.
- [ ] Remove the old `WSL_ENABLED_KEY` constant and stop adding new code that depends on it.
- [ ] Add a single source of truth helper in Electron main for reading `LocalServerConfig` from `electron-store`.
- [ ] Add a single source of truth helper in Electron main for writing `LocalServerConfig` to `electron-store`.
- [ ] Ignore any legacy `wslEnabled` value during reads of the new Local Server config.
- [ ] Add explicit comments in the new config helpers that this feature is Electron-only and replaces the legacy WSL boolean.

## 02 Main-Process Local Server Controller

- [ ] Create a dedicated Electron main module for Local Server orchestration, for example `packages/desktop-electron/src/main/local-server.ts`.
- [ ] Move local runtime orchestration out of ad hoc startup code and into the Local Server controller.
- [ ] Define an in-memory `LocalServerState` shape for runtime status, current job, current transcript, and startup failure.
- [ ] Keep `LocalServerState` in memory only; do not persist runtime status or raw logs.
- [ ] Add a typed event emitter inside the Local Server controller.
- [ ] Support one active Local Server job at a time in the controller.
- [ ] Add a helper to reject or cancel a previous Local Server job before starting a new one.
- [ ] Allocate the loopback port once per app launch and keep it stable for all Local Server restarts in that launch.
- [ ] Allocate the local auth password once per app launch and keep it stable for all Local Server restarts in that launch.
- [ ] Expose a controller method to return a full current Local Server snapshot.
- [ ] Expose a controller method to subscribe to Local Server events.
- [ ] Expose a controller method to update persisted Local Server config.
- [ ] Expose a controller method to run a specific wizard step.
- [ ] Expose a controller method to apply Local Server runtime changes in the background.
- [ ] Expose a controller method to cancel the current Local Server job.
- [ ] Expose a controller method to open a terminal for the selected distro.

## 03 Windows Local Runtime Path

- [ ] Move the existing Windows local sidecar startup path from `packages/desktop-electron/src/main/server.ts` into the Local Server controller.
- [ ] Keep the existing Windows local runtime behavior unchanged when `mode === "windows"`.
- [ ] Keep the existing eager local startup behavior unchanged for Windows local mode.
- [ ] Keep the existing loopback no-proxy behavior unchanged for Windows local mode.
- [ ] Update the controller snapshot so Windows local mode reports a distinct runtime key instead of the old implicit bare `sidecar` assumption.

## 04 WSL Process Helpers

- [ ] Add a helper to spawn `wsl.exe` with a selected distro and stream stdout/stderr lines.
- [ ] Standardize all WSL command execution on `wsl.exe -d <distro> -- bash -lc ...`.
- [ ] Add a helper to kill the currently spawned WSL child process when a job is canceled.
- [ ] Do not call `wsl --terminate <distro>` as part of normal cancel behavior.
- [ ] Add a helper to run a short command and collect stdout/stderr for probe steps.
- [ ] Add a helper to resolve the selected distro home directory via `~`.
- [ ] Add a helper to run `command -v opencode` inside the selected distro.
- [ ] Add a helper to resolve `opencode --version` inside the selected distro.
- [ ] Add a helper to detect the selected distro default username via shell commands.
- [ ] Add a helper to detect whether the selected distro default user is `root`.
- [ ] Add a helper to detect whether `bash` exists in the selected distro.
- [ ] Add a helper to detect whether `curl` exists in the selected distro.
- [ ] Add a helper to run `opencode upgrade <desktopVersion>` inside the selected distro.
- [ ] Add a helper to launch the Local Server with a resolved absolute executable path instead of bare `opencode`.

## 05 WSL Runtime and Distro Probes

- [ ] Add a helper to probe whether `wsl.exe` is available and usable.
- [ ] Add a helper to list installed distros with `wsl --list --verbose`.
- [ ] Add a helper to list online distros with `wsl --list --online`.
- [ ] Do not add system-distro filtering logic; keep all returned distros visible.
- [ ] Add probe parsing for `WSL 1` vs `WSL 2` from installed distro data.
- [ ] Treat `WSL 2` as required for first-class onboarding.
- [ ] Add explicit probe output for `missing bash`.
- [ ] Add explicit probe output for `missing curl`.
- [ ] Add explicit probe output for `cannot execute commands in distro`.
- [ ] Add explicit probe output for `default user is root`.
- [ ] Add explicit probe output for `distro not found`.

## 06 WSL Install Helpers

- [ ] Add a helper to run elevated `wsl --install --no-distribution` from Electron main.
- [ ] Implement that elevation path with a shell-based helper invocation rather than a bundled helper binary.
- [ ] Add a helper to install a distro with `wsl --install -d <name> --web-download --no-launch`.
- [ ] Do not auto-install a default distro as part of the WSL runtime install step.
- [ ] Add a helper to detect whether a WSL install requires reboot.
- [ ] Add a helper to expose a `Restart now` action.
- [ ] Add a helper to mark onboarding as pending reboot when the user chooses `Later`.

## 07 OpenCode Runtime Detection and Repair

- [ ] Resolve `command -v opencode` on each startup when `mode === "wsl"`.
- [ ] Re-resolve `command -v opencode` on each explicit WSL apply/retry action.
- [ ] Compare the detected WSL `opencode` version to the desktop app version.
- [ ] Record mismatch acknowledgement once per resolved path plus version pair.
- [ ] Keep version mismatch non-blocking.
- [ ] Treat `Use anyway` as sufficient to complete the OpenCode step with warning.
- [ ] Implement `Install matching version` by running `opencode upgrade <desktopVersion>` first.
- [ ] If `opencode upgrade` hangs, prompts, or fails, mark the repair attempt failed and stop automation.
- [ ] Surface the failed upgrade transcript in the Local Server UI.
- [ ] Do not add an automatic fallback installer path after `opencode upgrade` fails.
- [ ] Surface manual recovery commands instead.

## 08 Startup Handshake and App Boot

- [ ] Replace the current success-only startup payload with a ready-or-failed startup union.
- [ ] Include local runtime metadata in the startup payload.
- [ ] Include the local runtime key in the startup payload.
- [ ] Include runtime variant details in the startup payload.
- [ ] Include selected distro in the startup payload when `mode === "wsl"`.
- [ ] Include loopback URL and credentials in the startup payload even when the local runtime later fails health.
- [ ] Include startup failure step and message in the startup payload when the local runtime fails.
- [ ] Update `packages/desktop-electron/src/main/index.ts` to initialize Local Server through the controller.
- [ ] Keep the loading overlay generic and do not add WSL-specific overlay phases in v1.
- [ ] Add a startup health-verdict timeout for WSL local startup so the app can open after failure.
- [ ] Scope the startup timeout to the local health verdict only, not to sqlite migration.
- [ ] Open the main window after startup reaches a ready-or-failed local verdict.

## 09 IPC and Preload API

- [ ] Add a namespaced `localServer` API to the Electron preload surface.
- [ ] Implement `localServer.getState()`.
- [ ] Implement `localServer.subscribe()` with unsubscribe support.
- [ ] Implement `localServer.setConfig()`.
- [ ] Implement `localServer.runStep()`.
- [ ] Implement `localServer.apply()` for background runtime switching.
- [ ] Implement `localServer.cancelJob()`.
- [ ] Implement `localServer.openTerminal()`.
- [ ] Implement `localServer.restartNow()` for reboot-required flows.
- [ ] Implement `localServer.copyTranscript()` or equivalent transcript fetch action.
- [ ] Emit typed step/state events from main to renderer.
- [ ] Emit raw stdout/stderr line events from main to renderer.
- [ ] Remove `getWslConfig` from the preload API.
- [ ] Remove `setWslConfig` from the preload API.
- [ ] Remove `get-wsl-config` and `set-wsl-config` IPC handlers.

## 10 Renderer Startup and Platform Wiring

- [ ] Update the desktop renderer startup resource to consume the new startup union shape.
- [ ] Build the Local Server `ServerConnection.Sidecar` from structured startup metadata instead of hardcoding `variant: "base"`.
- [ ] Keep the visible Local Server display name as `Local Server` in both Windows and WSL modes.
- [ ] Add a WSL badge or subtitle in the row UI instead of renaming the server.
- [ ] Change the implicit local fallback key to follow the configured Local Server runtime.
- [ ] Remove all uses of `window.__OPENCODE__.wsl` from the renderer.
- [ ] Derive WSL picker/path behavior from structured Local Server state instead of a global boolean.
- [ ] Update `createPlatform()` so WSL path conversion only activates when Local Server mode is WSL.
- [ ] Default native pickers to the selected distro home path when Local Server mode is WSL.
- [ ] Keep native pickers on normal Windows behavior when Local Server mode is Windows.

## 11 Distro-Aware Path Conversion

- [ ] Update `packages/desktop-electron/src/main/apps.ts` so `wslPath()` accepts a distro parameter.
- [ ] Stop using the ambient default WSL distro for path conversion.
- [ ] Use the selected Local Server distro for all `~` resolution.
- [ ] Use the selected Local Server distro for all Windows-to-Linux path conversion.
- [ ] Use the selected Local Server distro for all Linux-to-Windows path conversion.
- [ ] Update open-path behavior to use distro-aware conversion when Local Server mode is WSL.

## 12 App Server Model Changes

- [ ] Introduce a distinct explicit key for Windows Local Server.
- [ ] Keep WSL Local Server keyed by distro identity.
- [ ] Update `packages/app/src/context/server.tsx` so Windows local and WSL local do not collapse into the same project-history bucket.
- [ ] Update `projectsKey()` to keep Windows local and WSL local histories separate.
- [ ] Update `isLocal()` so WSL Local Server still counts as local.
- [ ] Ensure Local Server key changes force the expected remount behavior through `ServerKey` in `packages/app/src/app.tsx`.
- [ ] If Local Server is currently active, make successful runtime switches follow the new local key automatically.

## 13 Manage Servers Dialog Shell

- [ ] Add a pinned `Local Server` row to `packages/app/src/components/dialog-select-server.tsx` list mode.
- [ ] Extract a dedicated Local Server page component instead of growing `dialog-select-server.tsx` further.
- [ ] Add a dialog mode or route that opens the dedicated Local Server page from the server list.
- [ ] Keep existing HTTP add/edit/delete/default flows untouched while adding the Local Server entry.
- [ ] Add an initial-view prop so the Manage Servers dialog can open directly to Local Server.

## 14 Local Server Wizard

- [ ] Implement a dedicated Local Server wizard component.
- [ ] Implement step order exactly as `WSL -> Distro -> OpenCode -> Switch`.
- [ ] Allow the user to go back and edit earlier steps.
- [ ] Persist wizard progress inside `LocalServerConfig`.
- [ ] Auto-resume the wizard after app relaunch when onboarding is incomplete.
- [ ] Auto-resume the wizard after reboot when onboarding was waiting for restart.
- [ ] Mark the wizard complete only after Local Server hot restart succeeds and health passes.

## 15 WSL Step UI

- [ ] Show current WSL runtime probe result in the WSL step.
- [ ] Add an `Install WSL` action that starts elevated `wsl --install --no-distribution`.
- [ ] Show reboot-required state in the WSL step when the install path requires restart.
- [ ] Add `Restart now` and `Later` actions.
- [ ] Keep the WSL step editable after the user returns from reboot.

## 16 Distro Step UI

- [ ] Show installed distros with explicit probe status in the Distro step.
- [ ] Show quick install actions for `Debian` and `Ubuntu 24`.
- [ ] Show an `Other distro...` action that reads from the online distro list.
- [ ] After distro install, auto-select the newly installed distro and continue probing automatically.
- [ ] Surface `WSL 1` as unsupported with manual conversion instructions.
- [ ] Surface `missing bash` as an explicit unsupported reason.
- [ ] Surface `missing curl` as an explicit unsupported reason.
- [ ] Surface `cannot execute commands` as an explicit unsupported reason.
- [ ] Surface `default user is root` as a warning in the Distro step.
- [ ] Require explicit root acknowledgement once per distro.
- [ ] Keep all distros visible even when unsupported.
- [ ] If the selected distro disappears, show an explicit missing-distro error instead of auto-switching away.

## 17 OpenCode Step UI

- [ ] Show the resolved absolute `opencode` path for the selected distro.
- [ ] Show the detected `opencode` version for the selected distro.
- [ ] Show version mismatch as a non-blocking warning.
- [ ] Add `Use anyway` in the mismatch state.
- [ ] Add `Install matching version` in the mismatch state.
- [ ] Keep mismatch acknowledgement scoped to path plus version.
- [ ] Re-warn only when the resolved path or resolved version changes later.
- [ ] If `command -v opencode` resolves nothing, show explicit manual recovery guidance.
- [ ] If `opencode upgrade` fails, keep the step incomplete and show the transcript.

## 18 Switch Step UI

- [ ] Add a `Switch Local Server` action that applies the new Local Server runtime in the background.
- [ ] Keep remote sessions usable while the Switch step runs.
- [ ] Reuse the current app-launch port and password during background Local Server restarts.
- [ ] Keep the Local Server active selection on Local Server when the switch succeeds and Local Server was already active.
- [ ] Show success only after `/global/health` succeeds for the new runtime.
- [ ] If background apply fails, show a `Restart OpenCode` fallback prompt.

## 19 Local Server Status Dashboard

- [ ] Replace the wizard with a steady-state dashboard after onboarding completes.
- [ ] Show current mode on the dashboard.
- [ ] Show selected distro on the dashboard when in WSL mode.
- [ ] Show current Local Server health on the dashboard.
- [ ] Show current failure state on the dashboard when the last startup or apply failed.
- [ ] Show version mismatch warning on the dashboard when the user chose `Use anyway`.
- [ ] Show root warning on the dashboard when the selected distro is root-backed and acknowledged.
- [ ] Do not show stale last-known-good probe values outside the current failure context.
- [ ] Add dashboard actions for `Retry`, `Open terminal`, and transcript copy.

## 20 Live Diagnostics

- [ ] Add a live diagnostics panel to the Local Server UI.
- [ ] Stream merged stdout/stderr lines into the panel while jobs are running.
- [ ] Keep the panel usable for startup failures from the current app launch.
- [ ] Retain the full Local Server transcript only for the current app launch.
- [ ] Clear the retained transcript on full app relaunch.
- [ ] Show exact commands in the diagnostics details area.
- [ ] Make `Copy commands` copy the same transcript content as the transcript-copy action.
- [ ] Keep diagnostics collapsible by default.

## 21 Connection Error and Deep Linking

- [ ] Add a direct `Open Local Server` CTA to the existing `ConnectionError` screen when the failing server is Local Server.
- [ ] Make that CTA open the Manage Servers dialog directly to the Local Server page.
- [ ] When Local Server startup failed earlier in the same launch, jump the Local Server UI directly to the failing step or dashboard state.
- [ ] Keep existing retry behavior for non-local remote servers unchanged.

## 22 Runtime Apply and Background Behavior

- [ ] Apply Local Server runtime changes in the background when the active server is remote.
- [ ] Do not navigate away from a remote session during a Local Server background apply.
- [ ] Keep Local Server config separate from active/default server selection logic.
- [ ] Do not auto-select Local Server just because its runtime config changed.
- [ ] Do not auto-change the user's default remote server selection when Local Server mode changes.

## 23 Main Window Startup Failure Handling

- [ ] If WSL Local Server fails during startup, keep the app launch going after the health-verdict timeout.
- [ ] Represent that failure in the startup payload instead of throwing away initialization.
- [ ] Keep the Local Server row present in the server list even when startup failed.
- [ ] Mark the Local Server row unhealthy when startup failed.
- [ ] Keep the startup loading overlay generic even in this failed case.

## 24 API Cleanup and Legacy Removal

- [ ] Remove the old hidden WSL settings UI branch from `packages/app/src/components/settings-general.tsx`.
- [ ] Remove legacy renderer calls that assume a boolean WSL mode.
- [ ] Remove legacy IPC registrations for the boolean WSL config.
- [ ] Remove legacy preload typing for the boolean WSL config.
- [ ] Remove legacy main-process store helpers that only read/write `wslEnabled`.

## 25 Manual Recovery and Power Actions

- [ ] Implement `Open terminal` as `open selected distro shell only` and do not auto-run recovery commands.
- [ ] Make `Open terminal` target the selected distro explicitly.
- [ ] Add a transcript copy action that is available even after failed jobs.
- [ ] Keep manual recovery command text aligned with the actual commands the controller runs.
- [ ] Include manual commands for WSL 1 conversion in the Distro step.
- [ ] Include manual commands for missing `curl` in the Distro or OpenCode step as appropriate.
- [ ] Include manual commands for PATH install version repair in the OpenCode step failure state.

## 26 Verification and QA

- [ ] Verify Windows Local Server behavior is unchanged when `mode === "windows"`.
- [ ] Verify the app still boots normally with no Local Server config present.
- [ ] Verify the app opens after a WSL startup failure instead of hanging forever.
- [ ] Verify `Install WSL` can reach a reboot-required state and resume after relaunch.
- [ ] Verify `Restart now` and `Later` both preserve onboarding state correctly.
- [ ] Verify Debian quick install auto-selects the new distro and continues onboarding.
- [ ] Verify Ubuntu 24 quick install auto-selects the new distro and continues onboarding.
- [ ] Verify `Other distro...` uses the live online catalog.
- [ ] Verify a WSL 1 distro surfaces manual conversion instructions.
- [ ] Verify a distro missing `bash` surfaces an explicit unsupported reason.
- [ ] Verify a distro missing `curl` surfaces an explicit unsupported reason.
- [ ] Verify a root-backed distro requires acknowledgement once per distro.
- [ ] Verify PATH-installed `opencode` is re-resolved on each startup.
- [ ] Verify mismatch acknowledgement only reappears when path or version changes.
- [ ] Verify `Use anyway` completes onboarding with a lingering dashboard warning.
- [ ] Verify `Install matching version` runs `opencode upgrade <desktopVersion>`.
- [ ] Verify an upgrade hang or prompt can be canceled and leaves a usable transcript.
- [ ] Verify Local Server hot restart keeps the same port and password within one app launch.
- [ ] Verify Local Server hot restart does not interrupt an active remote session.
- [ ] Verify active Local Server selection follows the new local key after a successful runtime switch.
- [ ] Verify Windows local and WSL local project histories remain separate.
- [ ] Verify the `ConnectionError` CTA opens the Local Server page directly.
- [ ] Verify selected-distro path conversion is used everywhere in WSL mode.
- [ ] Verify selected-distro home is used as the picker default in WSL mode.
- [ ] Verify deleting the selected distro produces an explicit error instead of silent fallback.
- [ ] Verify transcripts are only retained for the current app launch.
