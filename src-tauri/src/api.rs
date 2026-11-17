//! Usage API client for fetching rate limits, account metadata, and warm-up requests

use anyhow::{Context, Result};
use chrono::{DateTime, Utc};
use reqwest::{
    header::{HeaderMap, HeaderName, HeaderValue, AUTHORIZATION, USER_AGENT},
    StatusCode,
};
use serde::Deserialize;
use serde_json::json;
use std::collections::HashMap;

use crate::auth::{ensure_chatgpt_tokens_fresh, refresh_chatgpt_tokens};
use crate::types::{
    AuthData, RateLimitDetails, RateLimitStatusPayload, RateLimitWindow, StoredAccount, UsageInfo,
};

const CHATGPT_BACKEND_API: &str = "https://chatgpt.com/backend-api";
const CHATGPT_ACCOUNTS_CHECK_API: &str =
    "https://chatgpt.com/backend-api/accounts/check/v4-2023-04-27";
const CHATGPT_CODEX_RESPONSES_API: &str = "https://chatgpt.com/backend-api/codex/responses";
const OPENAI_API: &str = "https://api.openai.com/v1";
const CHATGPT_ORIGIN: &str = "https://chatgpt.com";

/// A browser-like User-Agent to avoid Cloudflare bot detection.
const BROWSER_USER_AGENT: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) \
     AppleWebKit/537.36 (KHTML, like Gecko) \
     Chrome/136.0.0.0 Safari/537.36";
const SESSION_WINDOW_SECONDS: i32 = 5 * 60 * 60;
const WEEKLY_WINDOW_SECONDS: i32 = 7 * 24 * 60 * 60;

#[derive(Debug, Clone)]
pub struct ChatGptAccountMetadata {
    pub plan_type: Option<String>,
    pub subscription_expires_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Deserialize)]
struct AccountsCheckResponse {
    #[serde(default)]
    accounts: HashMap<String, AccountsCheckEntry>,
}

#[derive(Debug, Deserialize)]
struct AccountsCheckEntry {
    #[serde(default)]
    account: Option<AccountsCheckAccount>,
    #[serde(default)]
    entitlement: Option<AccountsCheckEntitlement>,
}

#[derive(Debug, Deserialize)]
struct AccountsCheckAccount {
    #[serde(default)]
    plan_type: Option<String>,
}

#[derive(Debug, Deserialize)]
struct AccountsCheckEntitlement {
    #[serde(default)]
    expires_at: Option<DateTime<Utc>>,
}

/// Get usage information for an account
pub async fn get_account_usage(account: &StoredAccount) -> Result<UsageInfo> {
    match &account.auth_data {
        AuthData::ApiKey { .. } => Ok(UsageInfo {
            account_id: account.id.clone(),
            plan_type: Some("api_key".to_string()),
            primary_used_percent: None,
            primary_window_minutes: None,
            primary_resets_at: None,
            secondary_used_percent: None,
            secondary_window_minutes: None,
            secondary_resets_at: None,
            has_credits: None,
            unlimited_credits: None,
            credits_balance: None,
            error: Some("Usage info not available for API key accounts".to_string()),
        }),
        AuthData::ChatGPT { .. } => get_usage_with_chatgpt_auth(account).await,
    }
}

/// Send a minimal authenticated request to warm up account traffic paths.
pub async fn warmup_account(account: &StoredAccount) -> Result<()> {
    match &account.auth_data {
        AuthData::ApiKey { key } => warmup_with_api_key(key).await,
        AuthData::ChatGPT { .. } => warmup_with_chatgpt_auth(account).await,
    }
}

pub async fn fetch_chatgpt_account_metadata(
    account: &StoredAccount,
) -> Result<ChatGptAccountMetadata> {
    let (access_token, chatgpt_account_id) = extract_chatgpt_auth(account)?;
    let response =
        send_chatgpt_get_request(CHATGPT_ACCOUNTS_CHECK_API, access_token, chatgpt_account_id)
            .await?;

    let status = response.status();
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        if status == StatusCode::FORBIDDEN {
            anyhow::bail!(
                "Accounts check API returned 403 Forbidden. \
                 The request was likely blocked by Cloudflare bot detection. \
                 This is a transient network issue — please try again in a moment."
            );
        }
        anyhow::bail!("Accounts check API error: {status} - {body}");
    }

    let payload: AccountsCheckResponse = response
        .json()
        .await
        .context("Failed to parse accounts check response")?;

    let selected_entry = chatgpt_account_id
        .and_then(|account_id| payload.accounts.get(account_id))
        .or_else(|| payload.accounts.get("default"))
        .or_else(|| payload.accounts.values().next())
        .context("Accounts check response did not include an account entry")?;

    Ok(ChatGptAccountMetadata {
        plan_type: selected_entry
            .account
            .as_ref()
            .and_then(|account| account.plan_type.clone()),
        subscription_expires_at: selected_entry
            .entitlement
            .as_ref()
            .and_then(|entitlement| entitlement.expires_at),
    })
}

