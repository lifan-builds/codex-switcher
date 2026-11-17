import { useState, useEffect, useCallback, useRef } from "react";
import type {
  AccountInfo,
  UsageInfo,
  AccountWithUsage,
  WarmupSummary,
  ImportAccountsSummary,
} from "../types";
import { formatError, invokeBackend, isTauriRuntime, type FileSource } from "../lib/platform.ts";
import { buildUsageError } from "../lib/usageFormatting.ts";

export function needsRelogin(error: string | null | undefined): boolean {
  return (
    !!error &&
    /\b401\b|\bunauthorized\b|invalid_grant|invalid_token|token_(?:expired|invalidated|revoked)|refresh_token_(?:reused|expired|invalidated)|(?:refresh|authentication) token[^\n]*(?:expired|invalid|revoked|reused)|missing refresh token/i.test(
      error
    )
  );
}

const MAX_CONCURRENT_USAGE_REQUESTS = 10;

async function runWithConcurrency<T>(
  items: T[],
  worker: (item: T) => Promise<void>,
  concurrency: number
): Promise<void> {
  if (items.length === 0) return;
  const limit = Math.min(Math.max(concurrency, 1), items.length);
  let index = 0;
  const runners = Array.from({ length: limit }, async () => {
    while (index < items.length) {
      const current = index++;
      await worker(items[current]);
    }
  });
  await Promise.allSettled(runners);
}

