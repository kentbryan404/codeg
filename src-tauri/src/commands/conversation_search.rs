//! Cross-conversation full-text search — desktop command surface.
//!
//! Thin wrappers over `db::service::conversation_search_service`; the same
//! service backs the web handlers, so both runtimes share one implementation.

#[cfg(feature = "tauri-runtime")]
use crate::db::error::DbError;
#[cfg(feature = "tauri-runtime")]
use crate::db::service::conversation_search_service::{self, IndexReport, SearchHit};
#[cfg(feature = "tauri-runtime")]
use crate::db::AppDatabase;

/// Run one search. `query` is user input — the service phrase-quotes it for
/// FTS5 and falls back to LIKE under the trigram floor; see its docs.
#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn conversation_search_query(
    db: tauri::State<'_, AppDatabase>,
    query: String,
    folder_id: Option<i32>,
    limit: Option<u32>,
) -> Result<Vec<SearchHit>, DbError> {
    conversation_search_service::search(&db.conn, &query, folder_id, limit.unwrap_or(50)).await
}

/// Index (or refresh) conversations into the search index. Incremental by the
/// `message_count` watermark; safe to call repeatedly.
#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn conversation_search_index(
    db: tauri::State<'_, AppDatabase>,
    folder_id: Option<i32>,
) -> Result<IndexReport, DbError> {
    conversation_search_service::index_conversations(&db.conn, folder_id).await
}
