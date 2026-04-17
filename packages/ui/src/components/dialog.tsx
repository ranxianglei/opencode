import { Dialog as Kobalte } from "@kobalte/core/dialog"
import { ComponentProps, createEffect, JSXElement, Match, ParentProps, Show, Switch, useContext } from "solid-js"
import { useI18n } from "../context/i18n"
import { DialogContext } from "../context/dialog"
import { IconButton } from "./icon-button"

export interface DialogProps extends ParentProps {
  title?: JSXElement
  description?: JSXElement
  action?: JSXElement
  size?: "normal" | "large" | "x-large"
  class?: ComponentProps<"div">["class"]
  classList?: ComponentProps<"div">["classList"]
  fit?: boolean
  transition?: boolean
  // When `false`, clicking the overlay or outside the dialog will not dismiss it.
  // Default is `true`.
  dismissOutside?: boolean
}

export function Dialog(props: DialogProps) {
  const i18n = useI18n()
  const dialogCtx = useContext(DialogContext)
  createEffect(() => {
    if (!dialogCtx) return
    if (props.dismissOutside === undefined) return
    dialogCtx.active?.setDismissOutside(props.dismissOutside)
  })
  return (
    <div
      data-component="dialog"
      data-fit={props.fit ? true : undefined}
      data-size={props.size || "normal"}
      data-transition={props.transition ? true : undefined}
    >
      <div data-slot="dialog-container">
        <Kobalte.Content
          data-slot="dialog-content"
          data-no-header={!props.title && !props.action ? "" : undefined}
          classList={{
            ...props.classList,
            [props.class ?? ""]: !!props.class,
          }}
          onOpenAutoFocus={(e) => {
            const target = e.currentTarget as HTMLElement | null
            const autofocusEl = target?.querySelector("[autofocus]") as HTMLElement | null
            if (autofocusEl) {
              e.preventDefault()
              autofocusEl.focus()
            }
          }}
        >
          <Show when={props.title || props.action}>
            <div data-slot="dialog-header">
              <Show when={props.title}>
                <Kobalte.Title data-slot="dialog-title">{props.title}</Kobalte.Title>
              </Show>
              <Switch>
                <Match when={props.action}>{props.action}</Match>
                <Match when={true}>
                  <Kobalte.CloseButton
                    data-slot="dialog-close-button"
                    as={IconButton}
                    icon="close"
                    variant="ghost"
                    aria-label={i18n.t("ui.common.close")}
                  />
                </Match>
              </Switch>
            </div>
          </Show>
          <Show when={props.description}>
            <Kobalte.Description data-slot="dialog-description" style={{ "margin-left": "-4px" }}>
              {props.description}
            </Kobalte.Description>
          </Show>
          <div data-slot="dialog-body">{props.children}</div>
        </Kobalte.Content>
      </div>
    </div>
  )
}
