// Debug-only instrumentation for the recursive cleanNode crash
// ("Cannot read properties of null (reading '1')" at node.owned[i]).
//
// The crash stack has ~150 pure cleanNode frames with no cleanup frame
// between them, so the null assignment doesn't happen live during the
// crashing call. Something earlier (an earlier cleanup or earlier cascade)
// nulled an owner's .owned while it was still referenced from another
// computation's owned list, and the later cleanNode recursion walks into it.
//
// To find that, we:
//   1. Install an accessor trap via DEV.hooks.afterCreateOwner that records
//      every owned = <arr|null> mutation with a tag, a short stack, and
//      whether a cleanup was currently running. Pushed into a ring buffer.
//   2. On any uncaught TypeError we dump the ring buffer to the console.
//   3. Attach a __solidTag to every owner so we can correlate.
//
// The module must be imported before anything else touches solid-js so the
// first owner created (the render root) is instrumented.

import { DEV } from "solid-js"

type CleanupEntry = { originFrames: string[]; runAtFrames: string[] }
type OwnedEvent = {
  ts: number
  ownerTag: number
  action: "set-null" | "set-array" | "initial-null"
  prevLen: number | null
  nextLen: number | null
  cleanupDepth: number
  cleanNodeFramesAbove: number
  cleanNodeFramesBelow: number
  topCleanupOrigin: string[] | null
  stackHead: string[]
}

type OwnedAccess = {
  ownerTag: number
  prop: string
  hit: boolean
  ts: number
}

declare global {
  // eslint-disable-next-line no-var
  var __SOLID_CLEANUP_STACK: CleanupEntry[]
  // eslint-disable-next-line no-var
  var __SOLID_OWNED_EVENTS: OwnedEvent[]
  // eslint-disable-next-line no-var
  var __SOLID_OWNERS_BY_TAG: Map<number, any>
  // eslint-disable-next-line no-var
  var __SOLID_DUMP_DONE: boolean
  // eslint-disable-next-line no-var
  var __SOLID_LAST_OWNED_ACCESS: OwnedAccess | null
  // eslint-disable-next-line no-var
  var __SOLID_OWNED_ACCESS_LOG: OwnedAccess[]
}

const RING_SIZE = 500
const ACCESS_LOG_SIZE = 50

globalThis.__SOLID_CLEANUP_STACK = globalThis.__SOLID_CLEANUP_STACK ?? []
globalThis.__SOLID_OWNED_EVENTS = globalThis.__SOLID_OWNED_EVENTS ?? []
globalThis.__SOLID_OWNERS_BY_TAG = globalThis.__SOLID_OWNERS_BY_TAG ?? new Map()
globalThis.__SOLID_DUMP_DONE = false
globalThis.__SOLID_LAST_OWNED_ACCESS = null
globalThis.__SOLID_OWNED_ACCESS_LOG = []

const stackFrames = (err: Error, n = 30): string[] => {
  const lines = (err.stack ?? "").split("\n")
  return lines
    .slice(1, 1 + n)
    .map((l) => l.trim())
    .filter((l) => l.startsWith("at "))
}

const isCleanNodeFrame = (f: string) => f.startsWith("at cleanNode ")
const isWrappedCleanupFrame = (f: string) => f.includes("wrappedCleanup")

const pushEvent = (ev: OwnedEvent) => {
  const buf = globalThis.__SOLID_OWNED_EVENTS
  buf.push(ev)
  if (buf.length > RING_SIZE) buf.splice(0, buf.length - RING_SIZE)
}

const wrapCleanup = (fn: Function, node: any): Function => {
  const originFrames = stackFrames(new Error("onCleanup-site"), 20)
  function wrappedCleanup(this: unknown, ...args: unknown[]) {
    const entry: CleanupEntry = {
      originFrames,
      runAtFrames: stackFrames(new Error("cleanup-run"), 15),
    }
    globalThis.__SOLID_CLEANUP_STACK.push(entry)
    try {
      return fn.apply(this, args)
    } finally {
      globalThis.__SOLID_CLEANUP_STACK.pop()
    }
  }
  ;(wrappedCleanup as any).__original = fn
  ;(wrappedCleanup as any).__originFrames = originFrames
  ;(wrappedCleanup as any).__ownerTag = node.__solidTag
  return wrappedCleanup
}

const wrapOwnedArray = (arr: any[], node: any): any[] => {
  // Proxy the owned array so we can log every numeric-index read.
  // cleanNode iterates via `node.owned[i]` — the crashing access is exactly
  // such a read that returns an index on a null array (but our owned is
  // always an array or null, never a null array access via this proxy).
  // We log what the CURRENT iteration is reading so the crash handler can
  // name the owner whose owned was just touched.
  return new Proxy(arr, {
    get(target, prop, recv) {
      if (typeof prop === "string") {
        const n = Number(prop)
        if (Number.isInteger(n) && n >= 0) {
          const entry: OwnedAccess = {
            ownerTag: node.__solidTag,
            prop,
            hit: n in target,
            ts: Date.now(),
          }
          globalThis.__SOLID_LAST_OWNED_ACCESS = entry
          const log = globalThis.__SOLID_OWNED_ACCESS_LOG
          log.push(entry)
          if (log.length > ACCESS_LOG_SIZE) log.splice(0, log.length - ACCESS_LOG_SIZE)
        }
      }
      return Reflect.get(target, prop, recv)
    },
  })
}

