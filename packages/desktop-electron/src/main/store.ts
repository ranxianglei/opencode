import Store from "electron-store"

import { SETTINGS_STORE } from "./constants"

const cache = new Map<string, Store>()

// IMPORTANT: do NOT construct Store at module import time. electron-store
// resolves `app.getPath("userData")` in its constructor, but our index.ts
// only calls `app.setName` / `app.setPath("userData", ...)` AFTER module
// imports finish. Constructing eagerly wrote settings (e.g. the WSL server
// config) to the default `%APPDATA%\@opencode-ai\desktop-electron` folder
// instead of the proper `...desktop.dev` / channel dir.
export function getStore(name = SETTINGS_STORE) {
  const cached = cache.get(name)
  if (cached) return cached
  const next = new Store({ name, fileExtension: "", accessPropertiesByDotNotation: false })
  cache.set(name, next)
  return next
}
