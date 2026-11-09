import type { AccountDailyUsage } from "../types";

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
