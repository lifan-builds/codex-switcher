//! OAuth login Tauri commands

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tokio::sync::oneshot;

use crate::auth::oauth_server::{start_oauth_login, wait_for_oauth_login, OAuthLoginResult};
use crate::auth::{
    add_account, load_accounts, save_accounts, switch_to_account, AUTH_OPERATION_LOCK,
};
use crate::types::{
    parse_chatgpt_id_token_claims, AccountInfo, AuthData, OAuthLoginInfo, StoredAccount,
};

struct PendingOAuth {
    rx: Option<oneshot::Receiver<anyhow::Result<OAuthLoginResult>>>,
    cancelled: Arc<AtomicBool>,
    reauth_account_id: Option<String>,
}

static OAUTH_START_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
static PENDING_OAUTH: Mutex<Option<PendingOAuth>> = Mutex::new(None);

/// Start an add-account or targeted re-login flow.
#[tauri::command]
pub async fn start_login(
    account_name: String,
    reauth_account_id: Option<String>,
) -> Result<OAuthLoginInfo, String> {
    let _start_guard = OAUTH_START_LOCK.lock().await;
    if let Some(id) = &reauth_account_id {
        let store = load_accounts().map_err(|e| e.to_string())?;
        let account = store
            .accounts
            .iter()
            .find(|a| &a.id == id)
            .ok_or("Account no longer exists")?;
        if !matches!(account.auth_data, AuthData::ChatGPT { .. }) {
            return Err("Only ChatGPT accounts support re-login".into());
        }
        if store.active_account_id.as_ref() == Some(id) {
            ensure_active_relogin_safe()?;
        }
    }

    if let Some(previous) = PENDING_OAUTH.lock().unwrap().take() {
        previous.cancelled.store(true, Ordering::Relaxed);
    }
    let (info, rx, cancelled) = start_oauth_login(account_name.trim().to_string())
        .await
        .map_err(|e| e.to_string())?;
    *PENDING_OAUTH.lock().unwrap() = Some(PendingOAuth {
        rx: Some(rx),
        cancelled,
        reauth_account_id,
    });
    Ok(info)
}

fn ensure_active_relogin_safe() -> Result<(), String> {
    super::process::ensure_codex_not_running().map_err(|_| {
        "Close Codex or switch to another account before re-logging in to the active account."
            .into()
    })
}

/// Match both the user and workspace; workspace IDs alone can be shared by a team.
fn validate_relogin_identity(old: &StoredAccount, new: &StoredAccount) -> Result<(), String> {
    let (
        AuthData::ChatGPT {
            id_token: old_token,
            account_id: old_id,
            ..
        },
        AuthData::ChatGPT {
            id_token: new_token,
            account_id: new_id,
            ..
        },
    ) = (&old.auth_data, &new.auth_data)
    else {
        return Err("Only ChatGPT accounts support re-login".into());
    };
    let old_claims = parse_chatgpt_id_token_claims(old_token);
    let new_claims = parse_chatgpt_id_token_claims(new_token);
    let old_workspace = old_claims.account_id.as_ref().or(old_id.as_ref());
    let new_workspace = new_claims.account_id.as_ref().or(new_id.as_ref());
    let same_user = match (old_claims.subject.as_deref(), new_claims.subject.as_deref()) {
        (Some(a), Some(b)) if !a.is_empty() && !b.is_empty() => a == b,
        _ => match (old.email.as_deref(), new.email.as_deref()) {
            (Some(a), Some(b)) if !a.trim().is_empty() && !b.trim().is_empty() => {
                a.eq_ignore_ascii_case(b)
            }
            _ => false,
        },
    };
    if !same_user || old_workspace.is_none_or(|id| id.is_empty()) || old_workspace != new_workspace
    {
        return Err("Login does not match this account and workspace. Sign in with the original account and select the same workspace.".into());
    }
    Ok(())
}

fn save_relogin(id: &str, new: StoredAccount) -> Result<StoredAccount, String> {
    save_relogin_with_check(id, new, ensure_active_relogin_safe)
}

