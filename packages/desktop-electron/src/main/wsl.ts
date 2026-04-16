import { spawn } from "node:child_process"
import type {
  LocalServerDistroProbe,
  LocalServerInstalledDistro,
  LocalServerOnlineDistro,
  LocalServerWslCheck,
} from "../preload/types"

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

type RunWslOptions = {
  onLine?: (line: WslCommandLine) => void
  signal?: AbortSignal
}

export function wslArgs(args: string[], distro?: string | null) {
  if (distro) return ["-d", distro, "--", ...args]
  return ["--", ...args]
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

    let stdout = ""
    let stderr = ""
    let stdoutPending = ""
    let stderrPending = ""

    const flush = (stream: WslCommandLine["stream"], pending: string) => {
      if (!pending) return ""
      opts.onLine?.({ stream, text: pending })
      return ""
    }

    child.stdout.setEncoding("utf8")
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk
      stdoutPending += chunk
      const lines = stdoutPending.split(/\r?\n/g)
      stdoutPending = lines.pop() ?? ""
      for (const line of lines) opts.onLine?.({ stream: "stdout", text: line })
    })
    child.stdout.on("end", () => {
      stdoutPending = flush("stdout", stdoutPending)
    })

    child.stderr.setEncoding("utf8")
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk
      stderrPending += chunk
      const lines = stderrPending.split(/\r?\n/g)
      stderrPending = lines.pop() ?? ""
      for (const line of lines) opts.onLine?.({ stream: "stderr", text: line })
    })
    child.stderr.on("end", () => {
      stderrPending = flush("stderr", stderrPending)
    })

    child.once("error", reject)
    child.once("close", (code, signal) => {
      resolve({ code, signal, stdout, stderr })
    })
  })
}

export function runWslInDistro(args: string[], distro?: string | null, opts?: RunWslOptions) {
  return runWsl(wslArgs(args, distro), opts)
}

export function runWslSh(script: string, distro?: string | null, opts?: RunWslOptions) {
  return runWslInDistro(["sh", "-lc", script], distro, opts)
}

export function runWslBash(script: string, distro?: string | null, opts?: RunWslOptions) {
  return runWslInDistro(["bash", "-lc", script], distro, opts)
}

export async function probeWslRuntime(opts?: RunWslOptions): Promise<LocalServerWslCheck> {
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
      status: null,
      error: summarize(version.stderr || version.stdout) || "WSL is unavailable",
    }
  }

  const status = await runWsl(["--status"], opts).catch(() => undefined)
  return {
    available: true,
    version: firstLine(version.stdout),
    status: status?.code === 0 ? summarize(status.stdout) : null,
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

export async function installWslRuntime(opts?: RunWslOptions) {
  return runWsl(["--install", "--no-distribution"], opts)
}

export async function installWslRuntimeElevated(opts?: RunWslOptions) {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "$process = Start-Process -FilePath 'wsl.exe' -Verb RunAs -ArgumentList @('--install','--no-distribution') -Wait -PassThru",
    "if ($null -ne $process.ExitCode) { exit $process.ExitCode }",
  ].join("; ")
  return runPowerShell(script, opts)
}

export async function installWslDistro(name: string, opts?: RunWslOptions) {
  return runWsl(["--install", "-d", name, "--web-download", "--no-launch"], opts)
}

export async function installWslOpencode(version: string, distro: string, opts?: RunWslOptions) {
  return runWslBash(
    `curl -fsSL https://opencode.ai/install | bash -s -- --version ${shellEscape(version)}`,
    distro,
    opts,
  )
}

export function wslNeedsRestart(result: WslCommandResult) {
  return /restart|reboot/i.test(`${result.stdout}\n${result.stderr}`)
}

export async function probeWslDistro(name: string, opts?: RunWslOptions): Promise<LocalServerDistroProbe> {
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
      username: null,
      isRoot: null,
      error: summarize(executable.stderr || executable.stdout) || "Cannot execute commands in distro",
    }
  }

  const [bash, curl, user] = await Promise.all([
    runWslSh("command -v bash >/dev/null && printf yes || printf no", name, opts),
    runWslSh("command -v curl >/dev/null && printf yes || printf no", name, opts),
    runWslSh("id -un 2>/dev/null || true", name, opts),
  ])

  const username = summarize(user.stdout)
  return {
    name,
    canExecute: true,
    hasBash: bash.code === 0 && summarize(bash.stdout) === "yes",
    hasCurl: curl.code === 0 && summarize(curl.stdout) === "yes",
    username: username || null,
    isRoot: username ? username === "root" : null,
    error: null,
  }
}

export async function resolveWslCommand(command: string, distro: string, opts?: RunWslOptions) {
  const result = await runWslSh(`command -v ${shellEscape(command)} 2>/dev/null || true`, distro, opts)
  return summarize(result.stdout) || null
}

export async function readWslCommandVersion(command: string, distro: string, opts?: RunWslOptions) {
  const result = await runWslSh(`${shellEscape(command)} --version 2>/dev/null || true`, distro, opts)
  return firstLine(result.stdout)
}

export async function upgradeWslOpencode(target: string, distro: string, opts?: RunWslOptions) {
  return runWslBash(`opencode upgrade ${shellEscape(target)}`, distro, opts)
}

export function openWslTerminal(distro?: string | null) {
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
    const match = line.match(/^\s*(\*)?\s*(.*?)\s{2,}(\S+)\s+(\d+)\s*$/)
    if (!match) return []
    const [, marker, name, state, version] = match
    if (!name || /^name$/i.test(name)) return []
    return [
      {
        name: name.trim(),
        state: state || null,
        version: Number.isNaN(Number.parseInt(version, 10)) ? null : Number.parseInt(version, 10),
        isDefault: marker === "*",
      } satisfies LocalServerInstalledDistro,
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
    return [{ name, label: label.trim() } satisfies LocalServerOnlineDistro]
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

function summarize(value: string) {
  return value
    .split(/\r?\n/g)
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n")
}

function shellEscape(value: string) {
  return `'${value.replace(/'/g, `'"'"'`)}'`
}
