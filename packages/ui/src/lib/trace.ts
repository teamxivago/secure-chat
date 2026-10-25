/** Opt-in pipeline timing (localStorage "veil:trace" = "1"). Wall-clock ms for cross-device comparison. */
let enabled: boolean | null = null;
export function trace(label: string, extra?: unknown) {
  if (enabled === null) {
    try {
      enabled = localStorage.getItem("veil:trace") === "1";
    } catch {
      enabled = false;
    }
  }
  if (enabled) console.info(`[trace] ${Date.now()} ${label}`, extra ?? "");
}
