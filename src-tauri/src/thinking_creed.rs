//! 思考信条（Thinking Creed）：用户写的一段文本，每一轮发给 agent 的 prompt
//! 都会在最前面带上它，让模型"每次思考前都读到"。
//!
//! 存在 `app_metadata` 里，进程内缓存一份 —— 出站咽喉
//! ([`crate::acp::connection::prepare_agent_bound_prompt`]) 是同步函数，不能每轮
//! 去读库。启动时 [`load_saved`] 水合一次，写入时 [`save`] 同步刷新。
//!
//! 注入发生在**最终 agent 边界**，与 delegation 路由块同一个位置：只改发出去的
//! wire blocks，不进入用户消息、预览、账本与跨端广播，所以转录里看不到它。

use sea_orm::DatabaseConnection;
use std::sync::{OnceLock, RwLock};

use crate::db::error::DbError;
use crate::db::service::app_metadata_service;

/// `app_metadata` 里的键名。
pub const THINKING_CREED_KEY: &str = "thinking_creed";

static CREED: OnceLock<RwLock<String>> = OnceLock::new();

fn cell() -> &'static RwLock<String> {
    CREED.get_or_init(|| RwLock::new(String::new()))
}

/// 当前信条（进程内缓存）。任何线程可读；读取失败退化为空串。
pub fn get() -> String {
    cell()
        .read()
        .map(|guard| guard.clone())
        .unwrap_or_default()
}

fn store(value: String) {
    if let Ok(mut guard) = cell().write() {
        *guard = value;
    }
}

/// 把信条包成一段对模型可见的前缀文本；空白信条返回 `None`（不注入）。
///
/// 纯函数，便于单测。标记语言刻意保持极简：每轮都要花 token，包装只负责让
/// 模型知道"这段是必须遵守的长期约束"，不替用户写内容。
pub fn creed_prefix(creed: &str) -> Option<String> {
    let trimmed = creed.trim();
    if trimmed.is_empty() {
        return None;
    }
    Some(format!("【思考信条 · 每轮思考前必须遵守】\n{trimmed}"))
}

/// 出站注入用的文本块：空信条返回 `None`。
pub fn creed_block() -> Option<String> {
    creed_prefix(&get())
}

/// 从库里读回信条并水合缓存；返回读到的值（缺省空串）。
pub async fn load_saved(conn: &DatabaseConnection) -> Result<String, DbError> {
    let value = app_metadata_service::get_value(conn, THINKING_CREED_KEY)
        .await?
        .unwrap_or_default();
    store(value.clone());
    Ok(value)
}

/// 写入库 + 立即刷新缓存（后续每轮出站注入即时生效）。
pub async fn save(conn: &DatabaseConnection, creed: &str) -> Result<(), DbError> {
    app_metadata_service::upsert_value(conn, THINKING_CREED_KEY, creed).await?;
    store(creed.to_string());
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blank_creeds_are_not_injected() {
        assert!(creed_prefix("").is_none());
        assert!(creed_prefix("   \n\t ").is_none());
    }

    #[test]
    fn the_creed_is_wrapped_with_the_mandatory_marker() {
        let wrapped = creed_prefix("先给结论，再给依据").expect("non-blank");
        assert!(wrapped.starts_with("【思考信条"));
        assert!(wrapped.ends_with("先给结论，再给依据"));
    }

    #[test]
    fn surrounding_whitespace_is_trimmed() {
        let wrapped = creed_prefix("  用中文思考  ").expect("non-blank");
        assert!(wrapped.ends_with("用中文思考"));
        assert!(!wrapped.ends_with(' '));
    }
}
