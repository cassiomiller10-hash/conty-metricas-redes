import { afterEach, describe, expect, it, vi } from "vitest";
import { decideRetry, DEFAULT_RETRY } from "../src/sync/retry-policy.ts";
import { postsOfMay, setup } from "./helpers.ts";

afterEach(() => vi.useRealTimers());

describe("falha passageira", () => {
  it("timeout: o serviço cancela a chamada em 10 s e tenta de novo depois do backoff", async () => {
    const api = setup();
    const connection = await api.connect("crt_ana", "instagram", "tok", postsOfMay(1));
    api.network.failNext("tok", { type: "timeout" });

    const pending = api.startSync(connection);
    await vi.advanceTimersByTimeAsync(10_000 + 499);
    expect(api.network.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    const run = await pending;

    expect(run.body.status).toBe("completed");
    expect(api.network.calls.map((call) => [api.elapsedMs(call.at), call.result])).toEqual([
      [0, "timeout"],
      [10_500, "200"],
    ]);
    expect(run.body.attempts[0]).toMatchObject({ outcome: "timeout", wait_ms: 500 });
  });

  it("erro 5xx: backoff 0,5 s → 1 s → 2 s e sucesso na quarta tentativa", async () => {
    const api = setup();
    const connection = await api.connect("crt_ana", "youtube", "tok", postsOfMay(1));
    api.network.failNext("tok", ...Array(3).fill({ type: "status", status: 503 }));
    const run = await api.sync(connection);
    expect(run.body.status).toBe("completed");
    expect(api.network.calls.map((call) => api.elapsedMs(call.at))).toEqual([0, 500, 1_500, 3_500]);
  });

  it("para no limite de tentativas: exatamente 4 chamadas, sem loop", async () => {
    const api = setup();
    const connection = await api.connect("crt_ana", "youtube", "tok", postsOfMay(1));
    api.network.failNext("tok", ...Array(10).fill({ type: "status", status: 500 }));
    const run = await api.sync(connection);
    expect(run.body).toMatchObject({ status: "failed", stop_reason: "attempts_exhausted", pages_saved: 0 });
    expect(api.network.calls).toHaveLength(4);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("falha que não se resolve sozinha", () => {
  it("acesso revogado para na hora e a conexão passa a precisar reconectar", async () => {
    const api = setup();
    const connection = await api.connect("crt_ana", "tiktok", "tok", postsOfMay(1));
    api.network.failNext("tok", { type: "status", status: 401 });
    const run = await api.sync(connection);
    expect(run.body).toMatchObject({ status: "failed", stop_reason: "revoked" });
    expect(api.network.calls).toHaveLength(1);
    expect((await api.get(`/connections/${connection}`)).body.status).toBe("needs_reconnect");

    const again = await api.sync(connection);
    expect([again.status, again.body.error]).toEqual([409, "precisa_reconectar"]);
    expect(api.network.calls).toHaveLength(1);
  });

  it("pedido recusado (400) para na hora", async () => {
    const api = setup();
    const connection = await api.connect("crt_ana", "x", "tok", postsOfMay(1));
    api.network.failNext("tok", { type: "status", status: 400 });
    const run = await api.sync(connection);
    expect(run.body).toMatchObject({ status: "failed", stop_reason: "rejected", error: "a rede recusou o pedido (400)" });
    expect(api.network.calls).toHaveLength(1);
  });
});

describe("política de retry (função pura)", () => {
  const config = { ...DEFAULT_RETRY, maxBackoffMs: 3_000 };

  it("backoff dobra até o máximo e o jitter só soma, até +20%", () => {
    const waits = [1, 2, 3].map((attempt) => decideRetry({ kind: "timeout" }, attempt, { ...config, maxAttempts: 10 }, () => 0));
    expect(waits).toEqual([
      { action: "retry", waitMs: 500, reason: "backoff" },
      { action: "retry", waitMs: 1_000, reason: "backoff" },
      { action: "retry", waitMs: 2_000, reason: "backoff" },
    ]);
    expect(decideRetry({ kind: "timeout" }, 3, { ...config, maxAttempts: 10 }, () => 1)).toMatchObject({ waitMs: 2_400 });
    expect(decideRetry({ kind: "timeout" }, 5, { ...config, maxAttempts: 10 }, () => 0)).toMatchObject({ waitMs: 3_000 });
  });

  it("Retry-After é seguido à risca até o teto; acima dele, pausa", () => {
    expect(decideRetry({ kind: "rate_limited", retryAfterMs: 60_000 }, 1, config, () => 1)).toEqual({
      action: "retry",
      waitMs: 60_000,
      reason: "retry_after",
    });
    expect(decideRetry({ kind: "rate_limited", retryAfterMs: 60_001 }, 1, config, () => 0)).toEqual({
      action: "pause",
      retryAfterMs: 60_001,
    });
  });

  it("revogado e recusado param mesmo na primeira tentativa; o resto para no teto", () => {
    expect(decideRetry({ kind: "revoked" }, 1, config, () => 0)).toEqual({ action: "stop", reason: "revoked" });
    expect(decideRetry({ kind: "rejected", status: 400, message: "" }, 1, config, () => 0)).toEqual({ action: "stop", reason: "rejected" });
    expect(decideRetry({ kind: "server_error", status: 500 }, 4, config, () => 0)).toEqual({ action: "stop", reason: "attempts_exhausted" });
  });
});
