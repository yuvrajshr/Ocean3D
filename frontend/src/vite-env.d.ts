/// <reference types="vite/client" />

/**
 * The commit this bundle was built from, injected by the build-identity plugin
 * in vite.config.ts. Fixed at dev-server start or at `vite build`; `sha` is null
 * when the source had no git history.
 */
declare const __BUILD__: {
  sha: string | null;
  branch: string | null;
  builtAt: number;
};
