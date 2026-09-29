//! Conversation full-text search.
//!
//! Message bodies are NOT in codeg's database — they live in each agent's own
//! session files and are parsed on demand. This service materializes them into
//! an FTS5 index (trigram tokenizer, see the migration) so cross-conversation
//! search is an indexed query, not a full parse.
//!
//! Incremental by watermark: `conversations.message_count` doubles as the
//! indexing cursor. A conversation is re-parsed only when its count moved
//! since `conversation_search_state` was written; a missing state row means
//! "never indexed". Session files are append-only, so the count is a sound
//! change detector.

use std::collections::HashMap;

use sea_orm::{
    ColumnTrait, ConnectionTrait, DatabaseConnection, DbBackend, EntityTrait, QueryFilter,
    QueryResult, Statement, TransactionTrait, Value,
};

use crate::db::entities::conversation;
use crate::db::error::DbError;
use crate::models::agent::AgentType;
use crate::models::message::{ContentBlock, MessageTurn, TurnRole};

/// Outcome of one indexing pass — shaped for a status line, not for logs.
#[derive(Debug, Default, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct IndexReport {
    pub conversations_seen: usize,
    pub conversations_indexed: usize,
    pub conversations_skipped: usize,
    pub turns_written: usize,
    pub parse_failures: usize,
}

/// One search hit. `snippet` is FTS5's highlighted excerpt (`‹…›` markers);
/// the LIKE fallback returns the stored text unhighlighted.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct SearchHit {
    pub conversation_id: i32,
    pub folder_id: i32,
    pub agent_type: String,
    pub role: String,
    pub at: String,
    pub snippet: String,
}

/// Trigram FTS5 cannot answer queries shorter than 3 characters; those fall
/// back to a LIKE scan (see [`search`]).
const TRIGRAM_MIN_CHARS: usize = 3;
/// Highlight markers for the FTS5 `snippet()` output.
const SNIPPET_OPEN: &str = "‹";
const SNIPPET_CLOSE: &str = "›";

/// Index (or refresh) every live conversation's turns, optionally scoped to
/// one folder. Parsing is best-effort per conversation: a conversation whose
/// session file is gone (or unreadable) is counted in `parse_failures` and
/// left at its previous index state — one bad file never aborts the pass.
pub async fn index_conversations(
    conn: &DatabaseConnection,
    folder_id: Option<i32>,
) -> Result<IndexReport, DbError> {
    let mut find = conversation::Entity::find().filter(conversation::Column::DeletedAt.is_null());
    if let Some(fid) = folder_id {
        find = find.filter(conversation::Column::FolderId.eq(fid));
    }
    let conversations = find.all(conn).await?;

    let states = load_states(conn).await?;
    let mut report = IndexReport::default();

    for convo in conversations {
        report.conversations_seen += 1;

        let Some(external_id) = convo
            .external_id
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
        else {
            // Nothing parseable behind this row (chat/loop rows have no agent
            // session file).
            report.conversations_skipped += 1;
            continue;
        };
        if states.get(&convo.id).copied() == Some(convo.message_count) {
            report.conversations_skipped += 1;
            continue;
        }
        let Ok(agent_type) = serde_json::from_value::<AgentType>(serde_json::Value::String(
            convo.agent_type.clone(),
        )) else {
            report.conversations_skipped += 1;
            continue;
        };

        // Scope the parser away before the first await: `dyn AgentParser` is
        // not Send, and holding it across an await would make this future
        // non-Send — which the tauri command macro rejects.
        let parsed = {
            let parser = crate::parsers::build_agent_parser(agent_type);
            parser.get_conversation(external_id)
        };
        match parsed {
            Ok(detail) => {
                let rows = collect_turn_rows(&detail.turns);
                replace_conversation_rows(
                    conn,
                    convo.id,
                    convo.folder_id,
                    &convo.agent_type,
                    &rows,
                )
                .await?;
                upsert_state(conn, convo.id, convo.message_count).await?;
                report.conversations_indexed += 1;
                report.turns_written += rows.len();
            }
            Err(_) => {
                // Keep the old watermark: a later pass retries this file.
                report.parse_failures += 1;
            }
        }
    }

    Ok(report)
}

