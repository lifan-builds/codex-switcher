//! Wake quota validation promptly when a live rollout records a usage-limit stop.
//! Signals are hints only: the account's quota is still verified before switching.

use std::collections::HashSet;
use std::fs;
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
use std::path::Path;
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, SystemTime};
use tauri::{AppHandle, Emitter};

static MONITORS: LazyLock<Mutex<HashSet<String>>> = LazyLock::new(|| Mutex::new(HashSet::new()));
const INTERVAL: Duration = Duration::from_secs(5);
// This is only a wake-up hint; periodic quota checks cover older/larger records.
const TAIL_BYTES: u64 = 64 * 1024;

#[tauri::command]
pub fn set_quota_monitor(monitor_id: String, enabled: bool) -> Result<(), String> {
    uuid::Uuid::parse_str(&monitor_id).map_err(|_| "Invalid quota monitor ID")?;
    let mut monitors = MONITORS.lock().map_err(|error| error.to_string())?;
    if enabled {
        monitors.insert(monitor_id);
    } else {
        monitors.remove(&monitor_id);
    }
    Ok(())
}

pub fn start(app: AppHandle) {
    std::thread::spawn(move || {
        let mut since = SystemTime::now();
        loop {
            std::thread::sleep(INTERVAL);
            let now = SystemTime::now();
            if MONITORS.lock().is_ok_and(|monitors| !monitors.is_empty()) {
                let stopped = crate::auth::get_codex_home()
                    .is_ok_and(|home| recently_stopped(&home.join("sessions"), since, now));
                let _ = app.emit("quota-auto-switch-tick", stopped);
            }
            since = now;
        }
    });
}

fn recently_stopped(root: &Path, since: SystemTime, now: SystemTime) -> bool {
    let Ok(entries) = fs::read_dir(root) else {
        return false;
    };
    for entry in entries.flatten() {
        let Ok(kind) = entry.file_type() else {
            continue;
        };
        let path = entry.path();
        if kind.is_dir() {
            if recently_stopped(&path, since, now) {
                return true;
            }
        } else if kind.is_file()
            && path.extension().is_some_and(|ext| ext == "jsonl")
            && entry
                .metadata()
                .and_then(|meta| meta.modified())
                .is_ok_and(|modified| modified > since && modified <= now)
            && super::session_recovery::session_id(&path).is_some()
            && tail_is_stopped(&path)
        {
            return true;
        }
    }
    false
}

fn tail_is_stopped(path: &Path) -> bool {
    let Ok(mut file) = fs::File::open(path) else {
        return false;
    };
    let Ok(metadata) = file.metadata() else {
        return false;
    };
    let start = metadata.len().saturating_sub(TAIL_BYTES);
    if file.seek(SeekFrom::Start(start)).is_err() {
        return false;
    }
    let mut reader = BufReader::new(file.take(metadata.len() - start));
    if start > 0 && reader.read_line(&mut String::new()).is_err() {
        return false;
    }
    let mut failed = false;
    let stopped =
        super::session_recovery::has_usage_limit_failure_lines(reader.lines().map_while(|line| {
            match line {
                Ok(line) => Some(line),
                Err(_) => {
                    failed = true;
                    None
                }
            }
        }));
    stopped && !failed
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::io::Write;

    fn event(payload: serde_json::Value) -> String {
        format!("{}\n", json!({"type":"event_msg", "payload":payload}))
    }

    #[test]
    fn only_fresh_top_level_stops_wake_the_monitor() {
        let root =
            std::env::temp_dir().join(format!("switcher-quota-monitor-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let path = root.join("rollout.jsonl");
        let meta =
            json!({"type":"session_meta", "payload":{"id":uuid::Uuid::new_v4(), "source":"cli"}});
        let error = event(
            json!({"type":"error", "message":"You've hit your usage limit. Review your workspace's usage settings to continue."}),
        );
        let now = SystemTime::now();
        let since = now - Duration::from_secs(10);
        let modified = now - Duration::from_secs(1);
        let write = |contents: &str, time: SystemTime| {
            let mut file = fs::File::create(&path).unwrap();
            file.write_all(contents.as_bytes()).unwrap();
            file.set_times(fs::FileTimes::new().set_modified(time))
                .unwrap();
        };

        write(&format!("{meta}\n{error}"), modified);
        assert!(recently_stopped(&root, since, now));
        assert!(!recently_stopped(&root, now, now + INTERVAL));
        write(&format!("{meta}\n{error}"), since - INTERVAL);
        assert!(!recently_stopped(&root, since, now));

        for suffix in [
            event(json!({"type":"task_started"})),
            event(json!({"type":"task_complete"})),
            "{partial".into(),
        ] {
            write(&format!("{meta}\n{error}{suffix}"), modified);
            assert!(!recently_stopped(&root, since, now));
        }
        write(
            &format!(
                "{meta}\n{}",
                event(json!({"type":"user_message", "message":"You've hit your usage limit."}))
            ),
            modified,
        );
        assert!(!recently_stopped(&root, since, now));
        let mut child = meta.clone();
        child["payload"]["agent_path"] = json!("/root/worker");
        write(&format!("{child}\n{error}"), modified);
        assert!(!recently_stopped(&root, since, now));

        // Large old history is not parsed, and a later continuation still clears the stop.
        let padding = "x".repeat(TAIL_BYTES as usize);
        write(&format!("{meta}\n{padding}\n{error}"), modified);
        assert!(recently_stopped(&root, since, now));
        write(
            &format!(
                "{meta}\n{padding}\n{error}{}",
                event(json!({"type":"turn_started"}))
            ),
            modified,
        );
        assert!(!recently_stopped(&root, since, now));
        fs::remove_dir_all(root).unwrap();
    }
}
