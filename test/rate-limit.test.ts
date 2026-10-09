import { afterEach, describe, expect, it, vi } from "vitest";
import { postsOfMay, setup } from "./helpers.ts";

afterEach(() => vi.useRealTimers());

describe("429 com Retry-After dentro do teto", () => {
  it("espera exatamente os 30 s pedidos: nenhuma chamada antes, a próxima no segundo 30", async () => {
    const api = setup();
    const connection = await api.connect("crt_ana", "instagram", "tok", postsOfMay(2));
    api.network.failNext("tok", { type: "status", status: 429, retryAfter: "30" });

    const pending = api.startSync(connection);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(api.network.calls.map((call) => call.result)).toEqual(["status 429"]);

    await vi.advanceTimersByTimeAsync(1);
    const run = await pending;
    expect(run.body.status).toBe("completed");
    expect(api.network.calls.map((call) => [api.elapsedMs(call.at), call.result])).toEqual([
      [0, "status 429"],
      [30_000, "200"],
    ]);
    expect(run.body.attempts).toEqual([
      { page: 1, attempt: 1, started_at: "2026-06-01T15:00:00.000Z", outcome: "rate_limited", wait_ms: 30_000 },
      { page: 1, attempt: 2, started_at: "2026-06-01T15:00:30.000Z", outcome: "ok", wait_ms: null },
    ]);
  });

  it("aceita Retry-After como data HTTP", async () => {
    const api = setup();
    const connection = await api.connect("crt_ana", "tiktok", "tok", postsOfMay(1));
    api.network.failNext("tok", { type: "status", status: 429, retryAfter: "Mon, 01 Jun 2026 15:00:45 GMT" });
    await api.sync(connection);
    expect(api.network.calls.map((call) => api.elapsedMs(call.at))).toEqual([0, 45_000]);
  });

  it("um 429 esperado conta como tentativa: quatro seguidos encerram o sync", async () => {
    const api = setup();
    const connection = await api.connect("crt_ana", "instagram", "tok", postsOfMay(1));
    api.network.failNext("tok", ...Array(4).fill({ type: "status", status: 429, retryAfter: "5" }));
    const run = await api.sync(connection);
    expect(run.body).toMatchObject({ status: "failed", stop_reason: "attempts_exhausted" });
    expect(api.network.calls).toHaveLength(4);
  });

  it("429 sem Retry-After vira falha passageira com backoff", async () => {
    const api = setup();
    const connection = await api.connect("crt_ana", "instagram", "tok", postsOfMay(1));
    api.network.failNext("tok", { type: "status", status: 429 });
    await api.sync(connection);
    expect(api.network.calls.map((call) => api.elapsedMs(call.at))).toEqual([0, 500]);
  });
});

describe("429 com Retry-After acima do teto", () => {
  it("para o sync, anota quando pode voltar e recusa um novo sync antes do prazo", async () => {
    const api = setup({ config: { maxRetryAfterMs: 60_000 } });
    const connection = await api.connect("crt_ana", "instagram", "tok", postsOfMay(4));
    api.network.failNext("tok", { type: "pass" }, { type: "status", status: 429, retryAfter: "120" });

    const run = await api.sync(connection);
    expect(run.body).toMatchObject({ status: "partial", stop_reason: "rate_limited", pages_saved: 1 });
    expect(run.body.error).toBe("a rede pediu 120 s, acima do teto de 60 s");
    expect(api.network.calls).toHaveLength(2);
    expect((await api.get(`/connections/${connection}`)).body.retry_not_before).toBe("2026-06-01T15:02:00.000Z");

    vi.advanceTimersByTime(60_000);
    const early = await api.sync(connection);
    expect(early.status).toBe(429);
    expect(early.headers.get("retry-after")).toBe("60");
    expect(early.body).toMatchObject({ error: "aguardando_limite_da_rede", retry_not_before: "2026-06-01T15:02:00.000Z", retry_in_seconds: 60 });
    expect(api.network.calls).toHaveLength(2);

    vi.advanceTimersByTime(60_000);
    const later = await api.sync(connection);
    expect(later.body).toMatchObject({ status: "completed", pages_saved: 2 });
    expect((await api.posts("crt_ana")).body.post_count).toBe(4);
  });

  it("nunca espera além do teto, nem uma vez", async () => {
    const api = setup({ config: { maxRetryAfterMs: 60_000 } });
    const connection = await api.connect("crt_ana", "instagram", "tok", postsOfMay(1));
    api.network.failNext("tok", { type: "status", status: 429, retryAfter: "61" });
    const run = await api.sync(connection);
    expect(run.body).toMatchObject({ status: "failed", stop_reason: "rate_limited" });
    expect(run.body.attempts).toEqual([expect.objectContaining({ outcome: "rate_limited", wait_ms: null })]);
    expect(api.network.calls).toHaveLength(1);
  });
});
