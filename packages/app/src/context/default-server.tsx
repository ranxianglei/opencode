import { showToast } from "@opencode-ai/ui/toast"
import { queryOptions, skipToken, useMutation, useQuery, useQueryClient } from "@tanstack/solid-query"
import { useLanguage } from "./language"
import { usePlatform } from "./platform"
import { ServerConnection } from "./server"

const defaultServerQueryKey = ["platform", "defaultServer"] as const

function defaultServerQueryOptions(getDefaultServer: ReturnType<typeof usePlatform>["getDefaultServer"]) {
  return queryOptions<ServerConnection.Key | null>({
    queryKey: defaultServerQueryKey,
    queryFn: getDefaultServer
      ? () => getDefaultServer().then((next) => (next ? ServerConnection.Key.make(next) : null))
      : skipToken,
    staleTime: Number.POSITIVE_INFINITY,
  })
}

export function useDefaultServer() {
  const language = useLanguage()
  const platform = usePlatform()
  const queryClient = useQueryClient()
  const query = useQuery(() => ({ ...defaultServerQueryOptions(platform.getDefaultServer) }))
  const mutation = useMutation(() => ({
    mutationFn: async (key: ServerConnection.Key | null) => {
      if (!platform.setDefaultServer) return key
      await platform.setDefaultServer(key)
      return key
    },
    onSuccess: (key) => {
      queryClient.setQueryData(defaultServerQueryKey, key)
    },
    onError: (err) => {
      showToast({
        variant: "error",
        title: language.t("common.requestFailed"),
        description: err instanceof Error ? err.message : String(err),
      })
    },
  }))

  return {
    canDefault: () => !!platform.getDefaultServer && !!platform.setDefaultServer,
    defaultKey: () => query.data ?? null,
    query,
    setDefault(key: ServerConnection.Key | null) {
      if (!platform.setDefaultServer) return Promise.resolve(key)
      return mutation.mutateAsync(key)
    },
  }
}