const wrapCleanupsArray = (arr: any[], node: any): any[] => {
  const existing = arr.slice()
  arr.length = 0
  for (const fn of existing) Array.prototype.push.call(arr, wrapCleanup(fn, node))

  const origPush = arr.push.bind(arr)
  Object.defineProperty(arr, "push", {
    configurable: true,
    writable: true,
    value: (...fns: Function[]) => {
      const wrapped = fns.map((fn) => wrapCleanup(fn, node))
      return origPush(...wrapped)
    },
  })
  return arr
}

if (DEV?.hooks) {
  let tagCounter = 0
  const prev = DEV.hooks.afterCreateOwner
  DEV.hooks.afterCreateOwner = (node: any) => {
    if (prev) prev(node)
    if (node.__solidTag !== undefined) return
    node.__solidTag = ++tagCounter
    globalThis.__SOLID_OWNERS_BY_TAG.set(node.__solidTag, node)
    try {
      node.__createdAtFrames = stackFrames(new Error("owner-created"), 12)
    } catch {
      /* ignore */
    }

    let ownedValue: any[] | null = Array.isArray(node.owned) ? wrapOwnedArray(node.owned, node) : (node.owned ?? null)
    Object.defineProperty(node, "owned", {
      configurable: true,
      enumerable: true,
      get() {
        return ownedValue
      },
      set(v: any[] | null) {
        const prevArr = ownedValue
        if (Array.isArray(v)) v = wrapOwnedArray(v, node)
        // Record every owned mutation so we can post-hoc trace corruption.
        const frames = stackFrames(new Error("owned-set"), 30)
        const wrappedIdx = frames.findIndex(isWrappedCleanupFrame)
        const cleanupDepth = globalThis.__SOLID_CLEANUP_STACK.length
        pushEvent({
          ts: Date.now(),
          ownerTag: node.__solidTag,
          action: prevArr == null && v == null ? "initial-null" : v == null ? "set-null" : "set-array",
          prevLen: prevArr == null ? null : prevArr.length,
          nextLen: v == null ? null : v.length,
          cleanupDepth,
          cleanNodeFramesAbove: wrappedIdx >= 0 ? frames.slice(wrappedIdx + 1).filter(isCleanNodeFrame).length : 0,
          cleanNodeFramesBelow:
            wrappedIdx >= 0
              ? frames.slice(0, wrappedIdx).filter(isCleanNodeFrame).length
              : frames.filter(isCleanNodeFrame).length,
          topCleanupOrigin: cleanupDepth > 0 ? globalThis.__SOLID_CLEANUP_STACK[cleanupDepth - 1]!.originFrames : null,
          stackHead: frames.slice(0, 8),
        })
        ownedValue = v
      },
    })

    let cleanupsValue: any[] | null = node.cleanups ?? null
    if (Array.isArray(cleanupsValue)) cleanupsValue = wrapCleanupsArray(cleanupsValue, node)
    Object.defineProperty(node, "cleanups", {
      configurable: true,
      enumerable: true,
      get() {
        return cleanupsValue
      },
      set(v: any[] | null) {
        if (Array.isArray(v)) {
          cleanupsValue = wrapCleanupsArray(v, node)
        } else {
          cleanupsValue = v
        }
      },
    })
  }
  try {
    console.log("[solid-instrument] installed afterCreateOwner hook")
  } catch {
    /* ignore */
  }
}

// When the cleanNode TypeError fires, dump everything we've recorded so we
// can see which owners had their .owned nulled in the moments just before
// the crash. Install at capture phase so we run before any other handler.
const dumpOwnedHistory = (label: string) => {
  if (globalThis.__SOLID_DUMP_DONE) return
  globalThis.__SOLID_DUMP_DONE = true
  try {
    const events = globalThis.__SOLID_OWNED_EVENTS
    // Last 20 events + last 15 set-null events are plenty for correlation.
    const tail = events.slice(-20)
    const nulls = events.filter((e) => e.action === "set-null").slice(-15)
    const lastAccess = globalThis.__SOLID_LAST_OWNED_ACCESS
    const accessLog = globalThis.__SOLID_OWNED_ACCESS_LOG.slice(-25)

    // Pull the ownerTag the crash was iterating and see if that tag was
    // set-null'd in the recent events ring. That is the smoking gun.
    const suspectTag = lastAccess?.ownerTag
    const suspectNull =
      suspectTag != null ? events.filter((e) => e.ownerTag === suspectTag && e.action === "set-null") : []

    console.error(
      `[${label}] SUSPECT OWNER AT CRASH:`,
      JSON.stringify(
        {
          lastOwnedAccess: lastAccess,
          suspectTag,
          suspectOwnerCreatedAt:
            suspectTag != null ? globalThis.__SOLID_OWNERS_BY_TAG.get(suspectTag)?.__createdAtFrames : null,
          suspectSetNullEvents: suspectNull,
        },
        null,
        2,
      ),
    )
    console.error(`[${label}] last ${accessLog.length} owned[i] accesses:`, JSON.stringify(accessLog, null, 2))
    console.error(`[${label}] last ${nulls.length} set-null events:`, JSON.stringify(nulls, null, 2))
    console.error(`[${label}] last ${tail.length} owned mutation events:`, JSON.stringify(tail, null, 2))
  } catch (e) {
    console.error(`[${label}] dump failed`, e)
  }
}

window.addEventListener(
  "error",
  (ev) => {
    const msg = (ev.error && ev.error.message) || ev.message || ""
    if (typeof msg === "string" && msg.includes("Cannot read properties of null")) {
      dumpOwnedHistory("SOLID CLEANNODE CRASH")
    }
  },
  true,
)

export {}
