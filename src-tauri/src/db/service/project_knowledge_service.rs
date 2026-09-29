//! Project knowledge: deterministic extraction of a project's command profile
//! from its own conversation history.
//!
//! Why commands first: "how do I build / test / lint this project" is the
//! highest-frequency thing an agent re-discovers every session — and the
//! answer is ALREADY structured in the transcripts, because every shell tool
//! call carries its command. So the extractor is a whitelist classifier over
//! tool-call inputs, not an LLM pass: results are deterministic, auditable,
//! and free.
//!
//! The report feeds the AGENTS.md section writer (next stage): written into
//! the project's rules file, every agent on the project reads it natively —
//! the rules mechanism IS the injection path, no prompt plumbing required.

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use regex::Regex;
use sea_orm::{ColumnTrait, DatabaseConnection, EntityTrait, QueryFilter, QueryOrder};
use sha2::{Digest, Sha256};

use crate::db::entities::conversation;
use crate::db::error::DbError;
use crate::db::service::folder_service;
use crate::models::agent::AgentType;
use crate::models::message::ContentBlock;

/// One command found across the project's sessions.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct ProjectCommand {
    /// The command segment as it ran (first classified segment, capped).
    pub command: String,
    /// build | test | lint | typecheck | dev | install | other
    pub category: String,
    /// Total sightings across all scanned sessions.
    pub occurrences: usize,
    /// Number of distinct sessions the command appeared in.
    pub sessions: usize,
}

#[derive(Debug, Default, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct ProjectCommandsReport {
    pub folder_id: i32,
    pub scanned_sessions: usize,
    pub commands: Vec<ProjectCommand>,
}

/// Default session scan cap: recent sessions carry the current toolchain; an
/// unbounded scan would re-parse every transcript the project ever wrote.
pub const DEFAULT_MAX_SESSIONS: usize = 20;
/// Upper bound on returned commands (enough for a rules section, not a dump).
pub const MAX_COMMANDS: usize = 24;
/// Display cap for one command segment.
const COMMAND_DISPLAY_CAP: usize = 140;

