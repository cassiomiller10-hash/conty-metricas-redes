import type { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { type Clock, systemClock } from "./clock.ts";
import { type Transport, createProvider } from "./providers/adapter.ts";
import { PLATFORMS } from "./providers/types.ts";
import { getConnection, getPostHistory, getSyncRun, listCreatorPosts } from "./queries.ts";
import { DEFAULT_RETRY } from "./sync/retry-policy.ts";
import { type SyncConfig, type SyncDeps, SyncRefused, createConnection, runSync } from "./sync/sync-service.ts";

export const DEFAULT_SYNC_CONFIG: SyncConfig = { ...DEFAULT_RETRY, staleRunMs: 10 * 60_000, maxPages: 1_000 };

type Options = { clock?: Clock; config?: Partial<SyncConfig>; random?: () => number };

/** `transport` é a única ligação com as redes: o provedor falso aqui, `fetch` em produção. */
export function createApp(db: DatabaseSync, transport: Transport, options: Options = {}) {
  const clock = options.clock ?? systemClock;
  const deps: SyncDeps = {
    db,
    clock,
    config: { ...DEFAULT_SYNC_CONFIG, ...options.config },
    random: options.random ?? Math.random,
    providerFor: (platform) => createProvider(platform, transport, clock),
  };
  const app = new Hono();

  app.onError((error, c) => {
    if (error instanceof SyncRefused) {
      if (error.status === 429) c.header("retry-after", String(error.details.retry_in_seconds));
      return c.json({ error: error.code, message: error.message, ...error.details }, error.status);
    }
    console.error(error);
    return c.json({ error: "erro_interno", message: "Erro inesperado." }, 500);
  });

  const body = async (c: { req: { json: () => Promise<unknown> } }) => {
    const parsed = await c.req.json().catch(() => null);
    if (!parsed || typeof parsed !== "object") throw new SyncRefused(400, "corpo_invalido", "Envie um objeto JSON.");
    return parsed as Record<string, unknown>;
  };

  app.get("/health", (c) => c.json({ ok: true }));

  app.post("/connections", async (c) => {
    // O token fica só no banco: a API nunca o devolve.
    const { access_token: _token, ...connection } = createConnection(db, clock, await body(c), PLATFORMS);
    return c.json(connection, 201);
  });

  app.get("/connections/:id", (c) => {
    const connection = getConnection(db, c.req.param("id"));
    return connection ? c.json(connection) : c.json({ error: "conexao_nao_encontrada" }, 404);
  });

  app.post("/connections/:id/syncs", async (c) => {
    const runId = await runSync(deps, c.req.param("id"), await body(c));
    return c.json(getSyncRun(db, runId), 201);
  });

  app.get("/syncs/:id", (c) => {
    const run = getSyncRun(db, c.req.param("id"));
    return run ? c.json(run) : c.json({ error: "sync_nao_encontrado" }, 404);
  });

  app.get("/creators/:id/posts", (c) => c.json(listCreatorPosts(db, c.req.param("id"))));

  app.get("/posts/:id/snapshots", (c) => {
    const history = getPostHistory(db, c.req.param("id"));
    return history ? c.json(history) : c.json({ error: "post_nao_encontrado" }, 404);
  });

  return app;
}