async fn get_usage_with_chatgpt_auth(account: &StoredAccount) -> Result<UsageInfo> {
    let fresh_account = ensure_chatgpt_tokens_fresh(account).await?;
    let (access_token, chatgpt_account_id) = extract_chatgpt_auth(&fresh_account)?;

    let response = send_chatgpt_usage_request(access_token, chatgpt_account_id).await?;

    // 401 means the token is genuinely expired — refresh and retry once.
    // 403 is a Cloudflare challenge or permissions error; refreshing on 403
    // would burn a single-use refresh token unnecessarily.
    if response.status() == StatusCode::UNAUTHORIZED {
        let refreshed_account = refresh_chatgpt_tokens(&fresh_account).await?;
        let (retry_token, retry_account_id) = extract_chatgpt_auth(&refreshed_account)?;
        let retry_response = send_chatgpt_usage_request(retry_token, retry_account_id).await?;
        return parse_usage_response(&refreshed_account.id, retry_response).await;
    }

    parse_usage_response(&fresh_account.id, response).await
}

async fn parse_usage_response(account_id: &str, response: reqwest::Response) -> Result<UsageInfo> {
    let status = response.status();

    if !status.is_success() {
        return Ok(UsageInfo::error(
            account_id.to_string(),
            format!("API error: {status}"),
        ));
    }

    let body_text = response
        .text()
        .await
        .context("Failed to read response body")?;

    let payload: RateLimitStatusPayload =
        serde_json::from_str(&body_text).context("Failed to parse usage response")?;

    Ok(convert_payload_to_usage_info(account_id, payload))
}

async fn warmup_with_chatgpt_auth(account: &StoredAccount) -> Result<()> {
    let fresh_account = ensure_chatgpt_tokens_fresh(account).await?;
    let (access_token, chatgpt_account_id) = extract_chatgpt_auth(&fresh_account)?;

    let mut response = send_chatgpt_warmup_request(access_token, chatgpt_account_id, true).await?;

    if response.status() == StatusCode::UNAUTHORIZED {
        let refreshed_account = refresh_chatgpt_tokens(&fresh_account).await?;
        let (retry_token, retry_account_id) = extract_chatgpt_auth(&refreshed_account)?;
        response = send_chatgpt_warmup_request(retry_token, retry_account_id, true).await?;
    }

    if !response.status().is_success() {
        let status = response.status();
        anyhow::bail!("ChatGPT warm-up failed with status {status}");
    }

    let _ = response.bytes().await;
    Ok(())
}

async fn warmup_with_api_key(api_key: &str) -> Result<()> {
    let client = reqwest::Client::new();
    let payload = build_warmup_payload(false, true);
    let response = client
        .post(format!("{OPENAI_API}/responses"))
        .header(USER_AGENT, BROWSER_USER_AGENT)
        .header(AUTHORIZATION, format!("Bearer {api_key}"))
        .json(&payload)
        .send()
        .await
        .context("Failed to send API key warm-up request")?;

    if !response.status().is_success() {
        let status = response.status();
        anyhow::bail!("API key warm-up failed with status {status}");
    }

    let _ = response.bytes().await;
    Ok(())
}

fn build_warmup_payload(stream: bool, include_max_output_tokens: bool) -> serde_json::Value {
    let mut payload = json!({
        "model": "gpt-6-luna",
        "instructions": "You are Codex.",
        "input": [
            {
                "type": "message",
                "role": "user",
                "content": [
                    {
                        "type": "input_text",
                        "text": "Thanks"
                    }
                ]
            }
        ],
        "tools": [],
        "tool_choice": "auto",
        "parallel_tool_calls": false,
        "reasoning": {
            "effort": "low"
        },
        "store": false,
        "stream": stream
    });

    if include_max_output_tokens {
        if let Some(obj) = payload.as_object_mut() {
            obj.insert("max_output_tokens".to_string(), json!(1));
        }
    }

    payload
}

