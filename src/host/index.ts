import type { WorkbenchHost } from "./contracts";
import { createDesktopHost } from "./desktop";
import { createWebHost } from "./web";

/** Native presence is a commitment: a failed handshake must never start WASM. */
export async function createWorkbenchHost(): Promise<WorkbenchHost> {
  if ("__TAURI_INTERNALS__" in globalThis)
    return createDesktopHost();
  return createWebHost();
}
