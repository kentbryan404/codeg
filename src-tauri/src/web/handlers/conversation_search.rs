//! Cross-conversation full-text search — web handler surface.
//!
//! Same service as the desktop commands (`commands::conversation_search`), so
//! both runtimes answer identically.

use std::sync::Arc;

use axum::{extract::Extension, Json};
use serde::Deserialize;

use crate::app_error::AppCommandError;
use crate::app_state::AppState;
use crate::db::service::conversation_search_service::{self, IndexReport, SearchHit};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchQueryParams {
    pub query: String,
    #[serde(default)]
    pub folder_id: Option<i32>,
    #[serde(default)]
    pub limit: Option<u32>,
}

pub async fn conversation_search_query(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<SearchQueryParams>,
) -> Result<Json<Vec<SearchHit>>, AppCommandError> {
    let result = conversation_search_service::search(
        &state.db.conn,
        &params.query,
        params.folder_id,
        params.limit.unwrap_or(50),
    )
    .await
    .map_err(AppCommandError::from)?;
    Ok(Json(result))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchIndexParams {
    #[serde(default)]
    pub folder_id: Option<i32>,
}

pub async fn conversation_search_index(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<SearchIndexParams>,
) -> Result<Json<IndexReport>, AppCommandError> {
    let result = conversation_search_service::index_conversations(&state.db.conn, params.folder_id)
        .await
        .map_err(AppCommandError::from)?;
    Ok(Json(result))
}
