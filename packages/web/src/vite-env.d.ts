/// <reference types="vite/client" />

interface ImportMetaEnv {
  /**
   * Operator-console debug flag. Truthy ('1' | 'true') renders the FULL console (header, mic,
   * console tabs, HUD) instead of the deliverable-only stage. Set it on the launch CLI via
   * `VITE_DEBUG_UI=1` (the `pnpm web:debug` script). Default/unset → deliverable-only (screenshare).
   */
  readonly VITE_DEBUG_UI?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
