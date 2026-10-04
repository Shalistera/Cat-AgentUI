// Loaded only into the Claude Code processes the 本地 Claude Code provider
// starts (server/src/providers/claude-code.ts). The panel already sends the
// system prompt, the date and everything else the model should know; what
// Claude Code adds on its own describes the server it runs on — working
// directory, OS, the operator's e-mail address, token counters — and must not
// reach panel users or steer the model away from the panel's instructions.
import type { Register } from 'claude-code'

export const register: Register = (on) => {
  // The first user message's context blocks (CLAUDE.md, userEmail, date).
  on('prompt.context', () => ({ blocks: [] }))
  // Every reminder Claude Code injects on its own as a request carries it.
  on('prompt.attachment', () => ({ text: null }))
}