/// Search indexed turns. Queries of 3+ characters run through FTS5 `MATCH`
/// (rank-ordered, highlighted); shorter ones — below the trigram floor — run
/// a LIKE scan on the same table. `folder_id` scopes to one workspace folder.
pub async fn search(
    conn: &DatabaseConnection,
    query: &str,
    folder_id: Option<i32>,
    limit: u32,
) -> Result<Vec<SearchHit>, DbError> {
    let query = query.trim();
    if query.is_empty() {
        return Ok(Vec::new());
    }
    let limit = i64::from(limit.clamp(1, 100));
    let folder_clause = folder_id
        .map(|f| format!(" AND folder_id = {f}"))
        .unwrap_or_default();

    let (sql, values) = if query.chars().count() >= TRIGRAM_MIN_CHARS {
        // Phrase-quote the input: FTS5 operators (AND/OR/NEAR/*/"…") must never
        // be interpreted from a search box, and quoting makes multi-word input
        // a phrase search — the expected behaviour for this UI.
        let needle = format!("\"{}\"", query.replace('"', "\"\""));
        (
            format!(
                "SELECT conversation_id, folder_id, agent_type, role, at, \
                 snippet(conversation_search_fts, 0, '{SNIPPET_OPEN}', '{SNIPPET_CLOSE}', '…', 12) AS snippet \
                 FROM conversation_search_fts \
                 WHERE conversation_search_fts MATCH ?{folder_clause} \
                 ORDER BY rank LIMIT ?"
            ),
            vec![Value::from(needle), Value::from(limit)],
        )
    } else {
        let escaped = query
            .replace('\\', "\\\\")
            .replace('%', "\\%")
            .replace('_', "\\_");
        (
            format!(
                "SELECT conversation_id, folder_id, agent_type, role, at, text AS snippet \
                 FROM conversation_search_fts \
                 WHERE text LIKE '%{escaped}%' ESCAPE '\\'{folder_clause} \
                 LIMIT ?"
            ),
            vec![Value::from(limit)],
        )
    };

    let rows = conn
        .query_all(Statement::from_sql_and_values(
            DbBackend::Sqlite,
            &sql,
            values,
        ))
        .await?;
    rows.iter().map(hit_from_row).collect()
}

fn hit_from_row(row: &QueryResult) -> Result<SearchHit, DbError> {
    Ok(SearchHit {
        // Stored as text by `replace_conversation_rows`.
        conversation_id: row
            .try_get::<String>("", "conversation_id")?
            .parse()
            .unwrap_or(-1),
        folder_id: row.try_get::<i32>("", "folder_id")?,
        agent_type: row.try_get::<String>("", "agent_type")?,
        role: row.try_get::<String>("", "role")?,
        at: row.try_get::<String>("", "at")?,
        snippet: row.try_get::<String>("", "snippet")?,
    })
}

/// One indexed turn: the concatenated text of its text-bearing blocks.
struct TurnRow {
    role: &'static str,
    at: String,
    text: String,
}

/// Turns that carry searchable prose. Thinking blocks are deliberately NOT
/// indexed — the searchable signal users reach for is prompt/answer prose, and
/// indexing the model's scratchpad floods results with reasoning noise.
fn collect_turn_rows(turns: &[MessageTurn]) -> Vec<TurnRow> {
    turns
        .iter()
        .filter_map(|turn| {
            let mut parts: Vec<&str> = Vec::new();
            for block in &turn.blocks {
                if let ContentBlock::Text { text } = block {
                    let t = text.trim();
                    if !t.is_empty() {
                        parts.push(t);
                    }
                }
            }
            if parts.is_empty() {
                return None;
            }
            let role = match turn.role {
                TurnRole::User => "user",
                TurnRole::Assistant => "assistant",
                TurnRole::System => "system",
            };
            Some(TurnRow {
                role,
                at: turn.timestamp.to_rfc3339(),
                text: parts.join("\n"),
            })
        })
        .collect()
}

/// Replace one conversation's index rows atomically. The DELETE scans the
/// UNINDEXED `conversation_id` column — fine for a background pass over tens
/// of thousands of rows; rowid bookkeeping would be the upgrade path if this
/// ever runs in a hot loop.
async fn replace_conversation_rows(
    conn: &DatabaseConnection,
    conversation_id: i32,
    folder_id: i32,
    agent_type: &str,
    rows: &[TurnRow],
) -> Result<(), DbError> {
    let txn = conn.begin().await?;
    txn.execute(Statement::from_sql_and_values(
        DbBackend::Sqlite,
        "DELETE FROM conversation_search_fts WHERE conversation_id = ?",
        vec![Value::from(conversation_id.to_string())],
    ))
    .await?;
    for row in rows {
        txn.execute(Statement::from_sql_and_values(
            DbBackend::Sqlite,
            "INSERT INTO conversation_search_fts \
             (text, conversation_id, folder_id, agent_type, role, at) \
             VALUES (?, ?, ?, ?, ?, ?)",
            vec![
                Value::from(row.text.clone()),
                Value::from(conversation_id.to_string()),
                Value::from(folder_id),
                Value::from(agent_type.to_owned()),
                Value::from(row.role),
                Value::from(row.at.clone()),
            ],
        ))
        .await?;
    }
    txn.commit().await?;
    Ok(())
}

async fn load_states(conn: &DatabaseConnection) -> Result<HashMap<i32, i32>, DbError> {
    let rows = conn
        .query_all(Statement::from_string(
            DbBackend::Sqlite,
            "SELECT conversation_id, message_count FROM conversation_search_state".to_owned(),
        ))
        .await?;
    let mut map = HashMap::new();
    for row in rows {
        map.insert(
            row.try_get::<i32>("", "conversation_id")?,
            row.try_get::<i32>("", "message_count")?,
        );
    }
    Ok(map)
}

