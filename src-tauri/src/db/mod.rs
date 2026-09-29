pub mod entities;
pub mod error;
pub mod migration;
pub mod service;

#[cfg(any(test, feature = "test-utils"))]
pub mod test_helpers;

use std::path::Path;
use std::time::Duration;

use sea_orm::{
    ConnectOptions, ConnectionTrait, Database, DatabaseConnection, DbBackend, Statement,
};
use sea_orm_migration::MigratorTrait;

use error::DbError;
use migration::Migrator;

pub struct AppDatabase {
    pub conn: DatabaseConnection,
}

pub(crate) fn database_file_name() -> &'static str {
    if cfg!(all(debug_assertions, feature = "tauri-runtime")) {
        "codeg-dev.db"
    } else {
        "codeg.db"
    }
}

pub async fn init_database(
    app_data_dir: impl AsRef<Path>,
    app_version: &str,
) -> Result<AppDatabase, DbError> {
    let app_data_dir = app_data_dir.as_ref();
    std::fs::create_dir_all(app_data_dir)?;

    // Apply any pending restore BEFORE opening a connection — swapping
    // `codeg.db` under a live SQLite handle would corrupt it. A failure here
    // aborts startup loudly (leaving the safety snapshot intact) rather than
    // booting a half-restored data dir.
    match crate::commands::backup::restore::apply_pending_restore_on_startup(app_data_dir) {
        Ok(crate::commands::backup::restore::RestoreApplied::Applied { .. }) => {}
        Ok(crate::commands::backup::restore::RestoreApplied::None) => {}
        Err(e) => return Err(DbError::Io(e)),
    }
    crate::commands::backup::restore::cleanup_transient_dirs(app_data_dir);

    let db_path = app_data_dir.join(database_file_name());
    let db_url = format!(
        "sqlite:{}?mode=rwc",
        urlencoding::encode(&db_path.to_string_lossy())
    );

    // Apply migrations on a dedicated single connection. The runtime pool below
    // keeps several connections open for read concurrency, but sea-orm spreads a
    // migration's statements across whichever pooled connections are free. A
    // statement that references a column an earlier migration just added (e.g.
    // the `is_chat` → `kind` backfill) can then land on a connection whose
    // cached SQLite schema predates the `ALTER TABLE`, producing a flaky
    // `no such column: "is_chat"` under load. One connection observes every DDL
    // change in order, so the schema it compiles against is always current.
    let mut migrate_opts = ConnectOptions::new(db_url.clone());
    migrate_opts
        .max_connections(1)
        .min_connections(1)
        .connect_timeout(Duration::from_secs(10))
        .sqlx_logging(false);
    let migrate_conn = Database::connect(migrate_opts).await?;
    apply_sqlite_pragmas(&migrate_conn).await?;
    Migrator::up(&migrate_conn, None)
        .await
        .map_err(|e| DbError::Migration(e.to_string()))?;
    migrate_conn.close().await?;

    // Runtime connection pool. Migrations are already applied above, so the
    // schema is stable and spreading queries across pooled connections is safe.
    let mut opts = ConnectOptions::new(db_url);
    opts.max_connections(5)
        .min_connections(1)
        .connect_timeout(Duration::from_secs(10))
        .idle_timeout(Duration::from_secs(300))
        .sqlx_logging(false);
    let conn = Database::connect(opts).await?;
    apply_sqlite_pragmas(&conn).await?;

    service::app_metadata_service::update_app_version(&conn, app_version).await?;

    // Publish user-registered ACP agents into the process-global launch
    // registry before anything can ask for agent metadata. This is the single
    // chokepoint every runtime (desktop, server) goes through, so custom agents
    // are live from the first `all_acp_agents()` / `get_agent_meta()` call.
    // A failure here must not block startup — the built-in agents still work.
    if let Err(e) = service::custom_agent_service::hydrate_registry(&conn).await {
        tracing::warn!("[custom-agent] failed to hydrate custom agent registry: {e}");
    }

    // Load user-authorized workspace links before any file command can run, so
    // the workspace path guard follows exactly the symlinks the user created
    // and nothing else. A failure here fails *closed* (registry stays empty:
    // linked subtrees look unreadable) rather than blocking startup.
    match crate::folder_links::hydrate(&conn).await {
        Ok(count) if count > 0 => {
            tracing::info!("[folder-link] hydrated {count} workspace link(s)");
        }
        Ok(_) => {}
        Err(e) => tracing::warn!("[folder-link] failed to hydrate workspace links: {e}"),
    }

    Ok(AppDatabase { conn })
}

