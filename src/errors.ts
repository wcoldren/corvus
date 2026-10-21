// The error log (SPEC.md, Recovery): the last 20 errors, kept in
// localStorage under `corvus:errors` and shown in Settings. localStorage
// rather than IndexedDB, so an error in the database code can still be
// recorded. Reset removes it with the other `corvus:` keys.

export const ERRORS_KEY = 'corvus:errors';
export const MAX_ERRORS = 20;

export interface ErrorEntry {
  ts: number;
  message: string;
  stack: string | null;
}

type Store = Pick<Storage, 'getItem' | 'setItem'>;

function store(): Store | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

export function readErrors(storage: Store | null = store()): ErrorEntry[] {
  try {
    const list: unknown = JSON.parse(storage?.getItem(ERRORS_KEY) ?? '[]');
    return Array.isArray(list) ? (list as ErrorEntry[]) : [];
  } catch {
    return [];
  }
}

/** Add an error, newest first, keeping the last MAX_ERRORS. Never throws. */
export function recordError(error: unknown, now: number = Date.now(), storage: Store | null = store()): void {
  try {
    const entry: ErrorEntry = {
      ts: now,
      message: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      stack: error instanceof Error ? (error.stack ?? null) : null,
    };
    storage?.setItem(ERRORS_KEY, JSON.stringify([entry, ...readErrors(storage)].slice(0, MAX_ERRORS)));
  } catch {
    // Storage full or unavailable: the error is lost, which beats a second one.
  }
}
