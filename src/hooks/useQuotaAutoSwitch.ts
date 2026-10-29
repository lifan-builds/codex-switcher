import { useEffect, useRef, useState } from "react";
import type { AccountInfo } from "../types";
import { invokeBackend, isTauriRuntime } from "../lib/platform";
import { AutoSwitchSchedule, AUTO_SWITCH_INTERVAL_MS, checkQuotaAutoSwitch } from "../lib/quotaAutoSwitch";

export function useQuotaAutoSwitch(options: {
  enabled: boolean;
  blocked: () => boolean;
  switchAccount: (target: AccountInfo, sourceId: string, reopen: boolean) => Promise<void>;
}) {
  const latest = useRef(options);
  latest.current = options;
  const inFlight = useRef(false);
  const schedule = useRef(new AutoSwitchSchedule());
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("Monitoring quota while Codex Switcher is running.");

  useEffect(() => {
    if (!options.enabled || !isTauriRuntime()) return;
    let disposed = false;
    const check = async (quotaStopped = false) => {
      if (disposed || !latest.current.enabled || inFlight.current || latest.current.blocked() || !schedule.current.shouldCheck(Date.now(), quotaStopped)) return;
      inFlight.current = true;
      let switchAttempted = false;
      setBusy(true);
      setStatus("Checking account quota…");
      try {
        const result = await checkQuotaAutoSwitch({
          invoke: async <T,>(command: string, args?: Record<string, unknown>) => {
            // Only read commands use this timeout; account switching must finish.
            let timer: ReturnType<typeof setTimeout> | undefined;
            try {
              return await Promise.race([
                invokeBackend<T>(command, args),
                new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Quota check timed out")), 15_000); }),
              ]);
            } finally { if (timer) clearTimeout(timer); }
          },
          cancelled: () => disposed || !latest.current.enabled || latest.current.blocked(),
          switchAccount: async (...args) => {
            switchAttempted = true;
            setStatus("Quota exhausted. Switching accounts…");
            await latest.current.switchAccount(...args);
          },
        });
        setStatus(result.message);
        if (result.switched) schedule.current.switched(Date.now());
      } catch (error) {
        setStatus(`Auto-switch paused: ${String(error)}. Retrying in ${switchAttempted ? "five minutes" : "15 seconds"}.`);
        schedule.current.failed(Date.now(), switchAttempted);
      } finally {
        inFlight.current = false;
        setBusy(false);
      }
    };
    void check();
    // Native ticks also drive checks while the window is hidden. A quota-stop
    // signal only accelerates validation; it never authorizes switching by itself.
    const monitorId = crypto.randomUUID();
    const monitor = (async () => {
      const { listen } = await import("@tauri-apps/api/event");
      const unlisten = await listen<boolean>("quota-auto-switch-tick", (event) => void check(event.payload));
      try {
        if (!disposed) await invokeBackend("set_quota_monitor", { monitorId, enabled: true });
        return unlisten;
      } catch (error) {
        unlisten();
        throw error;
      }
    })();
    // Retain a timer if native monitoring could not start.
    void monitor.catch((error) => console.warn("Native quota monitoring unavailable", error));
    const timer = window.setInterval(() => void check(), AUTO_SWITCH_INTERVAL_MS);
    return () => {
      disposed = true;
      window.clearInterval(timer);
      void monitor.then((unlisten) => {
        unlisten();
        return invokeBackend("set_quota_monitor", { monitorId, enabled: false });
      }).catch(() => undefined);
    };
  }, [options.enabled]);

  return { busy, inFlight, status };
}
