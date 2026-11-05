# @opencode/plugin-kanban

A persistent Kanban board for OpenCode, with a capture-to-review pipeline.

A task arrives from your phone — a Telegram message, or `/note` typed into the OpenCode
web app — an agent starts on it without you asking, and when it has something to show the
card moves to `review`. Every card is a door into the session that did the work, so you can
read what happened and keep going in that same session. Typing in a linked session moves
its card back to `working`.

## What it does

- Five columns: `backlog`, `todo`, `working`, `review`, `done`.
- Capture a task from your phone and an agent starts on it without you asking.
- When the agent finishes, the card moves to `review` with its report.
- Click a card to open the session that worked on it and keep going there.
- Type in a linked session and its card moves to `working` again.
- The side panel updates live, including when a card moves because you typed.

## Setup

The board is on by default. Nothing to install.

### Capture from Telegram

```bash
export KANBAN_TELEGRAM_TOKEN="123456:ABC..."
export KANBAN_TELEGRAM_CHATS="123456789"   # your chat id
```

Message the bot and it replies with the card id. The bot long-polls, so no public URL is
needed. Send `/start` to it and it tells you what to put in `KANBAN_TELEGRAM_CHATS`.

`KANBAN_TELEGRAM_CHATS` is an allowlist. Empty or unset allowlists nothing — the bot
refuses every chat rather than accepting all of them.

### Capture from your phone

Install the OpenCode web app as a PWA, then type:

```
/note Research the best standing desks under £300
```

### Worker model

By default the worker session uses your session's agent and model. Override either:

```bash
export KANBAN_WORKER_AGENT="build"                          # optional
export KANBAN_WORKER_MODEL="anthropic/claude-sonnet-4-5"    # optional
```

## Where the board lives

The board is per-project, and it is the project root that matters, not the directory you
happened to open:

- Inside a git repo: `<repo-root>/.opencode/kanban.json`
- Everywhere else: `~/.opencode/kanban.json`

Two sessions in the same repo share one board even when they are in different
subdirectories.

Telegram has no project, so a Telegram capture resolves the board from your home
directory and lands on the global `~/.opencode/kanban.json` — even when OpenCode is
running inside a repo.

## Tools

`kanban_add`, `kanban_move`, `kanban_list`, `kanban_update`, `kanban_delete`.

`kanban_add` adds a card without starting work. Capture from Telegram or `/note` to create
a card *and* start work.

## Commands

- `/kanban` — show the board (`list` and `show` work too)
- `/kanban add <title>` — add a card
- `/kanban move|update|delete …`
- `/note <text>` — capture and start work

## How a captured task flows

1. The note becomes a card in `todo`, and a worker session is created in the project the
   card lives on.
2. The prompt hook sees the worker session is linked, so the card moves to `working`.
3. When the run ends, the agent's final reply is stored as the card's `result` and the card
   moves to `review`.
4. Read the report, then click the card to open the session that produced it and keep going
   there.

## The side panel

On desktop, once a session is open, you can open the `Kanban` board for the routed
session's project in any of four ways:

- Click the **Toggle Kanban** button (grid-plus icon) in the top-right session header.
- Press `Cmd+Shift+K` (`Ctrl+Shift+K` on Windows/Linux).
- Open the Command Palette (`Cmd+K` / `Ctrl+K`) and run **Toggle Kanban**.
- Open the side panel (`Toggle review`) and click `+` → **Kanban**.

The board displays the five columns (`backlog`, `todo`, `working`, `review`, `done`) for
the routed session's project. Add a task into `backlog` from the input at the top, drag a
card between columns to change its status, click `×` on a card to remove it, or click any
card with a linked `sessionID` (such as a card created via `/note` or Telegram) to open
that session directly.

Platform and session requirements:

- **Desktop-only GUI panel**: The side-panel board is only registered on desktop (`ctx.build.platform === "desktop"`). Web and mobile sessions remain intentionally free of desktop side-panel controls and interact with the board via `/kanban` and `/note` in chat.
- **Requires an active session**: Because the board is scoped to a project via the active session's directory (`session.directory`) and side-panel region, the header toggle and command are only active when a session is routed.
- **`/kanban` slash command**: `/kanban` is a backend chat command that returns a markdown summary of the board in the conversation transcript; use the **Toggle Kanban** header button or `Cmd+Shift+K` / `Ctrl+Shift+K` to open the visual side panel.

## Testing

```bash
# Backend plugin unit & integration tests (board store, ingest, lifecycle, tools, commands, telegram, rpc)
bun --cwd packages/plugin-kanban test

# GUI extension unit & contract tests
bun --cwd packages/gui-extensions test

# Browser/DOM tests for the Kanban renderer, header toggle, command, + menu, board CRUD, and session navigation
cd packages/app && bun test --conditions=browser --isolate --preload ../ui/test/solid-jsx.ts --preload ./happydom.ts ./test-browser/kanban-panel.test.tsx
```

## Configuration

| Variable | Meaning |
| --- | --- |
| `KANBAN_TELEGRAM_TOKEN` | Telegram bot token. Unset disables the bot. |
| `KANBAN_TELEGRAM_CHATS` | Comma-separated chat ids allowed to use the bot. Empty allows none. |
| `KANBAN_WORKER_AGENT` | Agent id for the worker session. Unset uses the session default. |
| `KANBAN_WORKER_MODEL` | `<providerID>/<modelID>` for the worker session. Unset uses the session default. |