export function useAccounts() {
  const [accounts, setAccounts] = useState<AccountWithUsage[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const accountsRef = useRef<AccountWithUsage[]>([]);
  const metadataRefreshInFlightRef = useRef(new Set<string>());

  useEffect(() => {
    accountsRef.current = accounts;
  }, [accounts]);

  // Push freshly polled usage down to the tray (single poller feeds the tray menu).
  const reportUsageToTray = useCallback((usages: UsageInfo[]) => {
    if (!isTauriRuntime() || usages.length === 0) return;
    void invokeBackend("report_usage", { usages }).catch(() => {});
  }, []);

  const loadAccounts = useCallback(async (preserveUsage = false) => {
    try {
      setLoading(true);
      setError(null);
      const accountList = await invokeBackend<AccountInfo[]>("list_accounts");

      if (preserveUsage) {
        setAccounts((prev) => {
          const usageMap = new Map(
            prev.map((a) => [a.id, { usage: a.usage, usageLoading: a.usageLoading }])
          );
          return accountList.map((a) => ({
            ...a,
            usage: usageMap.get(a.id)?.usage,
            usageLoading: usageMap.get(a.id)?.usageLoading,
          }));
        });
      } else {
        setAccounts(accountList.map((a) => ({ ...a, usageLoading: false })));
      }
      return accountList;
    } catch (err) {
      setError(formatError(err));
      return [];
    } finally {
      setLoading(false);
    }
  }, []);

  const refreshMetadata = useCallback(
    async (accountList?: AccountInfo[] | AccountWithUsage[]) => {
      const list = accountList ?? accountsRef.current;
      const dueAccounts = list.filter(
        (account) => !metadataRefreshInFlightRef.current.has(account.id)
      );

      // Mark attempts before starting requests so overlapping refresh cycles
      // cannot issue duplicate metadata calls for the same account.
      for (const account of dueAccounts) {
        metadataRefreshInFlightRef.current.add(account.id);
      }

      await runWithConcurrency(
        dueAccounts,
        async (account) => {
          try {
            const metadata = await invokeBackend<AccountInfo>("refresh_account_metadata", {
              accountId: account.id,
            });
            setAccounts((prev) =>
              prev.map((item) =>
                item.id === account.id
                  ? {
                      ...item,
                      plan_type: metadata.plan_type,
                      subscription_expires_at: metadata.subscription_expires_at,
                    }
                  : item
              )
            );
          } catch (err) {
            console.warn("Failed to refresh account metadata:", err);
          } finally {
            metadataRefreshInFlightRef.current.delete(account.id);
          }
        },
        MAX_CONCURRENT_USAGE_REQUESTS
      );
    },
    []
  );

  const refreshUsage = useCallback(
    async (
      accountList?: AccountInfo[] | AccountWithUsage[],
      options?: { refreshMetadata?: boolean }
    ) => {
      const list = accountList ?? accountsRef.current;
      if (list.length === 0) return;

      // Explicit refreshes include metadata, but run it beside usage so a
      // slow accounts endpoint never delays healthy rate-limit updates.
      const metadataPromise = options?.refreshMetadata
        ? refreshMetadata(list)
        : Promise.resolve();

      const accountIdSet = new Set(list.map((account) => account.id));
      const usageResults = new Map<string, UsageInfo>();

      setAccounts((prev) =>
        prev.map((account) =>
          accountIdSet.has(account.id) ? { ...account, usageLoading: true } : account
        )
      );

      await runWithConcurrency(
        list,
        async (account) => {
          try {
            const usage = await invokeBackend<UsageInfo>("get_usage", {
              accountId: account.id,
            });
            usageResults.set(account.id, usage);
          } catch (err) {
            console.error("Failed to refresh usage:", err);
            usageResults.set(
              account.id,
              buildUsageError(account.id, formatError(err), account.plan_type ?? null)
            );
          }
        },
        MAX_CONCURRENT_USAGE_REQUESTS
      );

      setAccounts((prev) =>
        prev.map((account) => {
          const usage = usageResults.get(account.id);
          return usage ? { ...account, usage, usageLoading: false } : account;
        })
      );

      reportUsageToTray(Array.from(usageResults.values()));
      await metadataPromise;
    },
    [refreshMetadata, reportUsageToTray]
  );

  const refreshSingleUsage = useCallback(
    async (accountId: string, options?: { refreshMetadata?: boolean }) => {
      try {
        const account = accountsRef.current.find((item) => item.id === accountId);
        const metadataPromise =
          options?.refreshMetadata && account ? refreshMetadata([account]) : Promise.resolve();

        setAccounts((prev) =>
          prev.map((a) => (a.id === accountId ? { ...a, usageLoading: true } : a))
        );
        const usage = await invokeBackend<UsageInfo>("get_usage", { accountId });
        setAccounts((prev) =>
          prev.map((a) => (a.id === accountId ? { ...a, usage, usageLoading: false } : a))
        );
        reportUsageToTray([usage]);
        await metadataPromise;
        return usage;
      } catch (err) {
        console.error("Failed to refresh single usage:", err);
        setAccounts((prev) =>
          prev.map((a) =>
            a.id === accountId
              ? {
                  ...a,
                  usage: buildUsageError(accountId, formatError(err), a.plan_type ?? null),
                  usageLoading: false,
                }
              : a
          )
        );
        throw err;
      }
    },
    [refreshMetadata, reportUsageToTray]
  );

  const warmupAccount = useCallback(
    (accountId: string) => invokeBackend<void>("warmup_account", { accountId }),
    []
  );

  const warmupAllAccounts = useCallback(
    () => invokeBackend<WarmupSummary>("warmup_all_accounts"),
    []
  );

  const switchAccount = useCallback(
    async (accountId: string, expectedActiveId?: string) => {
      await invokeBackend(
        expectedActiveId ? "switch_account_if_current" : "switch_account",
        { accountId, ...(expectedActiveId ? { expectedActiveId } : {}) }
      );
      await loadAccounts(true);
    },
    [loadAccounts]
  );

  const deleteAccount = useCallback(
    async (accountId: string) => {
      await invokeBackend("delete_account", { accountId });
      await loadAccounts(true);
    },
    [loadAccounts]
  );

  const renameAccount = useCallback(
    async (accountId: string, newName: string) => {
      await invokeBackend("rename_account", { accountId, newName });
      await loadAccounts(true);
    },
    [loadAccounts]
  );

  const importFromFile = useCallback(
    async (source: FileSource, name: string) => {
      if (typeof source === "string") {
        await invokeBackend<AccountInfo>("add_account_from_file", { path: source, name });
      } else {
        const contents = await source.text();
        await invokeBackend<AccountInfo>("add_account_from_auth_json_text", {
          name,
          contents,
        });
      }
      const accountList = await loadAccounts();
      await refreshUsage(accountList);
    },
    [loadAccounts, refreshUsage]
  );

  const startOAuthLogin = useCallback(
    (accountName: string, reauthAccountId?: string) =>
      invokeBackend<{ auth_url: string; callback_port: number }>("start_login", {
        accountName,
        reauthAccountId,
      }),
    []
  );

  const completeOAuthLogin = useCallback(async () => {
    const account = await invokeBackend<AccountInfo>("complete_login");
    const accountList = await loadAccounts();
    await refreshUsage(accountList);
    return account;
  }, [loadAccounts, refreshUsage]);

  const cancelOAuthLogin = useCallback(() => invokeBackend<void>("cancel_login"), []);

  const exportAccountsSlimText = useCallback(
    () => invokeBackend<string>("export_accounts_slim_text"),
    []
  );

  const importAccountsSlimText = useCallback(
    async (payload: string) => {
      const summary = await invokeBackend<ImportAccountsSummary>("import_accounts_slim_text", {
        payload,
      });
      const accountList = await loadAccounts();
      await refreshUsage(accountList);
      return summary;
    },
    [loadAccounts, refreshUsage]
  );

  const loadMaskedAccountIds = useCallback(async () => {
    try {
      return await invokeBackend<string[]>("get_masked_account_ids");
    } catch (err) {
      console.error("Failed to load masked account IDs:", err);
      return [];
    }
  }, []);

  const saveMaskedAccountIds = useCallback(async (ids: string[]) => {
    try {
      await invokeBackend("set_masked_account_ids", { ids });
    } catch (err) {
      console.error("Failed to save masked account IDs:", err);
    }
  }, []);

  useEffect(() => {
    loadAccounts().then((accountList) => {
      void refreshUsage(accountList);
      void refreshMetadata(accountList);
    });

    const usageInterval = setInterval(() => {
      refreshUsage().catch(() => {});
    }, 60_000);

    const metadataInterval = !isTauriRuntime()
      ? setInterval(() => {
          refreshMetadata().catch(() => {});
        }, 6 * 60 * 60 * 1000)
      : undefined;

    return () => {
      clearInterval(usageInterval);
      if (metadataInterval !== undefined) clearInterval(metadataInterval);
    };
  }, [loadAccounts, refreshMetadata, refreshUsage]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;

    void (async () => {
      if (!isTauriRuntime()) return;
      const { listen } = await import("@tauri-apps/api/event");
      unlisten = await listen("accounts-changed", () => {
        void loadAccounts(true);
      });
    })();

    return () => unlisten?.();
  }, [loadAccounts]);

  return {
    accounts,
    loading,
    error,
    loadAccounts,
    refreshUsage,
    refreshSingleUsage,
    warmupAccount,
    warmupAllAccounts,
    switchAccount,
    deleteAccount,
    renameAccount,
    importFromFile,
    exportAccountsSlimText,
    importAccountsSlimText,
    startOAuthLogin,
    completeOAuthLogin,
    cancelOAuthLogin,
    loadMaskedAccountIds,
    saveMaskedAccountIds,
  };
}
