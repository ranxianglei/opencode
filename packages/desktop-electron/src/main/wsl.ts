import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { join } from "node:path"
/** @ts-expect-error */
import * as pty from "@lydell/node-pty"
import type { WslDistroProbe, WslInstalledDistro, WslOnlineDistro, WslRuntimeCheck } from "../preload/types"

export type WslCommandLine = {
  stream: "stdout" | "stderr"
  text: string
}

export type WslCommandResult = {
  code: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
}

export type RunWslOptions = {
  signal?: AbortSignal
  /**
   * Ceiling on how long we wait for the child process to exit. When the
   * LXSS service or a specific distro wedges (e.g. Ubuntu-24.04 with a
   * pending first-run prompt), `wsl.exe` never returns and any command
   * that doesn't specify a timeout hangs the entire startup flow. Default
   * is 20s — enough for slow cold-starts, short enough to fail fast on
   * a wedge. Callers can override for longer-running jobs.
   */
  timeoutMs?: number
}

const DEFAULT_WSL_TIMEOUT_MS = 20_000
const DEFAULT_WSL_INSTALL_TIMEOUT_MS = 15 * 60_000

// `--user root` bypasses the distro's default-user requirement. A freshly
// installed WSL distro (Ubuntu-24.04 in particular) prompts interactively
// for a username/password on its first invocation; when spawned with
// piped stdio that prompt blocks forever or silently reads garbage,
// leaving the sidecar hanging and the server unhealthy. Running as root
// sidesteps the entire first-run setup flow — opencode only needs an
// HTTP listener in the distro, not a per-user environment, so root is
// a safe default for the sidecar process.
export function wslArgs(args: string[], distro?: string | null) {
  if (distro) return ["-d", distro, "--user", "root", "--", ...args]
  return ["--user", "root", "--", ...args]
}

export function runWsl(args: string[], opts: RunWslOptions = {}) {
  return runCommand("wsl", args, opts)
}

function runPowerShell(command: string, opts: RunWslOptions = {}) {
  return runCommand(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", command],
    opts,
  )
}

function runCommand(command: string, args: string[], opts: RunWslOptions = {}) {
  return new Promise<WslCommandResult>((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      signal: opts.signal,
    })

    // Guard every wsl.exe invocation with a timeout. When the distro or
    // the LXSS service is wedged (Ubuntu first-run state, Windows update
    // pending, etc.) wsl.exe produces no output and never exits; without
    // this the whole sidecar spawn flow stalls the app forever.
    const timeoutMs = opts.timeoutMs ?? DEFAULT_WSL_TIMEOUT_MS
    const timeoutId = setTimeout(() => {
      try {
        child.kill()
      } catch {
        /* ignore */
      }
      reject(new Error(`${command} ${args.join(" ")} timed out after ${timeoutMs}ms`))
    }, timeoutMs)

    let stdout = ""
    let stderr = ""
    const stdoutDecoder = createOutputDecoder()
    const stderrDecoder = createOutputDecoder()

    const append = (stream: WslCommandLine["stream"], chunk: string) => {
      if (!chunk) return
      if (stream === "stdout") {
        stdout += chunk
        return
      }
      stderr += chunk
    }

    child.stdout.on("data", (chunk: Buffer) => {
      append("stdout", stdoutDecoder.decode(chunk))
    })
    child.stdout.on("end", () => {
      append("stdout", stdoutDecoder.flush())
    })

    child.stderr.on("data", (chunk: Buffer) => {
      append("stderr", stderrDecoder.decode(chunk))
    })
    child.stderr.on("end", () => {
      append("stderr", stderrDecoder.flush())
    })

    child.once("error", (error) => {
      clearTimeout(timeoutId)
      reject(error)
    })
    child.once("close", (code, signal) => {
      clearTimeout(timeoutId)
      resolve({ code, signal, stdout, stderr })
    })
  })
}

