import { useEffect, useRef, useState } from "react";
import type { AccountInfo, CodexProcessInfo, UsageInfo } from "../types";
import { invokeBackend, isTauriRuntime } from "./platform.ts";

export const AUTO_SWITCH_STORAGE_KEY = "auto-switch-exhausted-codex-account";
export const AUTO_SWITCH_INTERVAL_MS = 15_000;
const AUTO_SWITCH_COOLDOWN_MS = 5 * 60_000;
const AUTO_SWITCH_SETTLE_MS = 60_000;

// Read failures should not impose the longer backoff used after a failed mutation.
export class AutoSwitchSchedule {
  private nextCheck = 0;
  private blockedUntil = 0;

  shouldCheck(now: number, quotaStopped = false): boolean {
    if (now < this.blockedUntil || (!quotaStopped && now < this.nextCheck)) return false;
    this.nextCheck = now + AUTO_SWITCH_INTERVAL_MS;
    return true;
  }

  switched(now: number): void {
    this.blockedUntil = now + AUTO_SWITCH_SETTLE_MS;
  }

  failed(now: number, switchAttempted: boolean): void {
    this.blockedUntil = now + (switchAttempted ? AUTO_SWITCH_COOLDOWN_MS : AUTO_SWITCH_INTERVAL_MS);
  }
}

export function readAutoSwitchEnabled(): boolean {
  try {
    return window.localStorage.getItem(AUTO_SWITCH_STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

export function quotaState(usage: UsageInfo): "available" | "exhausted" | "unknown" {
  if (usage.error) return "unknown";
  // Credits can still fund requests after an included usage window is exhausted.
  if (usage.unlimited_credits === true || usage.has_credits === true) return "available";
  const windows = [
    [usage.primary_used_percent, usage.primary_window_minutes, usage.primary_resets_at],
    [usage.secondary_used_percent, usage.secondary_window_minutes, usage.secondary_resets_at],
  ].filter((window) => window.some((value) => value != null));
  if (windows.some(([used]) => used != null && Number.isFinite(used) && used >= 100)) return "exhausted";
  if (!windows.length || windows.some(([used]) => used == null || !Number.isFinite(used) || used < 0)) return "unknown";
  return "available";
}

interface AutoSwitchDependencies {
  invoke: <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
  cancelled: () => boolean;
  switchAccount: (target: AccountInfo, sourceId: string, reopen: boolean) => Promise<void>;
}

export async function checkQuotaAutoSwitch({
  invoke,
  cancelled,
  switchAccount,
}: AutoSwitchDependencies): Promise<{ message: string; switched: boolean }> {
  const result = (message: string, switched = false) => ({ message, switched });
  const active = await invoke<AccountInfo | null>("get_active_account_info");
  if (!active || active.auth_mode === "api_key") return result("Waiting for an active ChatGPT account.");
  const usage = await invoke<UsageInfo>("get_usage", { accountId: active.id });
  const state = quotaState(usage);
  if (state !== "exhausted") {
    return result(
      state === "available"
        ? "Monitoring quota. The active account still has capacity."
        : "Could not confirm the active account’s quota. No switch made."
    );
  }
  const accounts = await invoke<AccountInfo[]>("list_accounts");
  const index = accounts.findIndex((account) => account.id === active.id);
  if (index < 0) return result("The active account changed. Checking again shortly.");
  const candidates = [...accounts.slice(index + 1), ...accounts.slice(0, index)];
  for (const candidate of candidates) {
    if (cancelled()) return result("Auto-switch check cancelled.");
    if (candidate.auth_mode === "api_key") continue;
    let candidateUsage: UsageInfo;
    try {
      candidateUsage = await invoke<UsageInfo>("get_usage", { accountId: candidate.id });
    } catch {
      continue;
    }
    if (quotaState(candidateUsage) !== "available") continue;
    // Recheck the source after candidate requests, which can take several seconds.
    const current = await invoke<AccountInfo | null>("get_active_account_info");
    if (current?.id !== active.id) return result("The active account changed. No automatic switch made.");
    if (quotaState(await invoke<UsageInfo>("get_usage", { accountId: active.id })) !== "exhausted") {
      return result("The active account’s quota changed. No switch needed.");
    }
    const processes = await invoke<CodexProcessInfo>("check_codex_processes");
    if (!processes.can_switch) {
      const desktop = await invoke<{ supported: boolean; desktop_count: number }>("get_codex_reopen_info");
      if (!desktop.supported || desktop.desktop_count < 1) {
        return result("Auto-switch paused: running Codex processes cannot be reopened automatically.");
      }
    }
    if (cancelled()) return result("Auto-switch check cancelled.");
    await switchAccount(candidate, active.id, !processes.can_switch);
    return result("Account switched automatically. Monitoring resumes in one minute.", true);
  }
  return result("No other account has confirmed available quota. Checking again in 15 seconds.");
}

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
      if (
        disposed ||
        !latest.current.enabled ||
        inFlight.current ||
        latest.current.blocked() ||
        !schedule.current.shouldCheck(Date.now(), quotaStopped)
      ) {
        return;
      }
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
                new Promise<never>((_, reject) => {
                  timer = setTimeout(() => reject(new Error("Quota check timed out")), 15_000);
                }),
              ]);
            } finally {
              if (timer) clearTimeout(timer);
            }
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
        setStatus(
          `Auto-switch paused: ${String(error)}. Retrying in ${switchAttempted ? "five minutes" : "15 seconds"}.`
        );
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
    void monitor.catch((error) => console.warn("Native quota monitoring unavailable", error));
    const timer = window.setInterval(() => void check(), AUTO_SWITCH_INTERVAL_MS);
    return () => {
      disposed = true;
      window.clearInterval(timer);
      void monitor
        .then((unlisten) => {
          unlisten();
          return invokeBackend("set_quota_monitor", { monitorId, enabled: false });
        })
        .catch(() => undefined);
    };
  }, [options.enabled]);

  return { busy, inFlight, status };
}
