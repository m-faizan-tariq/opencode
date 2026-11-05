import { createMemo, lazy, onCleanup, Show, Suspense } from "solid-js"
import { Icon } from "@opencode/ui/icon"
import { IconButton } from "@opencode/ui/icon-button"
import { Keybind } from "@opencode/ui/keybind"
import { Tooltip } from "@opencode/ui/tooltip"
import { Command, MenuItem, Slot, type Plugin } from "@opencode/plugin/gui"
import { BuiltinPanel, onIdle, type BuiltinPanelTab } from "@opencode/plugin/gui/builtin"
import type definition from "./index"

const TAB = "board"
const KEY = `kanban:${TAB}`

const setup: Plugin.Setup<typeof definition> = (ctx) => {
  // The board is a desktop feature: the phone reaches the same cards through Telegram and `/note`.
  if (ctx.app.platform !== "desktop") return

  const Board = lazy(() => import("./panel"))
  // Compile the panel while the app idles, so the first open renders at once.
  onCleanup(onIdle(() => void Board.preload()))

  const sessions = ctx.sessions
  const layout = ctx.layout
  const keybinds = ctx.keybinds

  // One tab object for every session, so a session switch never renders its trigger again.
  const tab: BuiltinPanelTab = {
    id: TAB,
    get title() {
      return ctx.t("tab.title")
    },
    draggable: false,
    closable: "compact",
    first: true,
    fallback: true,
    dom: { tab: "session-side-panel-kanban-tab", panel: "session-side-panel-kanban-tabpanel" },
  }

  ctx.add(BuiltinPanel, {
    id: TAB,
    region: "side",
    list: (input) => (input.open.includes(TAB) ? [tab] : []),
    closed: () => ({ title: ctx.t("tab.title"), icon: "grid-plus" as const }),
    render: (props) => (
      <Suspense>
        <Board session={props.session} />
      </Suspense>
    ),
  })

  const routed = createMemo(() => !!sessions.current())

  ctx.add(
    Command,
    (): Command => ({
      id: "toggle",
      title: ctx.t("command.toggle"),
      group: ctx.t("command.category.view"),
      section: "session",
      bind: "mod+shift+k",
      editable: true,
      enabled: routed() && !layout.narrow(),
      run() {
        const session = sessions.current()
        if (!session) return
        layout.toggle(KEY, session)
      },
    }),
  )

  ctx.add(MenuItem, (): MenuItem | undefined => {
    const session = sessions.current()
    if (!session || layout.narrow()) return undefined

    return {
      menu: "session.panel",
      id: "open",
      title: ctx.t("tab.title"),
      icon: "grid-plus",
      keybind: "kanban.toggle",
      order: 30,
      run() {
        layout.open(KEY, session, { tab: "select" })
      },
    }
  })

  const keybind = () => [...keybinds.keybind("kanban.toggle")]

  ctx.add(Slot, {
    at: "session.header",
    order: 15,
    render: (input) => {
      const visible = () => layout.state(KEY, input.session) === "visible"

      return (
        <Show when={!layout.narrow() && input.session.id}>
          <Tooltip
            placement="bottom"
            value={
              <>
                {ctx.t("command.toggle")}
                <Show when={keybind().length > 0}>
                  <Keybind keys={keybind()} variant="neutral" />
                </Show>
              </>
            }
          >
            <IconButton
              type="button"
              icon={<Icon name="grid-plus" />}
              variant="ghost-muted"
              size="large"
              state={visible() ? "pressed" : undefined}
              aria-label={ctx.t("command.toggle")}
              aria-expanded={visible()}
              aria-controls="kanban-panel"
              onClick={() => layout.toggle(KEY, input.session)}
            />
          </Tooltip>
        </Show>
      )
    },
  })
}

export default setup
