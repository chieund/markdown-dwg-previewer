/** Decisions about when the AI side starts and when to offer Connect; nothing here touches VS Code. */

/** What globalState remembers about this user and the AI feature. */
export interface AiHistory {
  /** The user connected Claude Code before (and has not disconnected). */
  connected?: boolean;
  /** The AI feature was started before: Connect or the setup view was used, or Copilot asked for the server. */
  used?: boolean;
}

/**
 * Start the AI server (and touch the token in the OS keyring) as VS Code starts only for someone who
 * already uses it. Everyone else starts it for the session on the first drawing they open, or on Connect / when Copilot
 * asks for the server.
 */
export function startsAtStartup(history: AiHistory): boolean {
  return history.connected === true || history.used === true;
}

/**
 * Opening a drawing starts the AI side for this session only. The "used" flag, which makes it start with
 * VS Code from then on, is written only on intent: Connect, "Show setup for other agents", Copilot resolving.
 */
export function startDecision(i: { wanted: boolean; used: boolean; intent: boolean }): { start: boolean; remember: boolean } {
  return { start: !i.wanted, remember: i.intent && !i.used };
}

export interface PresenceDeps {
  extensionInstalled(): boolean;
  /** All paths a PATH lookup printed for `name`. */
  which(name: string): Promise<string[]>;
}

/** Claude Code is here: its VS Code extension is installed or a `claude` is on PATH. */
export async function claudeCodePresent(deps: PresenceDeps): Promise<boolean> {
  if (deps.extensionInstalled()) return true;
  try {
    return (await deps.which('claude')).length > 0;
  } catch {
    return false;
  }
}
