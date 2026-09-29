use sea_orm::{DbBackend, Statement};
use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();

        // FTS5 virtual table — SeaORM's table builder has no virtual-table
        // support, so this is raw SQL. `trigram` is the tokenizer that makes
        // CJK substrings searchable without a custom C tokenizer; its
        // 3-character query floor is handled by the query layer's LIKE
        // fallback (see `conversation_search_service`).
        //
        // Metadata columns are UNINDEXED: stored with each row (for filtering
        // and result rendering) but not tokenized. Row identity is the FTS5
        // rowid; `conversation_id` is codeg's internal conversation id as a
        // string.
        db.execute(Statement::from_string(
            DbBackend::Sqlite,
            "CREATE VIRTUAL TABLE conversation_search_fts USING fts5(\n\
                 text,\n\
                 conversation_id UNINDEXED,\n\
                 folder_id UNINDEXED,\n\
                 agent_type UNINDEXED,\n\
                 role UNINDEXED,\n\
                 at UNINDEXED,\n\
                 tokenize='trigram'\n\
             )"
            .to_owned(),
        ))
        .await?;

        // Incremental-indexing watermark: `message_count` at the time the
        // conversation was last indexed. A missing row means "never indexed";
        // a row whose count is behind the conversation's current
        // `message_count` means the conversation needs another pass.
        db.execute(Statement::from_string(
            DbBackend::Sqlite,
            "CREATE TABLE conversation_search_state (\n\
                 conversation_id INTEGER NOT NULL PRIMARY KEY,\n\
                 message_count INTEGER NOT NULL,\n\
                 indexed_at TEXT NOT NULL\n\
             )"
            .to_owned(),
        ))
        .await?;

        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute(Statement::from_string(
            DbBackend::Sqlite,
            "DROP TABLE conversation_search_fts".to_owned(),
        ))
        .await?;
        db.execute(Statement::from_string(
            DbBackend::Sqlite,
            "DROP TABLE conversation_search_state".to_owned(),
        ))
        .await?;
        Ok(())
    }
}