fn save_relogin_with_check(
    id: &str,
    new: StoredAccount,
    check_active: impl FnOnce() -> Result<(), String>,
) -> Result<StoredAccount, String> {
    let mut store = load_accounts().map_err(|e| e.to_string())?;
    let active = store.active_account_id.as_deref() == Some(id);
    let account = store
        .accounts
        .iter_mut()
        .find(|a| a.id == id)
        .ok_or("Account no longer exists")?;
    validate_relogin_identity(account, &new)?;
    if active {
        check_active()?;
    }
    account.auth_data = new.auth_data;
    account.email = new.email;
    account.plan_type = new.plan_type;
    account.subscription_expires_at = new.subscription_expires_at;
    let updated = account.clone();
    if active {
        // Live auth is the source of truth during reconciliation. Write it first
        // so an I/O failure cannot later replace renewed tokens with stale ones.
        switch_to_account(&updated).map_err(|e| {
            format!("Could not update Codex auth; saved account was not changed: {e}")
        })?;
    }
    save_accounts(&store).map_err(|e| {
        if active {
            format!("Codex login renewed, but saving the account failed: {e}. Refresh usage to sync it again.")
        } else {
            e.to_string()
        }
    })?;
    Ok(updated)
}

/// Keep cancellation reachable while awaiting the browser and the auth lock.
#[tauri::command]
pub async fn complete_login() -> Result<AccountInfo, String> {
    let (rx, cancelled, reauth_account_id) = {
        let mut pending = PENDING_OAUTH.lock().unwrap();
        let pending = pending.as_mut().ok_or("No pending OAuth login")?;
        (
            pending
                .rx
                .take()
                .ok_or("OAuth login is already being completed")?,
            pending.cancelled.clone(),
            pending.reauth_account_id.clone(),
        )
    };
    let result = async {
        let account = wait_for_oauth_login(rx).await.map_err(|e| e.to_string())?;
        let _auth_guard = AUTH_OPERATION_LOCK.lock().await;
        if cancelled.load(Ordering::Relaxed) {
            return Err("OAuth login cancelled".into());
        }
        let stored = if let Some(id) = reauth_account_id {
            save_relogin(&id, account)?
        } else {
            add_account(account).map_err(|e| e.to_string())?
        };
        let store = load_accounts().map_err(|e| e.to_string())?;
        Ok(AccountInfo::from_stored(
            &stored,
            store.active_account_id.as_deref(),
        ))
    }
    .await;
    let mut pending = PENDING_OAUTH.lock().unwrap();
    if pending
        .as_ref()
        .is_some_and(|p| Arc::ptr_eq(&p.cancelled, &cancelled))
    {
        pending.take();
    }
    result
}

