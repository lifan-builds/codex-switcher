import { useCallback, useEffect, useState } from "react";
import type { CodexProcessInfo } from "../types";
import { formatError, invokeBackend, isTauriRuntime } from "./platform.ts";

export type DesktopReopenPreference = "ask" | "always" | "never";
export type CodexClosePreference = "ask" | "graceful" | "force";

export const DESKTOP_REOPEN_STORAGE_KEY = "desktop-reopen-after-force-close";
export const CODEX_CLOSE_PREFERENCE_STORAGE_KEY = "codex-close-preference";
const AUTO_RESUME_SESSIONS_STORAGE_KEY = "auto-resume-interrupted-codex-sessions";

export function parseDesktopReopenPreference(value: string | null): DesktopReopenPreference {
  return value === "always" || value === "never" ? value : "ask";
}

export function parseCodexClosePreference(value: string | null): CodexClosePreference {
  return value === "graceful" || value === "force" ? value : "ask";
}

export function rememberedCodexClosePreference(
  forceClose: boolean,
  remember: boolean,
): CodexClosePreference {
  if (!remember) return "ask";
  return forceClose ? "force" : "graceful";
}

export function readAutoResumeSessions(): boolean {
  try {
    return window.localStorage.getItem(AUTO_RESUME_SESSIONS_STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

export function writeAutoResumeSessions(enabled: boolean): void {
  window.localStorage.setItem(AUTO_RESUME_SESSIONS_STORAGE_KEY, String(enabled));
}

export interface RecoveryProgress {
  completed: number;
  total: number;
  current_session_id: string | null;
}

export interface RecoveryReport {
  resumed: string[];
  skipped: string[];
  failed: { session_id: string; reason: string }[];
  timed_out: boolean;
}

export type RecoveryState =
  | { status: "running"; progress: RecoveryProgress }
  | { status: "complete"; report: RecoveryReport }
  | { status: "error"; message: string };

export interface ForceCloseOutcome {
  canSwitch: boolean;
  reopenToken: string | null;
}

// Account switching must finish before reopening a desktop that reads auth.json.
export async function finishForceClose(
  outcome: ForceCloseOutcome,
  switchAccount: (() => Promise<void>) | null,
  reopenDesktop: (token: string) => Promise<void>,
): Promise<void> {
  if (!outcome.canSwitch) return;
  if (switchAccount) await switchAccount();
  if (outcome.reopenToken) await reopenDesktop(outcome.reopenToken);
}

interface DesktopReopenInfo {
  supported: boolean;
  desktop_count: number;
}

export function useDesktopReopen(confirmOpen: boolean) {
  const [preference, setPreference] = useState<DesktopReopenPreference>(() => {
    try {
      return parseDesktopReopenPreference(window.localStorage.getItem(DESKTOP_REOPEN_STORAGE_KEY));
    } catch {
      return "ask";
    }
  });
  const [reopen, setReopen] = useState(false);
  const [remember, setRemember] = useState(false);
  const [info, setInfo] = useState<DesktopReopenInfo | null>(null);
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    if (!confirmOpen) return;
    let cancelled = false;
    setReopen(preference === "always");
    setRemember(preference !== "ask");
    setInfo(null);
    if (!isTauriRuntime()) return;
    setChecking(true);
    void invokeBackend<DesktopReopenInfo>("get_codex_reopen_info")
      .then((result) => { if (!cancelled) setInfo(result); })
      .catch(() => { if (!cancelled) setInfo(null); })
      .finally(() => { if (!cancelled) setChecking(false); });
    return () => { cancelled = true; };
  }, [confirmOpen, preference]);

  const savePreference = useCallback((value: DesktopReopenPreference) => {
    window.localStorage.setItem(DESKTOP_REOPEN_STORAGE_KEY, value);
    setPreference(value);
  }, []);

  const available = info?.supported === true && info.desktop_count > 0;
  const rememberSelection = () => {
    if (available && preference === "ask") {
      savePreference(remember ? (reopen ? "always" : "never") : "ask");
    }
  };

  return {
    preference,
    savePreference,
    reopen,
    setReopen,
    remember,
    setRemember,
    available,
    checking,
    rememberSelection,
  };
}

export function useCodexClosePreference(confirmOpen: boolean) {
  const [preference, setPreference] = useState<CodexClosePreference>(() => {
    try {
      return parseCodexClosePreference(
        window.localStorage.getItem(CODEX_CLOSE_PREFERENCE_STORAGE_KEY),
      );
    } catch {
      return "ask";
    }
  });
  const [forceClose, setForceClose] = useState(false);
  const [remember, setRemember] = useState(false);

  useEffect(() => {
    if (!confirmOpen) return;
    setForceClose(preference === "force");
    setRemember(preference !== "ask");
  }, [confirmOpen, preference]);

  const savePreference = useCallback((value: CodexClosePreference) => {
    window.localStorage.setItem(CODEX_CLOSE_PREFERENCE_STORAGE_KEY, value);
    setPreference(value);
  }, []);

  const rememberSelection = () => {
    savePreference(rememberedCodexClosePreference(forceClose, remember));
  };

  return {
    preference,
    savePreference,
    forceClose,
    setForceClose,
    remember,
    setRemember,
    rememberSelection,
  };
}

interface KillCodexProcessesResult {
  targeted_count: number;
  killed_pids: number[];
  failed_pids: number[];
  reopen_token?: string | null;
}

export function useForceCloseCodexProcesses({
  processCount,
  checkProcesses,
  showToast,
}: {
  processCount: number;
  checkProcesses: () => Promise<CodexProcessInfo | null>;
  showToast: (message: string, isError?: boolean) => void;
}) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [isForceClosing, setIsForceClosing] = useState(false);

  const closeCodexProcesses = useCallback(
    async (reopenDesktop = false, forceClose = false) => {
      try {
        setIsForceClosing(true);

        const result = await invokeBackend<KillCodexProcessesResult>(
          "kill_codex_processes",
          { reopenDesktop, forceClose }
        );
        const latestProcessInfo = await checkProcesses();
        const remainingCount = latestProcessInfo?.count ?? processCount;
        const closedCount = Math.max(0, processCount - remainingCount);

        if (!latestProcessInfo) {
          showToast(
            "Could not verify that Codex closed. Account switching and reopening were skipped.",
            true
          );
        } else if (result.targeted_count === 0) {
          showToast("No running Codex processes found.");
        } else if (remainingCount === 0) {
          showToast(
            `${forceClose ? "Force closed" : "Closed"} ${processCount} Codex session${
              processCount === 1 ? "" : "s"
            }.`
          );
        } else if (closedCount > 0) {
          showToast(
            `${forceClose ? "Force closed" : "Closed"} ${closedCount}/${processCount} Codex sessions. ${remainingCount} still running.`,
            true
          );
        } else {
          showToast(
            `Could not ${forceClose ? "force close" : "gracefully close"} ${remainingCount} Codex session${
              remainingCount === 1 ? "" : "s"
            }.`,
            true
          );
        }

        return { processInfo: latestProcessInfo, reopenToken: result.reopen_token ?? null };
      } catch (err) {
        console.error("Failed to close Codex processes:", err);
        showToast(`Close failed: ${formatError(err)}`, true);
        return null;
      } finally {
        setConfirmOpen(false);
        setIsForceClosing(false);
      }
    },
    [checkProcesses, processCount, showToast]
  );

  return {
    forceCloseConfirmOpen: confirmOpen,
    setForceCloseConfirmOpen: setConfirmOpen,
    isForceClosingCodex: isForceClosing,
    closeCodexProcesses,
  };
}