/// Scan the folder's most recent sessions and aggregate their shell commands.
///
/// Best-effort per session (a conversation without an external id or with an
/// unreadable transcript is skipped, not fatal). Parsing is synchronous with
/// the parser scoped away from every await, so the returned future stays Send.
pub async fn collect_project_commands(
    conn: &DatabaseConnection,
    folder_id: i32,
    max_sessions: usize,
) -> Result<ProjectCommandsReport, DbError> {
    let max_sessions = max_sessions.clamp(1, 200);
    let candidates = conversation::Entity::find()
        .filter(conversation::Column::DeletedAt.is_null())
        .filter(conversation::Column::FolderId.eq(folder_id))
        .order_by_desc(conversation::Column::UpdatedAt)
        .all(conn)
        .await?;

    // command segment -> (category, occurrences, session ids)
    let mut agg: BTreeMap<String, (&'static str, usize, BTreeSet<i32>)> = BTreeMap::new();
    let mut scanned = 0usize;

    for convo in candidates {
        if scanned >= max_sessions {
            break;
        }
        let Some(external_id) = convo
            .external_id
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
        else {
            continue;
        };
        let Ok(agent_type) = serde_json::from_value::<AgentType>(serde_json::Value::String(
            convo.agent_type.clone(),
        )) else {
            continue;
        };
        // Scope the parser away from any await (dyn AgentParser is not Send).
        let parsed = {
            let parser = crate::parsers::build_agent_parser(agent_type);
            parser.get_conversation(external_id)
        };
        let Ok(detail) = parsed else {
            continue;
        };
        scanned += 1;

        for turn in &detail.turns {
            for block in &turn.blocks {
                let ContentBlock::ToolUse {
                    tool_name,
                    input_preview: Some(preview),
                    ..
                } = block
                else {
                    continue;
                };
                if !is_shell_tool(tool_name) {
                    continue;
                }
                let Some(command) = extract_command(preview) else {
                    continue;
                };
                let Some((category, display)) = classify_command(&command) else {
                    continue;
                };
                let entry = agg
                    .entry(display)
                    .or_insert_with(|| (category, 0, BTreeSet::new()));
                entry.1 += 1;
                entry.2.insert(convo.id);
            }
        }
    }

    let mut commands: Vec<ProjectCommand> = agg
        .into_iter()
        .map(|(command, (category, occurrences, sessions))| ProjectCommand {
            command,
            category: category.to_string(),
            occurrences,
            sessions: sessions.len(),
        })
        .collect();
    // A command used across many sessions is project knowledge; one used 20×
    // inside a single debugging session is a war story. Sessions first.
    commands.sort_by(|a, b| {
        b.sessions
            .cmp(&a.sessions)
            .then(b.occurrences.cmp(&a.occurrences))
            .then(a.command.cmp(&b.command))
    });
    commands.truncate(MAX_COMMANDS);

    Ok(ProjectCommandsReport {
        folder_id,
        scanned_sessions: scanned,
        commands,
    })
}

/// Shell-y tool names across the supported agents: Claude's `Bash`, Codex's
/// `shell`/`exec`, opencode's `bash`, gemini's `run_shell_command`, …
fn is_shell_tool(tool_name: &str) -> bool {
    let n = tool_name.to_ascii_lowercase();
    ["bash", "shell", "terminal", "exec", "run_command", "runterminal"]
        .iter()
        .any(|key| n.contains(key))
}

/// The tool input is stored verbatim as JSON by the parsers; the command
/// field's name varies by agent (`command` / `cmd` / `script`).
fn extract_command(preview: &str) -> Option<String> {
    if let Ok(value) = serde_json::from_str::<serde_json::Value>(preview) {
        for key in ["command", "cmd", "script"] {
            if let Some(c) = value.get(key).and_then(|v| v.as_str()) {
                let c = c.trim();
                if !c.is_empty() {
                    return Some(c.to_string());
                }
            }
        }
        return None;
    }
    // Truncated JSON (some parsers cap very long inputs): regex the leading
    // string field and JSON-unescape the capture.
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| {
        // Trailing quote optional: a truncated input ends mid-string.
        Regex::new(r#""(?:command|cmd|script)"\s*:\s*"((?:[^"\\]|\\.)*)"?"#)
            .expect("command regex")
    });
    let captured = re.captures(preview)?.get(1)?.as_str();
    serde_json::from_str::<String>(&format!("\"{captured}\"")).ok()
}

/// Split a shell line into separately-classifiable segments (`&&`, `||`,
/// `;`, `|`) and return the FIRST segment that classifies.
fn classify_command(command: &str) -> Option<(&'static str, String)> {
    static SPLIT: OnceLock<Regex> = OnceLock::new();
    let split = SPLIT.get_or_init(|| {
        Regex::new(r"\s*(?:&&|\|\||;|\|)\s*").expect("segment split regex")
    });
    for segment in split.split(command) {
        let segment = strip_prefixes(segment);
        if segment.is_empty() {
            continue;
        }
        if let Some(category) = classify_segment(segment) {
            let display: String = segment.chars().take(COMMAND_DISPLAY_CAP).collect();
            return Some((category, display));
        }
    }
    None
}

/// Strip the noise that wraps the real command: `cd x && `, `KEY=value `,
/// `sudo`, `timeout 30`, `nohup`, `env`.
fn strip_prefixes(mut segment: &str) -> &str {
    loop {
        let trimmed = segment.trim();
        let lower = trimmed.to_ascii_lowercase();
        let mut next: Option<&str> = None;
        for prefix in ["sudo ", "nohup ", "env "] {
            if lower.starts_with(prefix) {
                next = Some(&trimmed[prefix.len()..]);
                break;
            }
        }
        if next.is_none() && lower.starts_with("timeout ") {
            // `timeout <duration> <command>`
            if let Some(rest) = trimmed.splitn(3, ' ').nth(2) {
                next = Some(rest);
            }
        }
        if next.is_none() {
            // env assignment: WORD=... — skip while the first token has `=`
            let mut words = trimmed.split_whitespace();
            if let Some(first) = words.next() {
                if first.contains('=') && !first.starts_with('-') {
                    next = Some(trimmed[first.len()..].trim_start());
                }
            }
        }
        if next.is_none() && lower.starts_with("cd ") {
            // `cd <dir> && <rest>` — only meaningful as a prefix of a segment
            if let Some(pos) = trimmed.find("&&") {
                let dir = trimmed[3..pos]
                    .trim()
                    .trim_matches(|c| c == '"' || c == '\'');
                if !dir.is_empty() {
                    next = Some(&trimmed[pos + 2..]);
                }
            }
        }
        match next {
            Some(rest) if rest.len() < segment.len() => segment = rest,
            _ => return segment.trim(),
        }
    }
}

/// Whitelist classifier: (category, recognized segment). `None` = not project
/// toolchain (one-off shell by the agent, e.g. `ls`, `curl`, `git status`).
fn classify_segment(segment: &str) -> Option<&'static str> {
    let words: Vec<String> = segment
        .split_whitespace()
        .map(|w| w.to_ascii_lowercase())
        .collect();
    let first = words.first()?.as_str();
    let second = words.get(1).map(String::as_str).unwrap_or("");
    let third = words.get(2).map(String::as_str).unwrap_or("");
    // `npm run build` — the real script is the third word.
    let script = if second == "run" && !third.is_empty() {
        third
    } else {
        second
    };

    match first {
        "pnpm" | "npm" | "yarn" | "bun" | "vp" => match script {
            "test" => Some("test"),
            "build" | "compile" | "dist" => Some("build"),
            "lint" => Some("lint"),
            "typecheck" | "type-check" | "tsc" => Some("typecheck"),
            "dev" | "start" | "serve" | "preview" => Some("dev"),
            "install" | "i" | "ci" | "add" => Some("install"),
            "" => None,
            _ => Some("other"),
        },
        "cargo" => match second {
            "test" | "nextest" => Some("test"),
            "build" | "check" | "make" => Some("build"),
            "clippy" | "fmt" => Some("lint"),
            "run" => Some("dev"),
            "install" => Some("install"),
            _ => None,
        },
        "go" => match second {
            "test" => Some("test"),
            "build" => Some("build"),
            "vet" => Some("lint"),
            "run" => Some("dev"),
            _ => None,
        },
        "pytest" | "vitest" | "jest" | "mocha" | "playwright" | "ctest" => Some("test"),
        "ruff" | "mypy" | "eslint" | "biome" | "flake8" | "golangci-lint" => Some("lint"),
        "tsc" => Some("typecheck"),
        "make" | "cmake" | "ninja" | "gradle" | "./gradlew" | "mvn" => Some("build"),
        "uv" => match third {
            "test" => Some("test"),
            "build" => Some("build"),
            _ => Some("other"),
        },
        "docker" => match second {
            "compose" | "build" | "run" => Some("dev"),
            _ => None,
        },
        _ => None,
    }
}

