/// <reference types="vite/client" />

/**
 * Commit this bundle was built from, set by the build-identity plugin in
 * vite.config.ts. ``sha`` is null when there's no git history.
 */
declare const __BUILD__: {
  sha: string | null;
  branch: string | null;
  builtAt: number;
};
