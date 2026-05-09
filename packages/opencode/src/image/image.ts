import { Config } from "@/config/config"
import type { MessageV2 } from "@/session/message-v2"
import { Context, Effect, Layer } from "effect"
import fs from "fs"

import photonWasm from "@silvia-odwyer/photon-node/photon_rs_bg.wasm" with { type: "file" }

export const MAX_BASE64_BYTES = 4.5 * 1024 * 1024
export const MAX_WIDTH = 2000
export const MAX_HEIGHT = 2000
export const AUTO_RESIZE = true
const JPEG_QUALITIES = [80, 85, 70, 55, 40]

type Photon = typeof import("@silvia-odwyer/photon-node")

let photonModule: Photon | null = null
let photonPromise: Promise<Photon | null> | null = null

function loadPhoton() {
  if (photonModule) return Promise.resolve(photonModule)
  if (photonPromise) return photonPromise

  photonPromise = (async () => {
    const original = fs.readFileSync
    fs.readFileSync = ((file: fs.PathOrFileDescriptor, options?: Parameters<typeof fs.readFileSync>[1]) => {
      if (typeof file === "string" && file.endsWith("photon_rs_bg.wasm")) return original(photonWasm, options)
      return original(file, options)
    }) as typeof fs.readFileSync
    try {
      photonModule = await import("@silvia-odwyer/photon-node")
      return photonModule
    } catch {
      photonModule = null
      return null
    } finally {
      fs.readFileSync = original
    }
  })()

  return photonPromise
}

export interface Info {
  autoResize: boolean
  maxWidth: number
  maxHeight: number
  maxBase64Bytes: number
}

export interface Interface {
  readonly get: () => Effect.Effect<Info>
  readonly checkBase64Size: (input: string) => Effect.Effect<{ ok: boolean; bytes: number }>
  readonly sanitize: (input: MessageV2.FilePart) => Effect.Effect<MessageV2.FilePart>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Image") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service

    const get = Effect.fn("Image.get")(function* () {
      const image = (yield* config.get()).attachment?.image
      return {
        autoResize: image?.auto_resize ?? AUTO_RESIZE,
        maxWidth: image?.max_width ?? MAX_WIDTH,
        maxHeight: image?.max_height ?? MAX_HEIGHT,
        maxBase64Bytes: image?.max_base64_bytes ?? MAX_BASE64_BYTES,
      }
    })

    const checkBase64Size = Effect.fn("Image.checkBase64Size")(function* (input: string) {
      const bytes = Buffer.byteLength(input, "utf8")
      return {
        ok: bytes <= (yield* get()).maxBase64Bytes,
        bytes,
      }
    })

    const sanitize = Effect.fn("Image.sanitize")(function* (input: MessageV2.FilePart) {
      const info = yield* get()
      if (!info.autoResize) return input
      if (!input.url.startsWith("data:") || !input.url.includes(";base64,")) return input
      const data = input.url.slice(input.url.indexOf(";base64,") + ";base64,".length)

      const photon = yield* Effect.promise(loadPhoton)
      if (!photon) return input

      const image = yield* Effect.sync(() => {
        try {
          return photon.PhotonImage.new_from_byteslice(Buffer.from(data, "base64"))
        } catch {
          return undefined
        }
      })
      if (!image) return input

      try {
        const originalWidth = image.get_width()
        const originalHeight = image.get_height()
        if (
          originalWidth <= info.maxWidth &&
          originalHeight <= info.maxHeight &&
          Buffer.byteLength(data, "utf8") <= info.maxBase64Bytes
        )
          return input

        const scale = Math.min(1, info.maxWidth / originalWidth, info.maxHeight / originalHeight)
        let current = {
          width: Math.max(1, Math.round(originalWidth * scale)),
          height: Math.max(1, Math.round(originalHeight * scale)),
        }

        while (true) {
          const resized = photon.resize(image, current.width, current.height, photon.SamplingFilter.Lanczos3)
          const candidate = [
            { data: Buffer.from(resized.get_bytes()).toString("base64"), mime: "image/png" },
            ...JPEG_QUALITIES.map((quality) => ({
              data: Buffer.from(resized.get_bytes_jpeg(quality)).toString("base64"),
              mime: "image/jpeg",
            })),
          ]
            .map((item) => ({ ...item, bytes: Buffer.byteLength(item.data, "utf8") }))
            .filter((item) => item.bytes <= info.maxBase64Bytes)
            .sort((a, b) => a.bytes - b.bytes)[0]
          resized.free()

          if (candidate)
            return {
              ...input,
              mime: candidate.mime,
              url: `data:${candidate.mime};base64,${candidate.data}`,
            }

          const next = {
            width: current.width === 1 ? 1 : Math.max(1, Math.floor(current.width * 0.75)),
            height: current.height === 1 ? 1 : Math.max(1, Math.floor(current.height * 0.75)),
          }
          if (next.width === current.width && next.height === current.height) return input
          current = next
        }
      } finally {
        image.free()
      }
    })

    return Service.of({ get, checkBase64Size, sanitize })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(Config.defaultLayer))

export * as Image from "./image"