// ---------------------------------------------------------------------------
// Rules-file writer — the injection path
// ---------------------------------------------------------------------------
//
// The report above is only worth collecting if its consumers READ it with no
// plumbing. The project's rules file is that place: every supported agent
// loads AGENTS.md / CLAUDE.md at launch, so a managed section there injects
// the knowledge into every future session, on every agent, with no prompt
// code at all.
//
// User-edit guard: the start marker carries a hash of the section body as
// codeg last wrote it. An update only proceeds while the hash still matches —
// a hand-edited section is left alone rather than clobbered.

/// Rules files codeg writes into, in preference order: AGENTS.md is the
/// cross-agent convention; CLAUDE.md is the fallback for a project that
/// already uses it and has no AGENTS.md.
const RULES_FILE_CANDIDATES: [&str; 2] = ["AGENTS.md", "CLAUDE.md"];
const DEFAULT_RULES_FILE: &str = "AGENTS.md";
const SECTION_START: &str = "<!-- codeg:project-commands";
const SECTION_END: &str = "<!-- /codeg:project-commands -->";
const HASH_HEX_LEN: usize = 12;

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RulesWriteOutcome {
    /// No rules file existed; AGENTS.md was created with the section.
    Created,
    /// The section was appended to an existing file without a codeg section.
    Appended,
    /// The existing codeg section was replaced (hash still matched).
    Updated,
    /// The user edited the section since codeg last wrote it — left alone.
    SkippedUserEdited,
    /// The start marker has no end marker — refused rather than guessed at.
    SkippedDamagedSection,
    /// No commands found; nothing was written.
    NothingToWrite,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct RulesWriteReport {
    pub outcome: RulesWriteOutcome,
    /// The rules file name, relative to the project root (empty when nothing
    /// was written).
    pub file: String,
    pub commands_written: usize,
    pub scanned_sessions: usize,
}

/// Collect the folder's commands and write them into its rules file.
pub async fn write_project_commands(
    conn: &DatabaseConnection,
    folder_id: i32,
    max_sessions: usize,
) -> Result<RulesWriteReport, DbError> {
    let report = collect_project_commands(conn, folder_id, max_sessions).await?;
    if report.commands.is_empty() {
        return Ok(RulesWriteReport {
            outcome: RulesWriteOutcome::NothingToWrite,
            file: String::new(),
            commands_written: 0,
            scanned_sessions: report.scanned_sessions,
        });
    }

    // Defensive: commands exist, so the folder normally does too; a deleted
    // folder means there is nothing to write into.
    let Some(folder) = folder_service::get_folder_by_id(conn, folder_id).await? else {
        return Ok(RulesWriteReport {
            outcome: RulesWriteOutcome::NothingToWrite,
            file: String::new(),
            commands_written: 0,
            scanned_sessions: report.scanned_sessions,
        });
    };
    let root = PathBuf::from(&folder.path);
    let file_name = pick_rules_file(&root);
    let path = root.join(file_name);

    let existing = match std::fs::read_to_string(&path) {
        Ok(text) => text,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(e) => return Err(DbError::Io(e)),
    };

    let body = render_section_body(&report);
    let (outcome, next) = match merge_section(&existing, &body) {
        MergePlan::BlockedUserEdited => {
            return Ok(RulesWriteReport {
                outcome: RulesWriteOutcome::SkippedUserEdited,
                file: file_name.to_string(),
                commands_written: 0,
                scanned_sessions: report.scanned_sessions,
            });
        }
        MergePlan::BlockedDamaged => {
            return Ok(RulesWriteReport {
                outcome: RulesWriteOutcome::SkippedDamagedSection,
                file: file_name.to_string(),
                commands_written: 0,
                scanned_sessions: report.scanned_sessions,
            });
        }
        MergePlan::Append(next) => {
            let outcome = if existing.is_empty() {
                RulesWriteOutcome::Created
            } else {
                RulesWriteOutcome::Appended
            };
            (outcome, next)
        }
        MergePlan::Replace(next) => (RulesWriteOutcome::Updated, next),
    };

    std::fs::write(&path, next).map_err(DbError::Io)?;
    Ok(RulesWriteReport {
        outcome,
        file: file_name.to_string(),
        commands_written: report.commands.len(),
        scanned_sessions: report.scanned_sessions,
    })
}

/// First existing candidate wins; otherwise AGENTS.md is created.
fn pick_rules_file(root: &Path) -> &'static str {
    for name in RULES_FILE_CANDIDATES {
        if root.join(name).is_file() {
            return name;
        }
    }
    DEFAULT_RULES_FILE
}

