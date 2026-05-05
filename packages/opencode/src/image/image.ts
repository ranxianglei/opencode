import { Config } from "@/config/config"
import type { MessageV2 } from "@/session/message-v2"
import { Context, Effect, Layer } from "effect"

export const MAX_BASE64_BYTES = 4.5 * 1024 * 1024
export const MAX_WIDTH = 2000
export const MAX_HEIGHT = 2000
export const AUTO_RESIZE = true

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
      return input
    })

    return Service.of({ get, checkBase64Size, sanitize })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(Config.defaultLayer))

export * as Image from "./image"
