/**
 * The prompt sent to the worker session when a note is captured.
 *
 * A captured note is the whole brief — the worker has no other context — so the template
 * has to stand on its own: say what this is, drop in the note verbatim, and name the
 * shape of a useful answer. The last line matters most. The agent's final reply is stored
 * as the card's `result` and read by the user from the board, so the prompt has to ask
 * for a report rather than leaving the agent to decide what a finished task looks like.
 */
export function workerPrompt(note: string): string {
  return `You are working on one task from the user's capture inbox.

${note}

Do this task as well as you can with the tools you have. If you cannot complete it,
produce the closest useful thing: a plan, a draft, a piece of research, or the concrete
next steps. When you are done, end with a short report of what you did and what the
user should look at.`
}
