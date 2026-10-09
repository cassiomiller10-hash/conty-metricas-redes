import { afterEach, describe, expect, it, vi } from "vitest";
import { setup } from "./helpers.ts";

afterEach(() => vi.useRealTimers());

describe("API de conexões", () => {
  it("nunca devolve o token de acesso", async () => {
    const api = setup();
    const created = await api.post("/connections", { creator_id: "crt_ana", platform: "x", access_token: "segredo" });
    const read = await api.get(`/connections/${created.body.id}`);
    expect(created.status).toBe(201);
    expect(JSON.stringify(created.body) + JSON.stringify(read.body)).not.toContain("segredo");
  });

  it("valida rede, campos obrigatórios e janela", async () => {
    const api = setup();
    const badPlatform = await api.post("/connections", { creator_id: "crt_ana", platform: "orkut", access_token: "t" });
    const missing = await api.post("/connections", { platform: "x" });
    const connection = await api.connect("crt_ana", "x", "t");
    const badWindow = await api.post(`/connections/${connection}/syncs`, { from: "ontem" });
    const inverted = await api.post(`/connections/${connection}/syncs`, { from: "2026-05-31T00:00:00Z", to: "2026-05-01T00:00:00Z" });
    expect([badPlatform.status, badPlatform.body.error]).toEqual([400, "rede_invalida"]);
    expect([missing.status, missing.body.error]).toEqual([400, "dados_obrigatorios"]);
    expect([badWindow.status, badWindow.body.error]).toEqual([400, "janela_invalida"]);
    expect([inverted.status, inverted.body.error]).toEqual([400, "janela_invalida"]);
  });

  it("responde 404 para conexão, sync e post inexistentes", async () => {
    const api = setup();
    expect((await api.post("/connections/con_x/syncs", { from: "2026-05-01T00:00:00Z", to: "2026-05-02T00:00:00Z" })).status).toBe(404);
    expect((await api.get("/syncs/syn_x")).status).toBe(404);
    expect((await api.get("/posts/pst_x/snapshots")).status).toBe(404);
  });
});
