import type { AccountWithUsage, UsageInfo } from "../types";

const AUTO_WARMUP_ALL_STORAGE_KEY = "codex-switcher-auto-warmup-all";
export const AUTO_WARMUP_ACCOUNTS_STORAGE_KEY = "codex-switcher-auto-warmup-accounts";
export const AUTO_WARMUP_LEDGER_STORAGE_KEY = "codex-switcher-auto-warmup-last-success";
export const AUTO_WARMUP_ALL_CHANGED_EVENT = "auto-warmup-all-changed";

const TIMED_WARMUP_ENABLED_STORAGE_KEY = "codex-switcher-timed-warmup-enabled";
const TIMED_WARMUP_TIMES_STORAGE_KEY = "codex-switcher-timed-warmup-times";
export const TIMED_WARMUP_LEDGER_STORAGE_KEY = "codex-switcher-timed-warmup-last-fire";

const DEFAULT_SESSION_WINDOW_MINUTES = 5 * 60;
const DEFAULT_WEEKLY_WINDOW_MINUTES = 7 * 24 * 60;
const FULL_WINDOW_SLACK_MINUTES = 5;
const LIMIT_FULL_THRESHOLD = 99.5;
const MIN_SUCCESS_INTERVAL_MS = 60 * 60 * 1000;

export type AutoWarmupWindowKind = "session" | "weekly";

export interface AutoWarmupWindow {
  kind: AutoWarmupWindowKind;
  windowMinutes: number;
  resetsAt: number;
}

export interface AutoWarmupHistory {
  lastSuccessfulWarmupAt?: number;
  lastAutoWindowKey?: string;
  lastAutoWindowKind?: AutoWarmupWindowKind;
}

export type AutoWarmupLedger = Record<string, AutoWarmupHistory>;

export function isLimitFull(usedPercent: number | null | undefined): boolean {
  return usedPercent != null && usedPercent >= LIMIT_FULL_THRESHOLD;
}

export function getTimedWarmupTargets(accounts: AccountWithUsage[]): AccountWithUsage[] {
  return accounts.filter(
    (account) =>
      account.usage &&
      !account.usageLoading &&
      !account.usage.error &&
      !isLimitFull(account.usage.secondary_used_percent)
  );
}

