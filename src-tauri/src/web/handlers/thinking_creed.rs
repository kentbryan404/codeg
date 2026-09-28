use std::sync::Arc;

use axum::{extract::Extension, Json};
use serde::Deserialize;

use crate::app_error::AppCommandError;
use crate::app_state::AppState;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetThinkingCreedParams {
    pub creed: String,
}

pub async fn thinking_creed_get(
    Extension(state): Extension<Arc<AppState>>,
) -> Result<Json<String>, AppCommandError> {
    let value = crate::thinking_creed::load_saved(&state.db.conn)
        .await
        .map_err(AppCommandError::from)?;
    Ok(Json(value))
}

pub async fn thinking_creed_set(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<SetThinkingCreedParams>,
) -> Result<Json<()>, AppCommandError> {
    crate::thinking_creed::save(&state.db.conn, &params.creed)
        .await
        .map_err(AppCommandError::from)?;
    Ok(Json(()))
}
