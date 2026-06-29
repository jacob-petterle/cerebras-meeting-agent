/**
 * Configure Cursor's ripgrep BEFORE `@cursor/sdk` is evaluated.
 *
 * The SDK reads `process.env.CURSOR_RIPGREP_PATH` at module-init to locate ripgrep for its local
 * file-search tools (grep / glob / semantic-search). Without it, every search a research sub-agent
 * runs throws "Ripgrep path not configured" and the run never completes — it hangs to its wall-clock
 * timeout. That is exactly why call_agent only ever produced timeout-fallback findings: the agent
 * could not read the codebase. There is no system `rg` on PATH in this environment; the SDK ships a
 * per-platform binary (`@cursor/sdk-<platform>-<arch>/bin/rg`), so we resolve THAT and export the var.
 *
 * This is a SIDE-EFFECT module. cursor.ts imports it on the line ABOVE its `@cursor/sdk` import; ESM
 * evaluates imports in source order, so this runs (setting the env) before the SDK module initialises.
 * Idempotent: an explicit CURSOR_RIPGREP_PATH (shell / .env) wins and is left untouched.
 */
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

/** Resolve the SDK's bundled platform ripgrep, mirroring how the SDK locates its own optional dep. */
function resolveBundledRipgrep(): string | null {
  try {
    const require = createRequire(import.meta.url);
    /** Resolve the platform package FROM the SDK's module context, where its optionalDependency lives. */
    const sdkRequire = createRequire(require.resolve('@cursor/sdk'));
    const platformPkg = `@cursor/sdk-${process.platform}-${process.arch}`;
    const binName = process.platform === 'win32' ? 'rg.exe' : 'rg';
    const rg = join(dirname(sdkRequire.resolve(`${platformPkg}/package.json`)), 'bin', binName);
    return existsSync(rg) ? rg : null;
  } catch {
    return null;
  }
}

if (!process.env.CURSOR_RIPGREP_PATH) {
  const rg = resolveBundledRipgrep();
  if (rg) {
    process.env.CURSOR_RIPGREP_PATH = rg;
    console.log(`[ripgrep] CURSOR_RIPGREP_PATH=${rg}`);
  } else {
    console.warn(
      '[ripgrep] could not resolve a bundled ripgrep — call_agent file search may fail. ' +
        'Set CURSOR_RIPGREP_PATH to an rg binary.',
    );
  }
}