#[tauri::command]
pub async fn cancel_login() -> Result<(), String> {
    let _start_guard = OAUTH_START_LOCK.lock().await;
    if let Some(pending) = PENDING_OAUTH.lock().unwrap().take() {
        pending.cancelled.store(true, Ordering::Relaxed);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::auth::test_support::TestHome;
    use crate::auth::{get_accounts_file, get_codex_auth_file, save_accounts, switch_to_account};
    use crate::types::{AccountsStore, AuthData, StoredAccount};
    use std::fs;

    // PENDING_OAUTH is process-wide; each test keeps its filesystem on its own thread.
    static OAUTH_TEST_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

    fn account(name: &str) -> StoredAccount {
        StoredAccount::new_chatgpt(
            name.into(),
            None,
            None,
            None,
            format!("test-id-{name}"),
            format!("test-access-{name}"),
            format!("test-refresh-{name}"),
            Some(format!("test-workspace-{name}")),
        )
    }

    fn complete_with(result: anyhow::Result<OAuthLoginResult>) {
        let (tx, rx) = oneshot::channel();
        assert!(tx.send(result).is_ok());
        *PENDING_OAUTH.lock().unwrap() = Some(PendingOAuth {
            rx: Some(rx),
            reauth_account_id: None,
            cancelled: Arc::new(AtomicBool::new(false)),
        });
    }

    #[tokio::test(flavor = "current_thread")]
    async fn adding_oauth_account_preserves_active_account_and_live_auth() {
        let _lock = OAUTH_TEST_LOCK.lock().await;
        let _home = TestHome::new();
        let mut active = account("A");
        active.last_used_at = Some("2026-01-01T00:00:00Z".parse().unwrap());
        save_accounts(&AccountsStore {
            accounts: vec![active.clone()],
            active_account_id: Some(active.id.clone()),
            ..AccountsStore::default()
        })
        .unwrap();

        // The live session may contain newer tokens than the saved account snapshot.
        let mut live = active.clone();
        if let AuthData::ChatGPT {
            access_token,
            refresh_token,
            ..
        } = &mut live.auth_data
        {
            *access_token = "test-access-A-rotated".into();
            *refresh_token = "test-refresh-A-rotated".into();
        }
        switch_to_account(&live).unwrap();
        let auth_path = get_codex_auth_file().unwrap();
        let auth_before = fs::read(&auth_path).unwrap();
        complete_with(Ok(OAuthLoginResult {
            account: account("B"),
        }));

        let added = complete_login().await.unwrap();
        let store = load_accounts().unwrap();
        assert_eq!(store.active_account_id.as_deref(), Some(active.id.as_str()));
        assert_eq!(fs::read(auth_path).unwrap(), auth_before);
        assert_eq!(store.accounts.len(), 2);
        assert_eq!(
            serde_json::to_value(&store.accounts[0]).unwrap(),
            serde_json::to_value(active).unwrap()
        );
        assert_eq!(store.accounts[1].id, added.id);
        assert!(!added.is_active);
        assert!(store.accounts[1].last_used_at.is_none());
    }

    #[tokio::test(flavor = "current_thread")]
    async fn adding_first_oauth_account_does_not_activate_or_create_auth() {
        let _lock = OAUTH_TEST_LOCK.lock().await;
        let _home = TestHome::new();
        complete_with(Ok(OAuthLoginResult {
            account: account("first"),
        }));

        let added = complete_login().await.unwrap();
        let store = load_accounts().unwrap();
        assert!(store.active_account_id.is_none());
        assert!(!get_codex_auth_file().unwrap().exists());
        assert_eq!(store.accounts.len(), 1);
        assert_eq!(store.accounts[0].id, added.id);
        assert!(!added.is_active);
        assert!(store.accounts[0].last_used_at.is_none());
    }

    #[tokio::test(flavor = "current_thread")]
    async fn adding_oauth_account_preserves_no_active_account_and_external_auth() {
        let _lock = OAUTH_TEST_LOCK.lock().await;
        let _home = TestHome::new();
        save_accounts(&AccountsStore {
            accounts: vec![account("saved")],
            ..AccountsStore::default()
        })
        .unwrap();
        switch_to_account(&account("external")).unwrap();
        let auth_path = get_codex_auth_file().unwrap();
        let auth_before = fs::read(&auth_path).unwrap();
        complete_with(Ok(OAuthLoginResult {
            account: account("new"),
        }));

        let added = complete_login().await.unwrap();
        let store = load_accounts().unwrap();
        assert!(store.active_account_id.is_none());
        assert_eq!(fs::read(auth_path).unwrap(), auth_before);
        assert_eq!(store.accounts.len(), 2);
        assert!(!added.is_active);
        assert!(store.accounts[1].last_used_at.is_none());
    }

    #[tokio::test(flavor = "current_thread")]
    async fn duplicate_or_failed_oauth_login_leaves_storage_and_auth_unchanged() {
        let _lock = OAUTH_TEST_LOCK.lock().await;
        let _home = TestHome::new();
        let active = account("A");
        save_accounts(&AccountsStore {
            accounts: vec![active.clone()],
            active_account_id: Some(active.id.clone()),
            ..AccountsStore::default()
        })
        .unwrap();
        switch_to_account(&active).unwrap();
        let store_path = get_accounts_file().unwrap();
        let auth_path = get_codex_auth_file().unwrap();
        let store_before = fs::read(&store_path).unwrap();
        let auth_before = fs::read(&auth_path).unwrap();

        for result in [
            Ok(OAuthLoginResult {
                account: account("A"),
            }),
            Err(anyhow::anyhow!("synthetic OAuth failure")),
        ] {
            complete_with(result);
            assert!(complete_login().await.is_err());
            assert_eq!(fs::read(&store_path).unwrap(), store_before);
            assert_eq!(fs::read(&auth_path).unwrap(), auth_before);
        }
    }

    fn relogin_result(target: &StoredAccount, mut fresh: StoredAccount) {
        // Fixtures use non-JWT tokens, so the identity check falls back to email.
        fresh.email = Some("same@example.test".into());
        complete_with(Ok(OAuthLoginResult { account: fresh }));
        PENDING_OAUTH
            .lock()
            .unwrap()
            .as_mut()
            .unwrap()
            .reauth_account_id = Some(target.id.clone());
    }

    #[tokio::test(flavor = "current_thread")]
    async fn relogin_updates_in_place_without_touching_other_accounts_or_live_auth() {
        let _lock = OAUTH_TEST_LOCK.lock().await;
        let _home = TestHome::new();
        let active = account("active");
        let mut old = account("renew");
        old.email = Some("same@example.test".into());
        old.last_used_at = Some("2026-01-01T00:00:00Z".parse().unwrap());
        save_accounts(&AccountsStore {
            accounts: vec![active.clone(), old.clone()],
            active_account_id: Some(active.id.clone()),
            masked_account_ids: vec![old.id.clone()],
            ..AccountsStore::default()
        })
        .unwrap();
        switch_to_account(&active).unwrap();
        let auth_before = fs::read(get_codex_auth_file().unwrap()).unwrap();
        let mut fresh = account("renew");
        fresh.plan_type = Some("pro".into());
        if let AuthData::ChatGPT { refresh_token, .. } = &mut fresh.auth_data {
            *refresh_token = "renewed-test-refresh".into();
        }
        relogin_result(&old, fresh.clone());
        let info = complete_login().await.unwrap();
        let store = load_accounts().unwrap();
        assert_eq!(info.id, old.id);
        assert_eq!(store.accounts.len(), 2);
        assert_eq!(store.active_account_id, Some(active.id.clone()));
        assert_eq!(store.masked_account_ids, vec![old.id.clone()]);
        let updated = &store.accounts[1];
        assert_eq!(updated.name, old.name);
        assert_eq!(updated.created_at, old.created_at);
        assert_eq!(updated.last_used_at, old.last_used_at);
        assert_eq!(updated.plan_type, fresh.plan_type);
        assert_eq!(
            serde_json::to_value(&updated.auth_data).unwrap(),
            serde_json::to_value(&fresh.auth_data).unwrap()
        );
        assert_eq!(
            serde_json::to_value(&store.accounts[0]).unwrap(),
            serde_json::to_value(&active).unwrap()
        );
        assert_eq!(
            fs::read(get_codex_auth_file().unwrap()).unwrap(),
            auth_before
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn relogin_rejects_wrong_workspace_missing_account_and_cancelled_result() {
        let _lock = OAUTH_TEST_LOCK.lock().await;
        let _home = TestHome::new();
        let mut old = account("renew");
        old.email = Some("same@example.test".into());
        save_accounts(&AccountsStore {
            accounts: vec![old.clone()],
            ..AccountsStore::default()
        })
        .unwrap();
        let before = fs::read(get_accounts_file().unwrap()).unwrap();
        relogin_result(&old, account("wrong-workspace"));
        assert!(complete_login()
            .await
            .unwrap_err()
            .contains("does not match"));
        assert_eq!(fs::read(get_accounts_file().unwrap()).unwrap(), before);
        relogin_result(&account("deleted"), account("renew"));
        assert!(complete_login()
            .await
            .unwrap_err()
            .contains("no longer exists"));
        assert_eq!(fs::read(get_accounts_file().unwrap()).unwrap(), before);

        // Cancellation must remain reachable after complete_login takes the receiver,
        // including when the OAuth result is waiting for another auth operation.
        relogin_result(&old, account("renew"));
        let guard = AUTH_OPERATION_LOCK.lock().await;
        let completion = complete_login();
        tokio::pin!(completion);
        tokio::select! {
            biased;
            _ = &mut completion => panic!("must wait for auth lock"),
            _ = tokio::task::yield_now() => {},
        }
        cancel_login().await.unwrap();
        drop(guard);
        assert!(completion.await.unwrap_err().contains("cancelled"));
        assert_eq!(fs::read(get_accounts_file().unwrap()).unwrap(), before);
        assert!(!get_codex_auth_file().unwrap().exists());
    }

    #[test]
    fn relogin_matches_user_and_workspace_and_fails_closed_without_identity() {
        use base64::Engine;
        fn user(subject: &str, workspace: &str) -> StoredAccount {
            let mut a = account("same");
            a.email = Some("same@example.test".into());
            if let AuthData::ChatGPT {
                id_token,
                account_id,
                ..
            } = &mut a.auth_data
            {
                let payload = serde_json::json!({"sub": subject});
                *id_token = format!(
                    "e30.{}.signature",
                    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(payload.to_string())
                );
                *account_id = Some(workspace.into());
            }
            a
        }
        assert!(validate_relogin_identity(&user("u1", "w1"), &user("u1", "w1")).is_ok());
        assert!(validate_relogin_identity(&user("u1", "w1"), &user("u2", "w1")).is_err());
        assert!(validate_relogin_identity(&user("u1", "w1"), &user("u1", "w2")).is_err());
        assert!(validate_relogin_identity(&user("u1", ""), &user("u1", "")).is_err());
        assert!(validate_relogin_identity(&account("same"), &account("same")).is_err());
        let mut old = account("same");
        old.email = Some("old@example.test".into());
        let mut new = account("same");
        new.email = Some("new@example.test".into());
        assert!(validate_relogin_identity(&old, &new).is_err());
        assert!(validate_relogin_identity(
            &old,
            &StoredAccount::new_api_key("key".into(), "test".into())
        )
        .is_err());
    }

    #[test]
    fn active_relogin_checks_process_safety_and_syncs_live_auth() {
        let _home = TestHome::new();
        let mut old = account("active");
        old.email = Some("same@example.test".into());
        save_accounts(&AccountsStore {
            accounts: vec![old.clone()],
            active_account_id: Some(old.id.clone()),
            ..AccountsStore::default()
        })
        .unwrap();
        switch_to_account(&old).unwrap();
        let auth_before = fs::read(get_codex_auth_file().unwrap()).unwrap();
        let store_before = fs::read(get_accounts_file().unwrap()).unwrap();
        let mut fresh = old.clone();
        if let AuthData::ChatGPT { refresh_token, .. } = &mut fresh.auth_data {
            *refresh_token = "renewed-active-refresh".into();
        }
        assert!(
            save_relogin_with_check(&old.id, fresh.clone(), || Err("Codex running".into()))
                .is_err()
        );
        assert_eq!(
            fs::read(get_codex_auth_file().unwrap()).unwrap(),
            auth_before
        );
        assert_eq!(
            fs::read(get_accounts_file().unwrap()).unwrap(),
            store_before
        );
        let saved = save_relogin_with_check(&old.id, fresh, || Ok(())).unwrap();
        assert_eq!(saved.id, old.id);
        let store = load_accounts().unwrap();
        assert_eq!(store.active_account_id, Some(old.id));
        let auth = crate::auth::read_current_auth().unwrap().unwrap();
        assert_eq!(auth.tokens.unwrap().refresh_token, "renewed-active-refresh");
        let mut reconciled = store.clone();
        assert!(!crate::auth::sync_active_account_tokens(
            &mut reconciled,
            &crate::auth::read_current_auth().unwrap().unwrap()
        ));
    }

    #[test]
    fn active_relogin_auth_write_failure_leaves_saved_credentials_unchanged() {
        let _home = TestHome::new();
        let mut old = account("active");
        old.email = Some("same@example.test".into());
        save_accounts(&AccountsStore {
            accounts: vec![old.clone()],
            active_account_id: Some(old.id.clone()),
            ..AccountsStore::default()
        })
        .unwrap();
        let before = fs::read(get_accounts_file().unwrap()).unwrap();
        fs::create_dir_all(get_codex_auth_file().unwrap()).unwrap();
        assert!(save_relogin_with_check(&old.id, old.clone(), || Ok(()))
            .unwrap_err()
            .contains("saved account was not changed"));
        assert_eq!(fs::read(get_accounts_file().unwrap()).unwrap(), before);
    }

    #[test]
    fn inactive_relogin_never_requires_closing_codex() {
        let _home = TestHome::new();
        let mut old = account("inactive");
        old.email = Some("same@example.test".into());
        save_accounts(&AccountsStore {
            accounts: vec![old.clone()],
            ..AccountsStore::default()
        })
        .unwrap();
        save_relogin_with_check(&old.id, old.clone(), || {
            panic!("inactive account must not check running Codex")
        })
        .unwrap();
        assert!(!get_codex_auth_file().unwrap().exists());
    }
}
