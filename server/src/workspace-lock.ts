// Per-chat mutex shared by everything that mutates a 工作区 on the host
// (tool writes, panel uploads/edits/deletes) and by 沙盒 runs, which mutate
// it from inside. Holding one lock for both means a command can never be
// rearranging the directory while the panel is in the middle of a write —
// the window a symlink race needs. Reads do not take the lock; they verify
// what they opened instead (see workspace.ts openRegular).
const chains = new Map<string, Promise<void>>();

export async function withChatLock<T>(chatId: string, fn: () => Promise<T> | T): Promise<T> {
  const prev = chains.get(chatId) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((r) => { release = r; });
  const chained = prev.then(() => mine);
  chains.set(chatId, chained);
  await prev;
  try {
    return await fn();
  } finally {
    release();
    if (chains.get(chatId) === chained) chains.delete(chatId);
  }
}

export function chatLockHeld(chatId: string): boolean {
  return chains.has(chatId);
}
