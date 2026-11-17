import type { AccountDailyUsage, AccountUsageStats, UsageInfo } from "../types";

export function formatPlan(plan: string | null | undefined): string | null {
  const trimmed = plan?.trim();
  if (!trimmed) return null;
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
}

export function remainingTone(remaining: number): { text: string; bar: string; dot: string } {
  if (remaining <= 10) {
    return { text: "text-red-500 dark:text-red-400", bar: "bg-red-500", dot: "bg-red-500" };
  }
  if (remaining <= 30) {
    return { text: "text-amber-500 dark:text-amber-400", bar: "bg-amber-500", dot: "bg-amber-500" };
  }
  return {
    text: "text-green-600 dark:text-green-400",
    bar: "bg-emerald-500",
    dot: "bg-emerald-500",
  };
}

export function formatWindowDuration(minutes: number | null | undefined): string {
  if (!minutes || minutes <= 0) return "";
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 24 * 60) return `${Math.ceil(minutes / 60)}h`;
  return `${Math.ceil(minutes / (24 * 60))}d`;
}

export function buildUsageError(
  accountId: string,
  error: string,
  planType: string | null = null,
): UsageInfo {
  return {
    account_id: accountId,
    plan_type: planType,
    primary_used_percent: null,
    primary_window_minutes: null,
    primary_resets_at: null,
    secondary_used_percent: null,
    secondary_window_minutes: null,
    secondary_resets_at: null,
    has_credits: null,
    unlimited_credits: null,
    credits_balance: null,
    error,
  };
}

export function emptyUsageStats(accountId: string, error: string): AccountUsageStats {
  return {
    account_id: accountId,
    available: false,
    source: "Codex usage stats via ChatGPT backend",
    generated_at: null,
    stats_as_of: null,
    summary: {
      lifetime_tokens: null,
      peak_daily_tokens: null,
      longest_task_seconds: null,
      current_streak_days: null,
      longest_streak_days: null,
    },
    activity: {
      fast_mode_percent: null,
      reasoning_effort: null,
      reasoning_effort_percent: null,
      skills_explored: null,
      total_skills_used: null,
      total_threads: null,
    },
    daily: [],
    top_invocations: [],
    reset_credits: null,
    error,
  };
}

export function formatTokens(tokens: number | null | undefined): string {
  if (tokens === null || tokens === undefined || !Number.isFinite(tokens)) return "--";
  const abs = Math.abs(tokens);
  if (abs >= 1_000_000_000) return `${(tokens / 1_000_000_000).toFixed(1)}B`;
  if (abs >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${(tokens / 1_000).toFixed(1)}K`;
  return `${tokens}`;
}

export function dayKey(offset: number): string {
  const date = new Date();
  date.setDate(date.getDate() - offset);
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function sumDailyTokens(daily: readonly AccountDailyUsage[], days: number): number {
  const keys = new Set(Array.from({ length: days }, (_, index) => dayKey(index)));
  return daily.reduce((total, day) => (keys.has(day.date) ? total + day.tokens : total), 0);
}

export function format12HourTime(date: Date): string {
  const minutes = String(date.getMinutes()).padStart(2, "0");
  const period = date.getHours() >= 12 ? "PM" : "AM";
  const hour12 = date.getHours() % 12 || 12;
  return `${hour12}:${minutes} ${period}`;
}

export function formatResetTime(
  resetAt: number | null | undefined,
  nowSeconds = Math.floor(Date.now() / 1000),
): string | null {
  if (!resetAt) return null;
  const diff = resetAt - nowSeconds;
  if (diff <= 0) return "now";
  if (diff < 60) return `${diff}s`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  if (diff < 86_400) {
    return `${Math.floor(diff / 3600)}h ${Math.floor((diff % 3600) / 60)}m`;
  }
  return `${Math.floor(diff / 86_400)}d ${Math.floor((diff % 86_400) / 3600)}h`;
}

export function formatExactResetTime(
  resetAt: number | null | undefined,
  options?: { compact?: boolean; isWeekly?: boolean; nowSeconds?: number },
): string | null {
  if (!resetAt) return null;
  const date = new Date(resetAt * 1000);
  if (options?.compact) {
    const diff = resetAt - (options.nowSeconds ?? Math.floor(Date.now() / 1000));
    if (options.isWeekly && diff > 86_400) {
      return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(date);
    }
    return format12HourTime(date);
  }
  const month = new Intl.DateTimeFormat(undefined, { month: "long" }).format(date);
  return `${month} ${date.getDate()}, ${format12HourTime(date)}`;
}