fn build_chatgpt_headers(
    access_token: &str,
    chatgpt_account_id: Option<&str>,
) -> Result<HeaderMap> {
    use reqwest::header::{ACCEPT, ACCEPT_LANGUAGE, ORIGIN, REFERER};

    let mut headers = HeaderMap::new();
    headers.insert(USER_AGENT, HeaderValue::from_static(BROWSER_USER_AGENT));
    headers.insert(
        AUTHORIZATION,
        HeaderValue::from_str(&format!("Bearer {access_token}")).context("Invalid access token")?,
    );
    headers.insert(
        ACCEPT,
        HeaderValue::from_static("application/json, text/plain, */*"),
    );
    headers.insert(ACCEPT_LANGUAGE, HeaderValue::from_static("en-US,en;q=0.9"));
    headers.insert(ORIGIN, HeaderValue::from_static(CHATGPT_ORIGIN));
    headers.insert(REFERER, HeaderValue::from_static(CHATGPT_ORIGIN));
    headers.insert(
        HeaderName::from_static("sec-fetch-dest"),
        HeaderValue::from_static("empty"),
    );
    headers.insert(
        HeaderName::from_static("sec-fetch-mode"),
        HeaderValue::from_static("cors"),
    );
    headers.insert(
        HeaderName::from_static("sec-fetch-site"),
        HeaderValue::from_static("same-origin"),
    );

    if let Some(acc_id) = chatgpt_account_id {
        if let Ok(header_value) = HeaderValue::from_str(acc_id) {
            headers.insert(HeaderName::from_static("chatgpt-account-id"), header_value);
        }
    }

    Ok(headers)
}

pub(crate) fn extract_chatgpt_auth(account: &StoredAccount) -> Result<(&str, Option<&str>)> {
    match &account.auth_data {
        AuthData::ChatGPT {
            access_token,
            account_id,
            ..
        } => Ok((access_token.as_str(), account_id.as_deref())),
        AuthData::ApiKey { .. } => anyhow::bail!("Account is not using ChatGPT OAuth"),
    }
}

async fn send_chatgpt_usage_request(
    access_token: &str,
    chatgpt_account_id: Option<&str>,
) -> Result<reqwest::Response> {
    send_chatgpt_get_request(
        &format!("{CHATGPT_BACKEND_API}/wham/usage"),
        access_token,
        chatgpt_account_id,
    )
    .await
}

async fn send_chatgpt_get_request(
    url: &str,
    access_token: &str,
    chatgpt_account_id: Option<&str>,
) -> Result<reqwest::Response> {
    let client = reqwest::Client::new();
    let headers = build_chatgpt_headers(access_token, chatgpt_account_id)?;

    client
        .get(url)
        .headers(headers)
        // UI invoke timeouts do not cancel this request, including body reads.
        .timeout(std::time::Duration::from_secs(10))
        .send()
        .await
        .with_context(|| format!("Failed to send GET request to {url}"))
}

async fn send_chatgpt_warmup_request(
    access_token: &str,
    chatgpt_account_id: Option<&str>,
    stream: bool,
) -> Result<reqwest::Response> {
    let client = reqwest::Client::new();
    let headers = build_chatgpt_headers(access_token, chatgpt_account_id)?;
    let payload = build_warmup_payload(stream, false);

    client
        .post(CHATGPT_CODEX_RESPONSES_API)
        .headers(headers)
        .json(&payload)
        .send()
        .await
        .context("Failed to send ChatGPT warm-up request")
}

/// Convert API response to UsageInfo
fn convert_payload_to_usage_info(account_id: &str, payload: RateLimitStatusPayload) -> UsageInfo {
    let (primary, secondary) = extract_rate_limits(payload.rate_limit);
    let credits = payload.credits;

    UsageInfo {
        account_id: account_id.to_string(),
        plan_type: Some(payload.plan_type),
        primary_used_percent: primary.as_ref().map(|w| w.used_percent),
        primary_window_minutes: primary
            .as_ref()
            .and_then(|w| w.limit_window_seconds)
            .map(|s| (i64::from(s) + 59) / 60),
        primary_resets_at: primary.as_ref().and_then(|w| w.reset_at),
        secondary_used_percent: secondary.as_ref().map(|w| w.used_percent),
        secondary_window_minutes: secondary
            .as_ref()
            .and_then(|w| w.limit_window_seconds)
            .map(|s| (i64::from(s) + 59) / 60),
        secondary_resets_at: secondary.as_ref().and_then(|w| w.reset_at),
        has_credits: credits.as_ref().map(|c| c.has_credits),
        unlimited_credits: credits.as_ref().map(|c| c.unlimited),
        credits_balance: credits.and_then(|c| c.balance),
        error: None,
    }
}

