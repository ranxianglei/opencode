/** @ts-expect-error */
import * as pty from "@lydell/node-pty"
import type { RunWslOptions, WslCommandResult } from "./wsl"

export function runInteractiveCommand(
  command: string,
  args: string[],
  opts: RunWslOptions = {},
  defaultTimeoutMs: number,
) {
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
    const parser = createInteractiveOutputParser((text) => opts.onLine?.({ stream: "stdout", text }))
    let stdout = ""

    const cleanup = () => {
      clearTimeout(timeoutId)
      abortCleanup?.()
      parser.flush()
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
      parser.write(data)
    })
    child.onExit((event: { exitCode: number }) => {
      if (settled) return
      settled = true
      cleanup()
      resolve({ code: event.exitCode, signal: null, stdout, stderr: "" })
    })
  })
}

function createInteractiveOutputParser(onLine: (line: string) => void) {
  let line = ""
  let escape = ""
  let lastProgress = ""

  const emit = (value: string) => {
    const text = value.trim()
    if (!text) return
    if (/(\d{1,3}(?:[.,]\d+)?)\s*%/.test(text)) {
      if (text === lastProgress) return
      lastProgress = text
    }
    onLine(text)
  }

  return {
    write(chunk: string) {
      for (const char of chunk) {
        if (escape) {
          escape += char
          const isCsi = escape.startsWith("\u001b[")
          const isOsc = escape.startsWith("\u001b]")
          if ((isCsi && /[@-~]/.test(char)) || (isOsc && char === "\u0007") || escape.endsWith("\u001b\\")) {
            escape = ""
          } else if (!isCsi && !isOsc && escape.length > 1) {
            escape = ""
          }
          continue
        }
        if (char === "\u001b") {
          escape = "\u001b"
          continue
        }
        if (char === "\b" || char === "\u007f") {
          line = line.slice(0, -1)
          continue
        }
        if (char === "\r" || char === "\n") {
          emit(line)
          line = ""
          continue
        }
        line += char
        if (/(\d{1,3}(?:[.,]\d+)?)\s*%/.test(line)) emit(line)
      }
    },
    flush() {
      emit(line)
      line = ""
    },
  }
}