/// Apply SQLite performance and reliability pragmas to a freshly opened
/// connection. `journal_mode=WAL` persists in the database header; the rest are
/// per-connection settings that must be re-applied every time a connection opens.
async fn apply_sqlite_pragmas(conn: &DatabaseConnection) -> Result<(), DbError> {
    for pragma in [
        "PRAGMA journal_mode=WAL;",
        "PRAGMA busy_timeout=5000;",
        "PRAGMA synchronous=NORMAL;",
        "PRAGMA foreign_keys=ON;",
        "PRAGMA cache_size=-8000;",
    ] {
        conn.execute(Statement::from_string(DbBackend::Sqlite, pragma.to_owned()))
            .await?;
    }
    Ok(())
}

#[cfg(test)]
mod fts_probe {
    //! Probe the bundled SQLite for the conversation-search prerequisites:
    //! FTS5 itself and the `trigram` tokenizer (the only index-side tokenizer
    //! that makes CJK substrings searchable without a custom C tokenizer).
    //! Also pins trigram's known floor — queries shorter than 3 characters
    //! return nothing — which the query layer must handle with a LIKE
    //! fallback.
    use sea_orm::{ConnectionTrait, DbBackend, Statement};

    async fn exec(db: &crate::db::AppDatabase, sql: &str) {
        db.conn
            .execute(Statement::from_string(DbBackend::Sqlite, sql.to_owned()))
            .await
            .unwrap_or_else(|e| panic!("sql failed: {sql}\n{e}"));
    }

    #[tokio::test]
    async fn fts5_with_trigram_is_available() {
        let db = crate::db::test_helpers::fresh_in_memory_db().await;
        exec(
            &db,
            "CREATE VIRTUAL TABLE probe USING fts5(body, tokenize='trigram');",
        )
        .await;
        exec(
            &db,
            "INSERT INTO probe(body) VALUES ('记忆宫殿的可视化设计'), ('user asked about terminal diff rendering');",
        )
        .await;

        // CJK substring >= 3 chars: trigram must hit.
        let cjk = db
            .conn
            .query_all(Statement::from_string(
                DbBackend::Sqlite,
                "SELECT snippet(probe, 0, '[', ']', '…', 8) FROM probe WHERE probe MATCH '忆宫殿';"
                    .to_owned(),
            ))
            .await
            .expect("cjk match");
        assert_eq!(cjk.len(), 1, "trigram must match a 3-char CJK substring");

        // English word: must hit.
        let en = db
            .conn
            .query_all(Statement::from_string(
                DbBackend::Sqlite,
                "SELECT body FROM probe WHERE probe MATCH 'terminal';".to_owned(),
            ))
            .await
            .expect("en match");
        assert_eq!(en.len(), 1, "trigram must match an English word");

        // The 2-char floor: documented behaviour, not a bug — the query layer
        // falls back to LIKE for short queries.
        let short = db
            .conn
            .query_all(Statement::from_string(
                DbBackend::Sqlite,
                "SELECT body FROM probe WHERE probe MATCH '忆宫';".to_owned(),
            ))
            .await
            .expect("short match runs");
        assert_eq!(
            short.len(),
            0,
            "trigram floor: queries under 3 chars return nothing (LIKE fallback needed)"
        );

        // LIKE fallback works on the same table for the short query.
        let like = db
            .conn
            .query_all(Statement::from_string(
                DbBackend::Sqlite,
                "SELECT body FROM probe WHERE body LIKE '%忆宫%';".to_owned(),
            ))
            .await
            .expect("like fallback");
        assert_eq!(like.len(), 1, "LIKE fallback must serve short queries");
    }
}