function runInteractiveCommand(command: string, args: string[], opts: RunWslOptions = {}, defaultTimeoutMs: number) {
  return new Promise<WslCommandResult>((resolve, reject) => {
    const child = pty.spawn(command, args, {
      name: "xterm-color",
      cols: 80,
      rows: 24,
      cwd: process.cwd(),
      env: process.env,
      useConpty: true,
    })

    let settled = false
    let stdout = ""

    const cleanup = () => {
      clearTimeout(timeoutId)
      abortCleanup?.()
    }

    const timeoutMs = opts.timeoutMs ?? defaultTimeoutMs
    const timeoutId = setTimeout(() => {
      try {
        child.kill()
      } catch {
        /* ignore */
      }
      if (settled) return
      settled = true
      cleanup()
      reject(new Error(`${command} ${args.join(" ")} timed out after ${timeoutMs}ms`))
    }, timeoutMs)

    const abortHandler = () => {
      try {
        child.kill()
      } catch {
        /* ignore */
      }
      if (settled) return
      settled = true
      cleanup()
      reject(new DOMException("Aborted", "AbortError"))
    }
    const abortCleanup = opts.signal
      ? (() => {
          opts.signal?.addEventListener("abort", abortHandler, { once: true })
          return () => opts.signal?.removeEventListener("abort", abortHandler)
        })()
      : undefined

    child.onData((data: string) => {
      stdout += data
    })
    child.onExit((event: { exitCode: number }) => {
      if (settled) return
      settled = true
      cleanup()
      resolve({ code: event.exitCode, signal: null, stdout, stderr: "" })
    })
  })
}

function createOutputDecoder() {
  let decoder: TextDecoder | undefined
  return {
    decode(chunk: Buffer) {
      decoder ??= new TextDecoder(detectOutputEncoding(chunk))
      return decoder.decode(chunk, { stream: true })
    },
    flush() {
      return decoder?.decode() ?? ""
    },
  }
}

function detectOutputEncoding(chunk: Uint8Array) {
  if (chunk[0] === 0xff && chunk[1] === 0xfe) return "utf-16le"
  const pairs = Math.floor(chunk.length / 2)
  if (pairs < 2) return "utf-8"
  const oddZeroes = Array.from({ length: pairs }).filter((_, index) => chunk[index * 2 + 1] === 0).length
  const evenZeroes = Array.from({ length: pairs }).filter((_, index) => chunk[index * 2] === 0).length
  return oddZeroes >= Math.ceil(pairs / 3) && evenZeroes * 2 <= oddZeroes ? "utf-16le" : "utf-8"
}

export function runWslInDistro(args: string[], distro?: string | null, opts?: RunWslOptions) {
  return runWsl(wslArgs(args, distro), opts)
}

export type WslRegistryDistro = {
  name: string
  defaultUid: number
  state: number
  version: number
}

// Read LXSS metadata from the Windows registry. This never invokes
// wsl.exe, so it is safe to call when wsl.exe itself is wedged.
// DefaultUid === 0 on a user-oriented distro means the first-run
// "Create a default UNIX user account" step never completed.
//
// Uses a `reg query` fallback strategy because some hosts (e.g. Electron
// spawning PowerShell with certain user profiles) return nothing from the
// PowerShell registry provider; parsing `reg query` output is ugly but
// native Windows and always available.
export async function readWslDistrosFromRegistry(opts?: RunWslOptions): Promise<WslRegistryDistro[]> {
  // `reg query` prints each subkey's values in a stable format:
  //
  //   HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Lxss\{guid}
  //       DistributionName    REG_SZ    Ubuntu-24.04
  //       DefaultUid          REG_DWORD 0x0
  //       State               REG_DWORD 0x1
  //       Version             REG_DWORD 0x2
  //       ...
  const result = await runCommand(
    "reg.exe",
    ["query", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Lxss", "/s"],
    opts,
  )
  const stdout = result.stdout
  if (result.code !== 0 || !stdout) {
    return []
  }
  const blocks = stdout.split(/\r?\n\r?\n/)
  const out: WslRegistryDistro[] = []
  for (const block of blocks) {
    const header = block.match(/^(HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Lxss\\\{[^}]+\})/i)
    if (!header) continue
    const name = block.match(/^\s+DistributionName\s+REG_SZ\s+(.+?)\s*$/m)?.[1]
    if (!name) continue
    const uidHex = block.match(/^\s+DefaultUid\s+REG_DWORD\s+0x([0-9a-f]+)\s*$/im)?.[1] ?? "0"
    const stateHex = block.match(/^\s+State\s+REG_DWORD\s+0x([0-9a-f]+)\s*$/im)?.[1] ?? "0"
    const versionHex = block.match(/^\s+Version\s+REG_DWORD\s+0x([0-9a-f]+)\s*$/im)?.[1] ?? "0"
    out.push({
      name,
      defaultUid: Number.parseInt(uidHex, 16),
      state: Number.parseInt(stateHex, 16),
      version: Number.parseInt(versionHex, 16),
    })
  }
  return out
}

export function runWslSh(script: string, distro?: string | null, opts?: RunWslOptions) {
  return runWslInDistro(["sh", "-lc", script], distro, opts)
}

