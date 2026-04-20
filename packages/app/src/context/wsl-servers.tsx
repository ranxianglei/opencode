import { createSimpleContext } from "@opencode-ai/ui/context"
import { queryOptions, skipToken, useQuery, useQueryClient } from "@tanstack/solid-query"
import { createEffect, onCleanup } from "solid-js"
import type { WslServersPlatform, WslServersState } from "./platform"
import { usePlatform } from "./platform"

export const wslServersQueryKey = ["platform", "wslServers"] as const

export function wslServersQueryOptions(api: WslServersPlatform | undefined) {
  return queryOptions<WslServersState>({
    queryKey: wslServersQueryKey,
    queryFn: api ? () => api.getState() : skipToken,
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: Number.POSITIVE_INFINITY,
  })
}

export const { use: useWslServers, provider: WslServersProvider } = createSimpleContext({
  name: "WslServers",
  init: () => {
    const platform = usePlatform()
    const queryClient = useQueryClient()
    const query = useQuery(() => ({ ...wslServersQueryOptions(platform.wslServers) }))

    createEffect(() => {
      const api = platform.wslServers
      if (!api) return
      const off = api.subscribe((event) => {
        queryClient.setQueryData(wslServersQueryKey, event.state)
      })
      onCleanup(off)
    })

    return query
  },
})
