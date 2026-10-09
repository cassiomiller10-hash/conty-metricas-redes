import { afterEach, describe, expect, it, vi } from "vitest";
import { postsOfMay, setup } from "./helpers.ts";

afterEach(() => vi.useRealTimers());

describe("falha no meio da paginação", () => {
  it("guarda as páginas que chegaram, marca parcial e uma nova execução completa sem duplicar", async () => {
    const api = setup({ pageSize: 2 });
    const connection = await api.connect("crt_ana", "instagram", "tok", postsOfMay(10));
    api.network.failNext("tok", { type: "pass" }, { type: "pass" }, ...Array(4).fill({ type: "status", status: 500 }));

    const first = await api.sync(connection);
    expect(first.body).toMatchObject({ status: "partial", stop_reason: "attempts_exhausted", pages_saved: 2 });
    expect((await api.posts("crt_ana")).body.post_count).toBe(4);

    const second = await api.sync(connection);
    expect(second.body).toMatchObject({ status: "completed", pages_saved: 5 });
    expect(second.body.stats).toMatchObject({ new_posts: 6, duplicates_ignored: 4 });
    const { body } = await api.posts("crt_ana");
    expect(body.post_count).toBe(10);
    expect(body.totals.views.sum).toBe(55_000);
  });
});

describe("dois syncs da mesma conexão", () => {
  it("o segundo é recusado enquanto o primeiro roda e informa qual está rodando", async () => {
    const api = setup();
    const connection = await api.connect("crt_ana", "instagram", "tok", postsOfMay(2));
    api.network.failNext("tok", { type: "status", status: 429, retryAfter: "30" });

    const first = api.startSync(connection);
    await vi.advanceTimersByTimeAsync(1_000);
    const second = await api.startSync(connection);
    expect(second.status).toBe(409);
    expect(second.body).toMatchObject({ error: "sync_em_andamento", running_since: "2026-06-01T15:00:00.000Z" });

    await vi.advanceTimersByTimeAsync(29_000);
    const done = await first;
    expect(second.body.running_sync_id).toBe(done.body.id);
    expect(done.body.status).toBe("completed");
    expect((await api.sync(connection)).status).toBe(201);
  });

  it("sync preso sem sinal de vida é considerado abandonado e não bloqueia para sempre", async () => {
    const api = setup({ config: { staleRunMs: 10 * 60_000 } });
    const connection = await api.connect("crt_ana", "instagram", "tok", postsOfMay(1));
    api.db
      .prepare(
        "INSERT INTO sync_runs (id, connection_id, window_from, window_to, status, started_at, heartbeat_at) VALUES ('syn_preso', ?, 'a', 'b', 'running', '2026-06-01T14:40:00.000Z', '2026-06-01T14:49:59.999Z')",
      )
      .run(connection);
    const run = await api.sync(connection);
    expect(run.body.status).toBe("completed");
    expect((await api.get("/syncs/syn_preso")).body).toMatchObject({ status: "abandoned", error: "sem sinal de vida" });
  });

  it("o bloqueio é do banco: um segundo 'running' para a mesma conexão não entra", async () => {
    const api = setup();
    const connection = await api.connect("crt_ana", "instagram", "tok", postsOfMay(1));
    const insert = api.db.prepare(
      "INSERT INTO sync_runs (id, connection_id, window_from, window_to, status, started_at, heartbeat_at) VALUES (?, ?, 'a', 'b', 'running', 'x', 'x')",
    );
    insert.run("syn_a", connection);
    expect(() => insert.run("syn_b", connection)).toThrow(/UNIQUE/);
  });
});