export async function probeWslRuntime(opts?: RunWslOptions): Promise<WslRuntimeCheck> {
  const version = await runWsl(["--version"], opts).catch((error) => ({
    code: 1,
    signal: null,
    stdout: "",
    stderr: error instanceof Error ? error.message : String(error),
  }))

  if (version.code !== 0) {
    return {
      available: false,
      version: null,
      error: summarize(version.stderr || version.stdout) || "WSL is unavailable",
    }
  }

  return {
    available: true,
    version: firstLine(version.stdout),
    error: null,
  }
}

export async function listInstalledWslDistros(opts?: RunWslOptions) {
  const result = await runWsl(["--list", "--verbose"], opts)
  if (result.code !== 0) {
    throw new Error(summarize(result.stderr || result.stdout) || "Failed to list installed WSL distros")
  }
  return parseInstalledDistros(result.stdout)
}

export async function listOnlineWslDistros(opts?: RunWslOptions) {
  const result = await runWsl(["--list", "--online"], opts)
  if (result.code !== 0) {
    throw new Error(summarize(result.stderr || result.stdout) || "Failed to list online WSL distros")
  }
  return parseOnlineDistros(result.stdout)
}

export async function installWslRuntimeElevated(opts?: RunWslOptions) {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "$process = Start-Process -FilePath 'wsl.exe' -Verb RunAs -ArgumentList @('--install','--no-distribution') -Wait -PassThru",
    "if ($null -ne $process.ExitCode) { exit $process.ExitCode }",
  ].join("; ")
  return runPowerShell(script, withTimeout(opts, DEFAULT_WSL_INSTALL_TIMEOUT_MS))
}

export async function installWslDistro(name: string, opts?: RunWslOptions) {
  return runInteractiveCommand(
    resolveSystem32Command("wsl.exe"),
    ["--install", "-d", name, "--web-download", "--no-launch"],
    withTimeout(opts, DEFAULT_WSL_INSTALL_TIMEOUT_MS),
    DEFAULT_WSL_INSTALL_TIMEOUT_MS,
  )
}

export async function installWslOpencode(version: string, distro: string, opts?: RunWslOptions) {
  return runInteractiveCommand(
    resolveSystem32Command("wsl.exe"),
    wslArgs(["bash", "-lc", `curl -fsSL https://opencode.ai/install | bash -s -- --version ${shellEscape(version)}`], distro),
    withTimeout(opts, DEFAULT_WSL_INSTALL_TIMEOUT_MS),
    DEFAULT_WSL_INSTALL_TIMEOUT_MS,
  )
}

export function wslNeedsRestart(result: WslCommandResult) {
  return /restart|reboot/i.test(`${result.stdout}\n${result.stderr}`)
}

export async function probeWslDistro(name: string, opts?: RunWslOptions): Promise<WslDistroProbe> {
  const executable = await runWslInDistro(["/bin/true"], name, opts).catch((error) => ({
    code: 1,
    signal: null,
    stdout: "",
    stderr: error instanceof Error ? error.message : String(error),
  }))
  if (executable.code !== 0) {
    return {
      name,
      canExecute: false,
      hasBash: false,
      hasCurl: false,
      error: summarize(executable.stderr || executable.stdout) || "Cannot execute commands in distro",
    }
  }

  const [bash, curl] = await Promise.all([
    runWslSh("command -v bash >/dev/null && printf yes || printf no", name, opts),
    runWslSh("command -v curl >/dev/null && printf yes || printf no", name, opts),
  ])

  return {
    name,
    canExecute: true,
    hasBash: bash.code === 0 && summarize(bash.stdout) === "yes",
    hasCurl: curl.code === 0 && summarize(curl.stdout) === "yes",
    error: null,
  }
}

async function readWslDefaultUser(distro: string, opts?: RunWslOptions) {
  const entry = (await readWslDistrosFromRegistry(opts)).find((item) => item.name === distro)
  if (!entry || entry.defaultUid === 0) return null

  const passwd = firstLine(
    (
      await runWslSh(
        [
          "if command -v getent >/dev/null 2>&1; then",
          `  getent passwd ${entry.defaultUid}`,
          "else",
          `  awk -F: '$3 == ${entry.defaultUid} { print; exit }' /etc/passwd`,
          "fi",
        ].join("\n"),
        distro,
        opts,
      )
    ).stdout,
  )
  if (!passwd) return null

  const parts = passwd.split(":")
  const username = parts[0]?.trim() ?? ""
  const home = parts[5]?.trim() ?? ""
  if (!home) return null
  return { username: username || null, home }
}

export async function resolveWslHome(distro: string, opts?: RunWslOptions) {
  return (await readWslDefaultUser(distro, opts))?.home ?? "/root"
}