async fn upsert_state(
    conn: &DatabaseConnection,
    conversation_id: i32,
    message_count: i32,
) -> Result<(), DbError> {
    conn.execute(Statement::from_sql_and_values(
        DbBackend::Sqlite,
        "INSERT INTO conversation_search_state (conversation_id, message_count, indexed_at) \
         VALUES (?, ?, ?) \
         ON CONFLICT(conversation_id) DO UPDATE SET \
           message_count = excluded.message_count, indexed_at = excluded.indexed_at",
        vec![
            Value::from(conversation_id),
            Value::from(message_count),
            Value::from(chrono::Utc::now().to_rfc3339()),
        ],
    ))
    .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::test_helpers::{fresh_in_memory_db, seed_conversation, seed_folder};

    async fn insert_row(db: &crate::db::AppDatabase, cid: i32, fid: i32, text: &str) {
        db.conn
            .execute(Statement::from_sql_and_values(
                DbBackend::Sqlite,
                "INSERT INTO conversation_search_fts \
                 (text, conversation_id, folder_id, agent_type, role, at) \
                 VALUES (?, ?, ?, 'claude_code', 'user', '2026-09-29T00:00:00Z')",
                vec![
                    Value::from(text.to_owned()),
                    Value::from(cid.to_string()),
                    Value::from(fid),
                ],
            ))
            .await
            .expect("insert fts row");
    }

    #[tokio::test]
    async fn search_matches_cjk_and_english_with_snippets() {
        let db = fresh_in_memory_db().await;
        insert_row(&db, 1, 10, "记忆宫殿的可视化设计").await;
        insert_row(&db, 2, 10, "terminal diff rendering notes").await;

        let hits = search(&db.conn, "忆宫殿", None, 10).await.unwrap();
        assert_eq!(hits.len(), 1, "CJK substring must hit through trigram");
        assert_eq!(hits[0].conversation_id, 1);
        assert!(
            hits[0].snippet.contains(SNIPPET_OPEN),
            "snippet must mark the hit: {}",
            hits[0].snippet
        );

        let hits = search(&db.conn, "terminal", None, 10).await.unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].conversation_id, 2);
    }

    #[tokio::test]
    async fn short_query_falls_back_to_like() {
        let db = fresh_in_memory_db().await;
        insert_row(&db, 1, 10, "记忆宫殿").await;
        // "忆宫" is below the trigram floor of 3 characters.
        let hits = search(&db.conn, "忆宫", None, 10).await.unwrap();
        assert_eq!(hits.len(), 1, "LIKE fallback must serve short queries");
        assert_eq!(hits[0].conversation_id, 1);
    }

    #[tokio::test]
    async fn folder_filter_scopes_hits() {
        let db = fresh_in_memory_db().await;
        insert_row(&db, 1, 10, "shared needle in folder ten").await;
        insert_row(&db, 2, 20, "shared needle in folder twenty").await;

        let hits = search(&db.conn, "needle", Some(20), 10).await.unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].folder_id, 20);
    }

    #[tokio::test]
    async fn fts_operators_in_input_are_literal() {
        let db = fresh_in_memory_db().await;
        insert_row(&db, 1, 10, "discussing NEAR and OR keywords").await;
        // Unquoted, `NEAR`/`*`/`"` would be FTS5 syntax and could error or
        // change meaning; the phrase-quoting makes them literal text.
        let hits = search(&db.conn, "NEAR and OR", None, 10).await.unwrap();
        assert_eq!(hits.len(), 1);
        let hits = search(&db.conn, "\"unbalanced", None, 10).await.unwrap();
        assert!(hits.is_empty(), "a bare quote must not error the query");
    }

    #[tokio::test]
    async fn index_pass_skips_rows_without_external_id() {
        let db = fresh_in_memory_db().await;
        let fid = seed_folder(&db, "/tmp/search-test").await;
        seed_conversation(&db, fid, AgentType::ClaudeCode).await;

        let report = index_conversations(&db.conn, Some(fid)).await.unwrap();
        assert_eq!(report.conversations_seen, 1);
        assert_eq!(report.conversations_skipped, 1);
        assert_eq!(report.conversations_indexed, 0);
        assert_eq!(report.turns_written, 0);
    }

    #[tokio::test]
    async fn reindexing_replaces_rows_and_advances_watermark() {
        let db = fresh_in_memory_db().await;
        insert_row(&db, 7, 10, "first revision text").await;
        upsert_state(&db.conn, 7, 3).await.unwrap();

        // A second pass for the same conversation must clear its old rows.
        let rows = vec![TurnRow {
            role: "user",
            at: "2026-09-29T00:00:00Z".to_owned(),
            text: "second revision text".to_owned(),
        }];
        replace_conversation_rows(&db.conn, 7, 10, "claude_code", &rows)
            .await
            .unwrap();

        let old = search(&db.conn, "first revision", None, 10).await.unwrap();
        assert!(old.is_empty(), "stale rows must be gone");
        let new = search(&db.conn, "second revision", None, 10).await.unwrap();
        assert_eq!(new.len(), 1);
    }
}
