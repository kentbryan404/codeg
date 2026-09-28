use crate::db::error::DbError;
#[cfg(feature = "tauri-runtime")]
use crate::db::AppDatabase;

/// 读回思考信条并水合进程内缓存。UI 在思考面板挂载时调用一次。
#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn get_thinking_creed(
    db: tauri::State<'_, AppDatabase>,
) -> Result<String, DbError> {
    crate::thinking_creed::load_saved(&db.conn).await
}

/// 写入思考信条；立即刷新缓存，下一轮 prompt 就开始携带。
#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn set_thinking_creed(
    db: tauri::State<'_, AppDatabase>,
    creed: String,
) -> Result<(), DbError> {
    crate::thinking_creed::save(&db.conn, &creed).await
}