function opencodeCandidate(path: string) {
  return `if [ -x ${shellEscape(path)} ]; then printf "%s\\n" ${shellEscape(path)}; fi`
}

export async function resolveWslOpencode(distro: string, opts?: RunWslOptions) {
  const command = firstLine((await runWslSh("command -v opencode 2>/dev/null || true", distro, opts)).stdout)
  if (command && !command.startsWith("/mnt/")) return command

  const home = await resolveWslHome(distro, opts)
  for (const candidate of [
    ...(home !== "/root"
      ? [
          opencodeCandidate(`${home}/.local/bin/opencode`),
          opencodeCandidate(`${home}/bin/opencode`),
          opencodeCandidate(`${home}/.opencode/bin/opencode`),
        ]
      : []),
    'if [ -x "${XDG_BIN_DIR:-$HOME/.local/bin}/opencode" ]; then printf "%s\\n" "${XDG_BIN_DIR:-$HOME/.local/bin}/opencode"; fi',
    'if [ -x "$HOME/bin/opencode" ]; then printf "%s\\n" "$HOME/bin/opencode"; fi',
    'if [ -x "$HOME/.opencode/bin/opencode" ]; then printf "%s\\n" "$HOME/.opencode/bin/opencode"; fi',
    'if [ -x "/usr/local/bin/opencode" ]; then printf "%s\\n" "/usr/local/bin/opencode"; fi',
  ]) {
    const resolved = firstLine((await runWslSh(candidate, distro, opts)).stdout)
    if (resolved) return resolved
  }

  return null
}

export async function readWslCommandVersion(command: string, distro: string, opts?: RunWslOptions) {
  const result = await runWslSh(`${shellEscape(command)} --version 2>/dev/null || true`, distro, opts)
  return firstLine(result.stdout)
}

export async function upgradeWslOpencode(target: string, command: string, distro: string, opts?: RunWslOptions) {
  return runInteractiveCommand(
    resolveSystem32Command("wsl.exe"),
    wslArgs(["bash", "-lc", `${shellEscape(command)} upgrade ${shellEscape(target)}`], distro),
    withTimeout(opts, DEFAULT_WSL_INSTALL_TIMEOUT_MS),
    DEFAULT_WSL_INSTALL_TIMEOUT_MS,
  )
}

export function openWslTerminal(distro?: string | null) {
  if (distro && !/^[a-zA-Z0-9_.-]+$/.test(distro)) {
    return Promise.reject(new Error("Invalid distro name"))
  }
  return new Promise<void>((resolve, reject) => {
    const child = spawn("cmd.exe", ["/c", "start", "", "wsl", ...(distro ? ["-d", distro] : [])], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    })
    child.once("error", reject)
    child.once("spawn", () => {
      child.unref()
      resolve()
    })
  })
}

function parseInstalledDistros(output: string) {
  return output.split(/\r?\n/g).flatMap((line) => {
    const trimmed = line.trim()
    if (!trimmed) return []
    const match = line.match(/^\s*(\*)?\s*(.*?)\s{2,}\S+\s+(\d+)\s*$/)
    if (!match) return []
    const [, marker, name, version] = match
    if (!name || /^name$/i.test(name)) return []
    return [
      {
        name: name.trim(),
        version: Number.isNaN(Number.parseInt(version, 10)) ? null : Number.parseInt(version, 10),
        isDefault: marker === "*",
      } satisfies WslInstalledDistro,
    ]
  })
}

function parseOnlineDistros(output: string) {
  return output.split(/\r?\n/g).flatMap((line) => {
    const trimmed = line.trim()
    if (!trimmed) return []
    const match = trimmed.match(/^([A-Za-z0-9._-]+)\s{2,}(.+)$/)
    if (!match) return []
    const [, name, label] = match
    if (/^name$/i.test(name)) return []
    return [{ name, label: label.trim() } satisfies WslOnlineDistro]
  })
}

function firstLine(value: string) {
  return (
    value
      .split(/\r?\n/g)
      .map((line) => line.trim())
      .find(Boolean) ?? null
  )
}

export function summarize(value: string) {
  return value
    .split(/\r?\n/g)
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n")
}

export function shellEscape(value: string) {
  return `'${value.replace(/'/g, `'"'"'`)}'`
}

function resolveSystem32Command(command: string) {
  const root = process.env.SystemRoot ?? process.env.windir
  if (!root) return command
  const resolved = join(root, "System32", command)
  return existsSync(resolved) ? resolved : command
}

function withTimeout(opts: RunWslOptions | undefined, timeoutMs: number): RunWslOptions {
  return {
    ...opts,
    timeoutMs: opts?.timeoutMs ?? timeoutMs,
  }
}