export function readAutoWarmupAllEnabled(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(AUTO_WARMUP_ALL_STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

export function writeAutoWarmupAllEnabled(enabled: boolean): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(AUTO_WARMUP_ALL_STORAGE_KEY, String(enabled));
}

export function readStoredAutoWarmupAccountIds(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const parsed = JSON.parse(
      window.localStorage.getItem(AUTO_WARMUP_ACCOUNTS_STORAGE_KEY) ?? "[]"
    );
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

function readJsonRecord<T>(key: string): Record<string, T> {
  if (typeof window === "undefined") return {};
  try {
    const parsed = JSON.parse(window.localStorage.getItem(key) ?? "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function readStoredAutoWarmupLedger(): AutoWarmupLedger {
  return readJsonRecord<AutoWarmupHistory>(AUTO_WARMUP_LEDGER_STORAGE_KEY);
}

export function readStoredTimedWarmupLedger(): Record<string, string> {
  return readJsonRecord<string>(TIMED_WARMUP_LEDGER_STORAGE_KEY);
}

/** Validate, normalize, dedupe and sort a list of "HH:MM" times. */
export function normalizeTimedWarmupTimes(times: readonly string[]): string[] {
  const valid = new Set<string>();
  for (const raw of times) {
    const match = /^(\d{1,2}):(\d{1,2})$/.exec(String(raw).trim());
    if (!match) continue;
    const hours = Number(match[1]);
    const minutes = Number(match[2]);
    if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) continue;
    valid.add(
      `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`
    );
  }
  return Array.from(valid).sort();
}

export function readTimedWarmupEnabled(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(TIMED_WARMUP_ENABLED_STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

export function writeTimedWarmupEnabled(enabled: boolean): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(TIMED_WARMUP_ENABLED_STORAGE_KEY, String(enabled));
}

export function readTimedWarmupTimes(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const parsed = JSON.parse(
      window.localStorage.getItem(TIMED_WARMUP_TIMES_STORAGE_KEY) ?? "[]"
    );
    return Array.isArray(parsed) ? normalizeTimedWarmupTimes(parsed) : [];
  } catch {
    return [];
  }
}

export function writeTimedWarmupTimes(times: readonly string[]): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(
    TIMED_WARMUP_TIMES_STORAGE_KEY,
    JSON.stringify(normalizeTimedWarmupTimes(times))
  );
}

function hasPrimaryWindow(usage: UsageInfo): boolean {
  return (
    usage.primary_used_percent != null ||
    usage.primary_window_minutes != null ||
    usage.primary_resets_at != null
  );
}

function hasSecondaryWindow(usage: UsageInfo): boolean {
  return (
    usage.secondary_used_percent != null ||
    usage.secondary_window_minutes != null ||
    usage.secondary_resets_at != null
  );
}

export function getAutoWarmupWindowKind(
  usage: UsageInfo | undefined
): AutoWarmupWindowKind | null {
  if (!usage || usage.error) return null;
  if (hasPrimaryWindow(usage)) return "session";
  if (hasSecondaryWindow(usage)) return "weekly";
  return null;
}

function getAutoWarmupWindow(usage: UsageInfo | undefined): AutoWarmupWindow | null {
  const kind = getAutoWarmupWindowKind(usage);
  if (!usage || !kind) return null;

  if (kind === "session") {
    if (usage.primary_resets_at == null) return null;
    return {
      kind,
      windowMinutes: usage.primary_window_minutes ?? DEFAULT_SESSION_WINDOW_MINUTES,
      resetsAt: usage.primary_resets_at,
    };
  }

  if (usage.secondary_resets_at == null) return null;
  return {
    kind,
    windowMinutes: usage.secondary_window_minutes ?? DEFAULT_WEEKLY_WINDOW_MINUTES,
    resetsAt: usage.secondary_resets_at,
  };
}

export function getAutoWarmupWindowKey(window: AutoWarmupWindow): string {
  return `${window.kind}:${window.windowMinutes}:${window.resetsAt}`;
}

function isAutoWarmupWindowFresh(
  window: AutoWarmupWindow,
  nowMs = Date.now()
): boolean {
  if (!Number.isFinite(window.windowMinutes) || window.windowMinutes <= 0) return false;
  if (!Number.isFinite(window.resetsAt) || window.resetsAt <= 0) return false;

  const remainingMs = window.resetsAt * 1000 - nowMs;
  const thresholdMinutes = Math.max(0, window.windowMinutes - FULL_WINDOW_SLACK_MINUTES);
  return remainingMs >= thresholdMinutes * 60 * 1000;
}

export function getDueAutoWarmupWindow(
  usage: UsageInfo | undefined,
  history: AutoWarmupHistory | undefined,
  nowMs = Date.now()
): AutoWarmupWindow | null {
  const window = getAutoWarmupWindow(usage);
  if (!window) return null;
  if (window.kind === "session" && isLimitFull(usage?.secondary_used_percent)) {
    return null;
  }
  if (!isAutoWarmupWindowFresh(window, nowMs)) return null;

  const windowKey = getAutoWarmupWindowKey(window);
  if (history?.lastAutoWindowKey === windowKey) return null;

  const lastSuccessfulWarmupAt = history?.lastSuccessfulWarmupAt;
  if (
    lastSuccessfulWarmupAt &&
    nowMs - lastSuccessfulWarmupAt < MIN_SUCCESS_INTERVAL_MS &&
    (!history.lastAutoWindowKind || history.lastAutoWindowKind === window.kind)
  ) {
    return null;
  }

  return window;
}
