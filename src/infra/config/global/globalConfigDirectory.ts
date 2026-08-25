import { existsSync, mkdirSync } from 'node:fs';

/** Creates only a new global config leaf privately; existing roots are policy inputs. */
export function ensureGlobalConfigDirectory(path: string): void {
  if (!existsSync(path)) {
    mkdirSync(path, { recursive: true, mode: 0o700 });
  }
}
