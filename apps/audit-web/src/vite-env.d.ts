/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_BASE_URL?: string;

  /**
   * Demo sign-ins for the login screen, as JSON:
   * [{ "email": "...", "password": "...", "note": "..." }]
   *
   * Unset in every ordinary build. See components/DemoLoginPanel.tsx.
   */
  readonly VITE_DEMO_LOGINS?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
