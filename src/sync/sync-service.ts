import type { DatabaseSync } from "node:sqlite";
import type { Clock } from "../clock.ts";
import { transaction } from "../db.ts";
import { type MetricsProvider, type Platform, type ProviderPage, ProviderError } from "../providers/types.ts";
import { type PageStats, addStats, emptyStats, savePage } from "./metrics-store.ts";
import { type RetryConfig, decideRetry } from "./retry-policy.ts";

export type SyncConfig = RetryConfig & {
  /** Sync "rodando" sem sinal de vida por mais que isso é considerado abandonado. */
  staleRunMs: number;
  /** Proteção contra paginação que não termina. */
  maxPages: number;
};

export type SyncDeps = {
  db: DatabaseSync;
  clock: Clock;
  config: SyncConfig;
  random: () => number;
  providerFor: (platform: Platform) => MetricsProvider;
};

export type ConnectionRow = {
  id: string;
  creator_id: string;
  platform: Platform;
  access_token: string;
  status: "active" | "needs_reconnect";
  retry_not_before: string | null;
  created_at: string;
};

export type StopReason = "attempts_exhausted" | "revoked" | "rejected" | "rate_limited" | "page_limit" | "internal_error";

/** O sync nem começa: a resposta diz por quê e o que fazer. */
export class SyncRefused extends Error {
  constructor(
    readonly status: 404 | 409 | 400 | 429,
    readonly code: string,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
}

function isInstant(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

/** Abre o sync. O índice único do banco garante um "running" por conexão. */
function startRun(deps: SyncDeps, connection: ConnectionRow, from: string, to: string): string {
  const now = deps.clock.now();
  return transaction(deps.db, () => {
    const staleBefore = new Date(now.getTime() - deps.config.staleRunMs).toISOString();
    deps.db
      .prepare(
        "UPDATE sync_runs SET status = 'abandoned', finished_at = ?, error = 'sem sinal de vida' WHERE connection_id = ? AND status = 'running' AND heartbeat_at < ?",
      )
      .run(now.toISOString(), connection.id, staleBefore);
    const running = deps.db
      .prepare("SELECT id, started_at FROM sync_runs WHERE connection_id = ? AND status = 'running'")
      .get(connection.id) as { id: string; started_at: string } | undefined;
    if (running) {
      throw new SyncRefused(409, "sync_em_andamento", "Já existe um sync rodando para esta conexão.", {
        running_sync_id: running.id,
        running_since: running.started_at,
      });
    }
    const id = newId("syn");
    deps.db
      .prepare(
        "INSERT INTO sync_runs (id, connection_id, window_from, window_to, status, started_at, heartbeat_at) VALUES (?, ?, ?, ?, 'running', ?, ?)",
      )
      .run(id, connection.id, from, to, now.toISOString(), now.toISOString());
    return id;
  });
}

/** Chama a rede com prazo: se não responder em `requestTimeoutMs`, cancela e conta como timeout. */
async function callWithTimeout(deps: SyncDeps, call: (signal: AbortSignal) => Promise<ProviderPage>): Promise<ProviderPage> {
  const request = new AbortController();
  const timer = new AbortController();
  const timeout = deps.clock.sleep(deps.config.requestTimeoutMs, timer.signal).then((elapsed) => {
    if (!elapsed) return new Promise<never>(() => {});
    request.abort();
    throw new ProviderError({ kind: "timeout" });
  });
  try {
    return await Promise.race([call(request.signal), timeout]);
  } finally {
    timer.abort();
  }
}

export async function runSync(
  deps: SyncDeps,
  connectionId: string,
  window: { from?: unknown; to?: unknown },
): Promise<string> {
  const { db, clock, config } = deps;
  const connection = db.prepare("SELECT * FROM connections WHERE id = ?").get(connectionId) as ConnectionRow | undefined;
  if (!connection) throw new SyncRefused(404, "conexao_nao_encontrada", "Conexão não encontrada.");
  if (!isInstant(window.from) || !isInstant(window.to) || Date.parse(window.from) > Date.parse(window.to)) {
    throw new SyncRefused(400, "janela_invalida", "Informe from e to (datas ISO 8601), com from <= to.");
  }
  if (connection.status === "needs_reconnect") {
    throw new SyncRefused(409, "precisa_reconectar", "O acesso foi revogado pela rede. Conecte a conta de novo.");
  }
  const now = clock.now();
  if (connection.retry_not_before && Date.parse(connection.retry_not_before) > now.getTime()) {
    const waitMs = Date.parse(connection.retry_not_before) - now.getTime();
    throw new SyncRefused(429, "aguardando_limite_da_rede", "A rede pediu para esperar antes de um novo sync.", {
      retry_not_before: connection.retry_not_before,
      retry_in_seconds: Math.ceil(waitMs / 1000),
    });
  }

  const from = new Date(window.from).toISOString();
  const to = new Date(window.to).toISOString();
  const runId = startRun(deps, connection, from, to);
  const provider = deps.providerFor(connection.platform);
  let stats: PageStats = emptyStats();
  let pagesSaved = 0;
  let cursor: string | null = null;

  const finish = (stopReason: StopReason | null, error: string | null = null) => {
    const status = stopReason === null ? "completed" : pagesSaved > 0 ? "partial" : "failed";
    db.prepare(
      "UPDATE sync_runs SET status = ?, stop_reason = ?, finished_at = ?, pages_saved = ?, stats_json = ?, error = ? WHERE id = ?",
    ).run(status, stopReason, clock.now().toISOString(), pagesSaved, JSON.stringify(stats), error, runId);
    return runId;
  };
  const logAttempt = (page: number, attempt: number, startedAt: Date, outcome: string, waitMs: number | null) =>
    db
      .prepare("INSERT INTO sync_attempts (sync_run_id, page, attempt, started_at, outcome, wait_ms) VALUES (?, ?, ?, ?, ?, ?)")
      .run(runId, page, attempt, startedAt.toISOString(), outcome, waitMs);

  try {
    while (true) {
      const pageNumber = pagesSaved + 1;
      if (pageNumber > config.maxPages) return finish("page_limit");
      let page: ProviderPage | null = null;
      for (let attempt = 1; page === null; attempt += 1) {
        const startedAt = clock.now();
        db.prepare("UPDATE sync_runs SET heartbeat_at = ? WHERE id = ?").run(startedAt.toISOString(), runId);
        try {
          page = await callWithTimeout(deps, (signal) =>
            provider.fetchPosts({ token: connection.access_token, from, to, cursor }, signal),
          );
          logAttempt(pageNumber, attempt, startedAt, "ok", null);
        } catch (error) {
          if (!(error instanceof ProviderError)) throw error;
          const decision = decideRetry(error.failure, attempt, config, deps.random);
          const outcome = error.failure.kind;
          if (decision.action === "retry") {
            logAttempt(pageNumber, attempt, startedAt, outcome, decision.waitMs);
            await clock.sleep(decision.waitMs);
            continue;
          }
          logAttempt(pageNumber, attempt, startedAt, outcome, null);
          if (decision.action === "pause") {
            const retryNotBefore = new Date(clock.now().getTime() + decision.retryAfterMs).toISOString();
            db.prepare("UPDATE connections SET retry_not_before = ? WHERE id = ?").run(retryNotBefore, connection.id);
            return finish("rate_limited", `a rede pediu ${Math.ceil(decision.retryAfterMs / 1000)} s, acima do teto de ${config.maxRetryAfterMs / 1000} s`);
          }
          if (decision.reason === "revoked") {
            db.prepare("UPDATE connections SET status = 'needs_reconnect' WHERE id = ?").run(connection.id);
          }
          const detail = error.failure.kind === "rejected" ? error.failure.message : null;
          return finish(decision.reason, detail);
        }
      }
      stats = addStats(
        stats,
        savePage(
          db,
          {
            syncRunId: runId,
            connectionId: connection.id,
            creatorId: connection.creator_id,
            platform: connection.platform,
            fetchedAt: clock.now().toISOString(),
          },
          page,
        ),
      );
      pagesSaved += 1;
      cursor = page.nextCursor;
      if (cursor === null) return finish(null);
    }
  } catch (error) {
    finish("internal_error", error instanceof Error ? error.message : String(error));
    throw error;
  }
}

export function createConnection(
  db: DatabaseSync,
  clock: Clock,
  input: { creator_id?: unknown; platform?: unknown; access_token?: unknown },
  platforms: readonly string[],
): ConnectionRow {
  const creatorId = typeof input.creator_id === "string" ? input.creator_id.trim() : "";
  const token = typeof input.access_token === "string" ? input.access_token.trim() : "";
  if (!creatorId || !token) throw new SyncRefused(400, "dados_obrigatorios", "Informe creator_id e access_token.");
  if (typeof input.platform !== "string" || !platforms.includes(input.platform)) {
    throw new SyncRefused(400, "rede_invalida", `platform deve ser uma de: ${platforms.join(", ")}.`);
  }
  const row: ConnectionRow = {
    id: newId("con"),
    creator_id: creatorId,
    platform: input.platform as Platform,
    access_token: token,
    status: "active",
    retry_not_before: null,
    created_at: clock.now().toISOString(),
  };
  db.prepare(
    "INSERT INTO connections (id, creator_id, platform, access_token, status, retry_not_before, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(row.id, row.creator_id, row.platform, row.access_token, row.status, row.retry_not_before, row.created_at);
  return row;
}
