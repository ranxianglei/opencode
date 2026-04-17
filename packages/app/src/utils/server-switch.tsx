import { createSignal } from "solid-js"

// Global flag used to paint a full-window splash overlay while a server
// swap is in progress. ServerKey's keyed <Show> remount is a big
// synchronous cascade (dispose + remount of the entire app subtree) that
// can freeze the UI for several seconds; setting this true before the
// swap and false after lets us render an overlay above the ServerKey
// boundary so the freeze has visual feedback instead of looking stuck.
export const [serverSwitching, setServerSwitching] = createSignal(false)