enum MergePlan {
    Append(String),
    Replace(String),
    BlockedUserEdited,
    BlockedDamaged,
}

/// Merge the managed section into the file text. Pure — the whole guard
/// logic is testable without touching a filesystem.
fn merge_section(existing: &str, body: &str) -> MergePlan {
    let new_section = render_section(body);
    let Some(start) = existing.find(SECTION_START) else {
        let mut next = existing.to_string();
        if !next.is_empty() {
            if !next.ends_with('\n') {
                next.push('\n');
            }
            next.push('\n');
        }
        next.push_str(&new_section);
        return MergePlan::Append(next);
    };

    // A start marker with no end marker means the file is damaged; refusing
    // beats guessing where the section ends and truncating user content.
    let Some(rel_end) = existing[start..].find(SECTION_END) else {
        return MergePlan::BlockedDamaged;
    };
    let end = start + rel_end + SECTION_END.len();
    let marker_line_end = existing[start..]
        .find("-->")
        .map(|i| start + i + 3)
        .unwrap_or(start);
    let inner = &existing[marker_line_end..start + rel_end];
    let stored = parse_hash(&existing[start..marker_line_end]);
    if stored.as_deref() != Some(content_hash(inner).as_str()) {
        return MergePlan::BlockedUserEdited;
    }

    let mut next = String::with_capacity(existing.len() + new_section.len());
    next.push_str(&existing[..start]);
    next.push_str(&new_section);
    next.push_str(&existing[end..]);
    MergePlan::Replace(next)
}