fn extract_rate_limits(
    rate_limit: Option<RateLimitDetails>,
) -> (Option<RateLimitWindow>, Option<RateLimitWindow>) {
    let Some(details) = rate_limit else {
        return (None, None);
    };

    match (details.primary_window, details.secondary_window) {
        // The backend can temporarily omit the 5-hour window and promote the
        // weekly window into primary_window. Keep UsageInfo semantic so every
        // consumer still treats primary as session and secondary as weekly.
        (Some(primary), None) if is_weekly_window(&primary) => (None, Some(primary)),
        (None, Some(secondary)) if is_session_window(&secondary) => (Some(secondary), None),
        (Some(primary), Some(secondary))
            if is_weekly_window(&primary) && is_session_window(&secondary) =>
        {
            (Some(secondary), Some(primary))
        }
        (primary, secondary) => (primary, secondary),
    }
}

fn is_session_window(window: &RateLimitWindow) -> bool {
    window.limit_window_seconds == Some(SESSION_WINDOW_SECONDS)
}

fn is_weekly_window(window: &RateLimitWindow) -> bool {
    window.limit_window_seconds == Some(WEEKLY_WINDOW_SECONDS)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn usage_get_times_out_when_the_response_body_stalls() {
        use tokio::io::AsyncWriteExt;
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut connection, _) = listener.accept().await.unwrap();
            connection
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{")
                .await
                .unwrap();
            std::future::pending::<()>().await;
        });
        let result = tokio::time::timeout(std::time::Duration::from_secs(15), async {
            send_chatgpt_get_request(&format!("http://{address}/usage"), "synthetic", None)
                .await
                .unwrap()
                .text()
                .await
        })
        .await;
        server.abort();
        assert!(result
            .expect("backend GET must stop before the UI retries")
            .unwrap_err()
            .is_timeout());
    }

    fn rate_limit_window(used_percent: f64, window_seconds: i32) -> RateLimitWindow {
        RateLimitWindow {
            used_percent,
            limit_window_seconds: Some(window_seconds),
            reset_at: Some(1_800_000_000),
        }
    }

    #[test]
    fn keeps_legacy_session_and_weekly_windows_in_place() {
        let (session, weekly) = extract_rate_limits(Some(RateLimitDetails {
            primary_window: Some(rate_limit_window(27.0, SESSION_WINDOW_SECONDS)),
            secondary_window: Some(rate_limit_window(82.0, WEEKLY_WINDOW_SECONDS)),
        }));

        assert_eq!(
            session.and_then(|window| window.limit_window_seconds),
            Some(SESSION_WINDOW_SECONDS)
        );
        assert_eq!(
            weekly.and_then(|window| window.limit_window_seconds),
            Some(WEEKLY_WINDOW_SECONDS)
        );
    }

    #[test]
    fn moves_weekly_only_primary_window_to_weekly_slot() {
        let (session, weekly) = extract_rate_limits(Some(RateLimitDetails {
            primary_window: Some(rate_limit_window(35.0, WEEKLY_WINDOW_SECONDS)),
            secondary_window: None,
        }));

        assert!(session.is_none());
        assert_eq!(weekly.map(|window| window.used_percent), Some(35.0));
    }

    #[test]
    fn restores_semantic_order_if_backend_reverses_windows() {
        let (session, weekly) = extract_rate_limits(Some(RateLimitDetails {
            primary_window: Some(rate_limit_window(82.0, WEEKLY_WINDOW_SECONDS)),
            secondary_window: Some(rate_limit_window(27.0, SESSION_WINDOW_SECONDS)),
        }));

        assert_eq!(session.map(|window| window.used_percent), Some(27.0));
        assert_eq!(weekly.map(|window| window.used_percent), Some(82.0));
    }

    #[test]
    fn preserves_unknown_windows_by_backend_position() {
        let (primary, secondary) = extract_rate_limits(Some(RateLimitDetails {
            primary_window: Some(rate_limit_window(11.0, 60 * 60)),
            secondary_window: Some(rate_limit_window(22.0, 30 * 24 * 60 * 60)),
        }));

        assert_eq!(primary.map(|window| window.used_percent), Some(11.0));
        assert_eq!(secondary.map(|window| window.used_percent), Some(22.0));
    }
}
