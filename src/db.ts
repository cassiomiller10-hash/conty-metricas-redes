import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS connections (
  id TEXT PRIMARY KEY,
  creator_id TEXT NOT NULL,
  platform TEXT NOT NULL,
  access_token TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'needs_reconnect')),
  retry_not_before TEXT,
  created_at TEXT NOT NULL
);

-- Um post é a rede + o id dele na rede. A conexão não entra: reconectar não duplica o post.
-- As colunas de métrica guardam o valor ATUAL (o snapshot de data informada mais recente).
CREATE TABLE IF NOT EXISTS posts (
  id TEXT PRIMARY KEY,
  platform TEXT NOT NULL,
  external_id TEXT NOT NULL,
  creator_id TEXT NOT NULL,
  first_connection_id TEXT NOT NULL,
  published_at TEXT NOT NULL,
  views INTEGER,
  likes INTEGER,
  comments INTEGER,
  shares INTEGER,
  current_snapshot_id TEXT,
  current_reported_at TEXT,
  current_fetched_at TEXT,
  last_checked_at TEXT,
  UNIQUE (platform, external_id)
);

-- Histórico: o que a rede disse, a que instante se refere e quando buscamos.
-- (post, reported_at) é a identidade do dado: a mesma chegada duas vezes não grava de novo.
CREATE TABLE IF NOT EXISTS metric_snapshots (
  id TEXT PRIMARY KEY,
  post_id TEXT NOT NULL REFERENCES posts(id),
  sync_run_id TEXT NOT NULL,
  reported_at TEXT NOT NULL,
  reported_at_source TEXT NOT NULL CHECK (reported_at_source IN ('provider', 'response_date', 'fetched_at')),
  fetched_at TEXT NOT NULL,
  views INTEGER,
  likes INTEGER,
  comments INTEGER,
  shares INTEGER,
  outcome TEXT NOT NULL CHECK (outcome IN ('applied', 'stale')),
  decreased INTEGER NOT NULL DEFAULT 0,
  UNIQUE (post_id, reported_at)
);

-- Mesma data informada, números diferentes: erro da rede (ou, com o cabeçalho Date, duas respostas
-- no mesmo segundo). Não dá para saber qual é a mais nova: fica o primeiro e o conflito é registrado.
CREATE TABLE IF NOT EXISTS metric_conflicts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id TEXT NOT NULL REFERENCES posts(id),
  sync_run_id TEXT NOT NULL,
  reported_at TEXT NOT NULL,
  kept_snapshot_id TEXT NOT NULL,
  received_json TEXT NOT NULL,
  detected_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sync_runs (
  id TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL REFERENCES connections(id),
  window_from TEXT NOT NULL,
  window_to TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'partial', 'failed', 'abandoned')),
  stop_reason TEXT,
  started_at TEXT NOT NULL,
  heartbeat_at TEXT NOT NULL,
  finished_at TEXT,
  pages_saved INTEGER NOT NULL DEFAULT 0,
  stats_json TEXT NOT NULL DEFAULT '{}',
  error TEXT
);

-- O bloqueio de "um sync por conexão" é do banco, não de um if: dois inserts 'running' para a
-- mesma conexão não passam.
CREATE UNIQUE INDEX IF NOT EXISTS one_running_sync_per_connection
  ON sync_runs (connection_id) WHERE status = 'running';

CREATE TABLE IF NOT EXISTS sync_attempts (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  sync_run_id TEXT NOT NULL REFERENCES sync_runs(id),
  page INTEGER NOT NULL,
  attempt INTEGER NOT NULL,
  started_at TEXT NOT NULL,
  outcome TEXT NOT NULL,
  wait_ms INTEGER
);
`;

export function openDatabase(path = ":memory:"): DatabaseSync {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(SCHEMA);
  return db;
}

export function transaction<T>(db: DatabaseSync, work: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = work();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