fn render_section(body: &str) -> String {
    let inner = format!("\n{body}\n");
    format!(
        "{SECTION_START} hash:{} -->{inner}{SECTION_END}\n",
        content_hash(&inner)
    )
}

fn render_section_body(report: &ProjectCommandsReport) -> String {
    let mut out = String::from("## Project commands (collected by codeg)\n\n");
    out.push_str(&format!(
        "Collected from the last {} sessions. Edit or delete this section freely \u{2014} codeg\n\
         only rewrites it while the hash in the marker above still matches.\n\n",
        report.scanned_sessions
    ));
    for cmd in &report.commands {
        out.push_str(&format!(
            "- `{}` \u{2014} {} ({}x)\n",
            cmd.command, cmd.category, cmd.occurrences
        ));
    }
    out
}

/// The guard hash: covers the section BODY (between the markers), so user
/// edits to the body are detected, while a change to codeg's own marker line
/// cannot silently pass as "ours".
fn content_hash(inner: &str) -> String {
    let digest = Sha256::digest(inner.as_bytes());
    let hex = format!("{digest:x}");
    hex.chars().take(HASH_HEX_LEN).collect()
}

fn parse_hash(marker: &str) -> Option<String> {
    let start = marker.find("hash:")? + "hash:".len();
    let rest = &marker[start..];
    let end = rest.find(' ').unwrap_or(rest.len());
    Some(rest[..end].to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn classified(command: &str) -> Option<(&'static str, String)> {
        classify_command(command)
    }

    #[test]
    fn classifies_package_manager_scripts() {
        assert_eq!(
            classified("pnpm test"),
            Some(("test", "pnpm test".into()))
        );
        assert_eq!(
            classified("npm run build --production"),
            Some(("build", "npm run build --production".into()))
        );
        assert_eq!(classified("yarn lint"), Some(("lint", "yarn lint".into())));
        assert_eq!(classified("pnpm install --frozen"), Some(("install", "pnpm install --frozen".into())));
        assert_eq!(classified("pnpm dev"), Some(("dev", "pnpm dev".into())));
        // Unknown scripts still count — they are project tooling.
        assert_eq!(classified("pnpm codegen"), Some(("other", "pnpm codegen".into())));
    }

    #[test]
    fn classifies_build_systems() {
        assert_eq!(classified("cargo test --lib"), Some(("test", "cargo test --lib".into())));
        assert_eq!(classified("cargo clippy --all-targets"), Some(("lint", "cargo clippy --all-targets".into())));
        assert_eq!(classified("cargo build --release"), Some(("build", "cargo build --release".into())));
        assert_eq!(classified("go test ./..."), Some(("test", "go test ./...".into())));
        assert_eq!(classified("pytest -q"), Some(("test", "pytest -q".into())));
        assert_eq!(classified("make -j8"), Some(("build", "make -j8".into())));
    }

    #[test]
    fn strips_wrappers_and_chains() {
        assert_eq!(
            classified("cd /repo/app && pnpm build"),
            Some(("build", "pnpm build".into()))
        );
        assert_eq!(
            classified("timeout 60 cargo test"),
            Some(("test", "cargo test".into()))
        );
        assert_eq!(
            classified("sudo npm i -g pnpm"),
            Some(("install", "npm i -g pnpm".into()))
        );
        assert_eq!(
            classified("NODE_ENV=test pnpm test"),
            Some(("test", "pnpm test".into()))
        );
        // First segment is noise; the second classifies.
        assert_eq!(
            classified("rm -rf dist && pnpm build"),
            Some(("build", "pnpm build".into()))
        );
    }

    #[test]
    fn ignores_non_toolchain_commands() {
        assert_eq!(classified("ls -la"), None);
        assert_eq!(classified("git status"), None);
        assert_eq!(classified("curl https://example.com"), None);
        assert_eq!(classified("cd /tmp"), None);
    }

    #[test]
    fn extracts_command_from_full_json() {
        assert_eq!(
            extract_command(r#"{"command":"cargo test","timeout":120}"#),
            Some("cargo test".into())
        );
        assert_eq!(
            extract_command(r#"{"cmd":"pnpm build"}"#),
            Some("pnpm build".into())
        );
    }

    #[test]
    fn extracts_command_from_truncated_json() {
        assert_eq!(
            extract_command(r#"{"command":"cargo test --release"#),
            Some("cargo test --release".into())
        );
        // Escaped quotes inside the command survive the regex + unescape.
        assert_eq!(
            extract_command(r#"{"command":"echo \"hi\" && npm test"}"#),
            Some(r#"echo "hi" && npm test"#.into())
        );
    }

    #[test]
    fn matches_shell_tool_names_across_agents() {
        for name in ["Bash", "bash", "shell", "exec", "run_shell_command", "run_terminal_cmd"] {
            assert!(is_shell_tool(name), "{name} must be a shell tool");
        }
        for name in ["Read", "Edit", "Grep", "apply_patch"] {
            assert!(!is_shell_tool(name), "{name} must not be a shell tool");
        }
    }

    #[tokio::test]
    async fn skips_conversations_without_external_id() {
        let db = crate::db::test_helpers::fresh_in_memory_db().await;
        let fid = crate::db::test_helpers::seed_folder(&db, "/tmp/knowledge-test").await;
        crate::db::test_helpers::seed_conversation(&db, fid, AgentType::ClaudeCode).await;

        let report = collect_project_commands(&db.conn, fid, 10).await.unwrap();
        assert_eq!(report.folder_id, fid);
        assert_eq!(report.scanned_sessions, 0);
        assert!(report.commands.is_empty());
    }

    #[test]
    fn section_roundtrips_and_updates_in_place() {
        let first = match merge_section("", "body one") {
            MergePlan::Append(text) => text,
            _ => panic!("an empty file must append"),
        };
        assert!(first.contains(SECTION_START) && first.contains("body one"));
        let second = match merge_section(&first, "body two") {
            MergePlan::Replace(text) => text,
            _ => panic!("our own section must be replaceable"),
        };
        assert!(second.contains("body two"));
        assert!(!second.contains("body one"), "the old body must be gone");
    }

    #[test]
    fn user_edit_blocks_update() {
        let edited = render_section("body one").replace("body one", "my own words");
        assert!(matches!(
            merge_section(&edited, "body two"),
            MergePlan::BlockedUserEdited
        ));
    }

    #[test]
    fn damaged_section_is_refused() {
        let damaged = format!("{SECTION_START} hash:deadbeef -->\nno end marker\n");
        assert!(matches!(
            merge_section(&damaged, "body"),
            MergePlan::BlockedDamaged
        ));
    }

    #[test]
    fn merge_preserves_surrounding_content() {
        let text = format!(
            "# Title\n\n{}\ntrailing user notes\n",
            render_section("first")
        );
        let next = match merge_section(&text, "second") {
            MergePlan::Replace(t) => t,
            _ => panic!("expected replace"),
        };
        assert!(next.starts_with("# Title\n\n"), "head preserved");
        assert!(next.contains("second"));
        assert!(
            next.ends_with("trailing user notes\n"),
            "tail content preserved"
        );
    }

    #[test]
    fn pick_rules_file_prefers_existing() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        // Neither exists → AGENTS.md is created.
        assert_eq!(pick_rules_file(root), "AGENTS.md");
        // Only CLAUDE.md exists → it wins over nothing.
        std::fs::write(root.join("CLAUDE.md"), "x").unwrap();
        assert_eq!(pick_rules_file(root), "CLAUDE.md");
        // AGENTS.md exists → it wins over CLAUDE.md.
        std::fs::write(root.join("AGENTS.md"), "x").unwrap();
        assert_eq!(pick_rules_file(root), "AGENTS.md");
    }
}
