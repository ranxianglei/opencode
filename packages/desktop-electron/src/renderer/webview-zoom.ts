// Copyright 2019-2024 Tauri Programme within The Commons Conservancy
// SPDX-License-Identifier: Apache-2.0
// SPDX-License-Identifier: MIT

import { createSignal } from "solid-js"

const OS_NAME = (() => {
  if (navigator.userAgent.includes("Mac")) return "macos"
  if (navigator.userAgent.includes("Windows")) return "windows"
  if (navigator.userAgent.includes("Linux")) return "linux"
  return "unknown"
})()

const MIN_ZOOM = 0.2
const MAX_ZOOM = 10
const KEY_STEP = 0.2
const WHEEL_STEP = 0.1

const clamp = (value: number) => Math.min(Math.max(value, MIN_ZOOM), MAX_ZOOM)

const [webviewZoom, setWebviewZoom] = createSignal(1)

const apply = (next: number) => {
  const clamped = clamp(next)
  if (Math.abs(clamped - webviewZoom()) < 1e-6) return
  setWebviewZoom(clamped)
  void window.api.setZoomFactor(clamped).catch(() => undefined)
}

export const zoomIn = () => apply(webviewZoom() + KEY_STEP)
export const zoomOut = () => apply(webviewZoom() - KEY_STEP)
export const zoomReset = () => apply(1)

// Seed the signal from the main process so renderer and webContents agree
// across cold starts, reloads, and HMR refreshes (which would otherwise
// reinitialize the signal to 1 while webContents kept its prior factor).
void window.api
  .getZoomFactor()
  .then((initial) => {
    if (typeof initial === "number" && Number.isFinite(initial)) {
      setWebviewZoom(clamp(initial))
    }
  })
  .catch(() => undefined)

// Keyboard accelerators. preventDefault stops Chromium's built-in zoom
// accelerators from firing in parallel (which previously caused races).
window.addEventListener("keydown", (event) => {
  const mod = OS_NAME === "macos" ? event.metaKey : event.ctrlKey
  if (!mod || event.altKey) return

  if (event.key === "-" || event.key === "_") {
    event.preventDefault()
    zoomOut()
    return
  }
  if (event.key === "=" || event.key === "+") {
    event.preventDefault()
    zoomIn()
    return
  }
  if (event.key === "0") {
    event.preventDefault()
    zoomReset()
    return
  }
})

// Wheel zoom. Chromium synthesizes `wheel` with `ctrlKey: true` for trackpad
// pinch on every platform, so checking ctrlKey uniformly covers pinch-to-zoom
// as well as real ctrl+scroll / cmd+scroll.
window.addEventListener(
  "wheel",
  (event) => {
    if (!event.ctrlKey && !event.metaKey) return
    event.preventDefault()
    const step = event.deltaY > 0 ? -WHEEL_STEP : WHEEL_STEP
    apply(webviewZoom() + step)
  },
  { passive: false },
)

export { webviewZoom }
