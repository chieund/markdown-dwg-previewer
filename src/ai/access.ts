import * as path from 'node:path';

/** Thrown when the AI agent may not read a file. The message is shown to the agent. */
export class AccessDenied extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AccessDenied';
  }
}

export interface AccessDeps {
  /** Workspace folders of all VS Code windows (from WindowRegistry). */
  workspaceFolders(): Promise<string[]>;
  /** Real paths of open preview tabs. */
  openPreviews(): string[];
  /** Modal question to the user; false = Deny. */
  ask(path: string): Promise<boolean>;
  realpath(path: string): Promise<string>;
  isFile(path: string): Promise<boolean>;
  /** How long an unanswered prompt waits before it counts as Deny for that call. Default ACCESS_PROMPT_TIMEOUT_MS. */
  askTimeoutMs?: number;
}

/** A modal can sit unseen in another window; after this long the call is denied (not remembered) and the next prompt may show. */
export const ACCESS_PROMPT_TIMEOUT_MS = 60_000;

type Answer = 'allow' | 'deny' | 'timeout';

/**
 * Builds the access check: resolves to the real path, or throws AccessDenied.
 * Files inside a workspace folder or open in a preview are allowed; anything else
 * needs the user's yes, asked once per real path per check instance.
 */
export function createAccessCheck(deps: AccessDeps, platform: string = process.platform): (path: string) => Promise<string> {
  const win = platform === 'win32';
  const norm = (p: string) => (win ? p.toLowerCase() : p);
  const within = (file: string, folder: string) => {
    const dir = folder.endsWith(path.sep) ? folder : folder + path.sep;
    return norm(file).startsWith(norm(dir));
  };
  const decisions = new Map<string, Promise<Answer>>();
  let queue: Promise<unknown> = Promise.resolve(); // one modal at a time
  const timeoutMs = deps.askTimeoutMs ?? ACCESS_PROMPT_TIMEOUT_MS;

  const askInTime = (real: string): Promise<Answer> =>
    new Promise<Answer>((resolve) => {
      const timer = setTimeout(() => resolve('timeout'), timeoutMs);
      deps.ask(real).then(
        (yes) => { clearTimeout(timer); resolve(yes ? 'allow' : 'deny'); },
        () => { clearTimeout(timer); resolve('deny'); }
      );
    });

  return async (given: string): Promise<string> => {
    if (typeof given !== 'string' || !path.isAbsolute(given)) {
      throw new AccessDenied(`The AI agent must give an absolute path to a .dwg or .dxf file; got "${given}".`);
    }
    const notDrawing = () => new AccessDenied(`${given} is not a readable .dwg or .dxf drawing.`);
    const givenExt = path.extname(given).toLowerCase();
    if (givenExt !== '.dwg' && givenExt !== '.dxf') throw notDrawing();
    let real: string;
    try {
      real = await deps.realpath(given);
      const ext = path.extname(real).toLowerCase();
      if ((ext !== '.dwg' && ext !== '.dxf') || !(await deps.isFile(real))) throw notDrawing();
    } catch {
      throw notDrawing();
    }

    if (deps.openPreviews().some((p) => norm(p) === norm(real))) return real;
    for (const folder of await deps.workspaceFolders()) {
      let realFolder: string;
      try {
        realFolder = await deps.realpath(folder);
      } catch {
        continue;
      }
      if (within(real, realFolder)) return real;
    }

    const key = norm(real);
    let pending = decisions.get(key);
    if (!pending) {
      const run = queue.then(() => askInTime(real));
      queue = run;
      pending = run;
      decisions.set(key, pending);
      // An unanswered prompt is not a decision: the next call asks again.
      const mine = pending;
      void run.then((a) => {
        if (a === 'timeout' && decisions.get(key) === mine) decisions.delete(key);
      });
    }
    const answer = await pending;
    if (answer === 'timeout') {
      throw new AccessDenied(`The user did not answer whether the AI agent may read ${real}; ask them, then try again.`);
    }
    if (answer === 'deny') throw new AccessDenied(`The user declined to let the AI agent read ${real}.`);
    return real;
  };
}
