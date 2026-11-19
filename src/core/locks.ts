/** Per-key async mutex. Serializes read-modify-write cycles on the same file across parallel agents. */
const chains = new Map<string, Promise<void>>();

export async function withFileLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const k = process.platform === 'win32' ? key.toLowerCase() : key;
  const prev = chains.get(k) ?? Promise.resolve();
  let release!: () => void;
  const mine = prev.then(() => new Promise<void>((r) => { release = r; }));
  chains.set(k, mine);
  await prev;
  try {
    return await fn();
  } finally {
    release();
    if (chains.get(k) === mine) { chains.delete(k); }
  }
}

export const lockCount = (): number => chains.size;
