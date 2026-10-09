import { afterEach, describe, expect, it, vi } from "vitest";
import { postsOfMay, setup } from "./helpers.ts";

afterEach(() => vi.useRealTimers());

const sumViews = (days: number[]) => days.reduce((total, day) => total + 1_000 * day, 0);

describe("mesmo dado chegando de novo", () => {
  it("a mesma página recebida duas vezes não muda o total", async () => {
    const api = setup();
    const connection = await api.connect("crt_ana", "instagram", "tok", postsOfMay(4));
    // 1ª chamada normal; 2ª devolve de novo a página 1 (mesmo corpo); depois segue normal.
    api.network.failNext("tok", { type: "pass" }, { type: "repeat_last_response" });
    const run = await api.sync(connection);
    expect(run.body).toMatchObject({ status: "completed", pages_saved: 3 });
    expect(run.body.stats).toMatchObject({ posts_received: 6, new_posts: 4, applied: 4, duplicates_ignored: 2 });

    const { body } = await api.posts("crt_ana");
    expect(body.post_count).toBe(4);
    expect(body.totals.views.sum).toBe(sumViews([1, 2, 3, 4]));
  });

  it("post repetido dentro da mesma página conta uma vez", async () => {
    const api = setup();
    const connection = await api.connect("crt_ana", "tiktok", "tok", postsOfMay(2));
    api.network.failNext("tok", { type: "duplicate_items" });
    const run = await api.sync(connection);
    expect(run.body.stats).toMatchObject({ posts_received: 4, applied: 2, duplicates_ignored: 2 });
    expect((await api.posts("crt_ana")).body.totals.views.sum).toBe(sumViews([1, 2]));
  });

  it("janelas sobrepostas contam cada post uma vez só", async () => {
    const api = setup();
    const connection = await api.connect("crt_ana", "youtube", "tok", postsOfMay(12));
    await api.sync(connection, { from: "2026-05-01T00:00:00.000Z", to: "2026-05-07T23:59:59.999Z" });
    const second = await api.sync(connection, { from: "2026-05-05T00:00:00.000Z", to: "2026-05-12T23:59:59.999Z" });
    // Dias 5, 6 e 7 vêm nas duas janelas com o mesmo dado: ignorados na segunda.
    expect(second.body.stats).toMatchObject({ posts_received: 8, new_posts: 5, applied: 5, duplicates_ignored: 3 });

    const { body } = await api.posts("crt_ana");
    expect(body.post_count).toBe(12);
    expect(body.totals.views.sum).toBe(sumViews([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]));
  });

  it("na sobreposição, um número mais novo substitui o anterior em vez de somar", async () => {
    const api = setup();
    const connection = await api.connect("crt_ana", "instagram", "tok", postsOfMay(7));
    await api.sync(connection, { from: "2026-05-01T00:00:00.000Z", to: "2026-05-07T23:59:59.999Z" });
    api.network.setPost("tok", { ...postsOfMay(1, 6)[0]!, views: 9_999, asOf: "2026-06-01T14:00:00.000Z" });
    await api.sync(connection, { from: "2026-05-05T00:00:00.000Z", to: "2026-05-07T23:59:59.999Z" });

    const { body } = await api.posts("crt_ana");
    expect(body.totals.views.sum).toBe(sumViews([1, 2, 3, 4, 5, 7]) + 9_999);
    expect(body.posts.find((post: { external_id: string }) => post.external_id === "p06")).toMatchObject({
      views: 9_999,
      current_reported_at: "2026-06-01T14:00:00.000Z",
    });
  });
});

describe("ordem dos dados pela data informada pela rede", () => {
  async function postWithHistory() {
    const api = setup();
    const connection = await api.connect("crt_ana", "instagram", "tok", [
      { id: "p01", publishedAt: "2026-05-01T12:00:00.000Z", asOf: "2026-06-01T10:00:00.000Z", views: 1_000 },
    ]);
    await api.sync(connection);
    const postId = (await api.posts("crt_ana")).body.posts[0].id as string;
    return { api, connection, postId };
  }

  it("uma resposta antiga não apaga uma mais nova", async () => {
    const { api, connection, postId } = await postWithHistory();
    api.network.setPost("tok", { id: "p01", publishedAt: "2026-05-01T12:00:00.000Z", asOf: "2026-06-01T08:00:00.000Z", views: 700 });
    const run = await api.sync(connection);
    expect(run.body.stats).toMatchObject({ applied: 0, stale: 1 });

    expect((await api.posts("crt_ana")).body.posts[0]).toMatchObject({ views: 1_000, current_reported_at: "2026-06-01T10:00:00.000Z" });
    const history = (await api.get(`/posts/${postId}/snapshots`)).body;
    expect(history.snapshots.map((snapshot: { views: number; outcome: string }) => [snapshot.views, snapshot.outcome])).toEqual([
      [700, "stale"],
      [1_000, "applied"],
    ]);
  });

  it("uma queda real (data mais nova) é aceita e registrada", async () => {
    const { api, connection, postId } = await postWithHistory();
    api.network.setPost("tok", { id: "p01", publishedAt: "2026-05-01T12:00:00.000Z", asOf: "2026-06-01T14:00:00.000Z", views: 640 });
    const run = await api.sync(connection);
    expect(run.body.stats).toMatchObject({ applied: 1, decreases: 1 });

    expect((await api.posts("crt_ana")).body.totals.views.sum).toBe(640);
    const latest = (await api.get(`/posts/${postId}/snapshots`)).body.snapshots.at(-1);
    expect(latest).toMatchObject({ views: 640, outcome: "applied", decreased: true });
  });

  it("mesma data com números diferentes: fica o primeiro e o conflito é registrado", async () => {
    const { api, connection, postId } = await postWithHistory();
    api.network.setPost("tok", { id: "p01", publishedAt: "2026-05-01T12:00:00.000Z", asOf: "2026-06-01T10:00:00.000Z", views: 1_234 });
    const run = await api.sync(connection);
    expect(run.body.stats).toMatchObject({ applied: 0, conflicts: 1 });

    expect((await api.posts("crt_ana")).body.posts[0].views).toBe(1_000);
    const history = (await api.get(`/posts/${postId}/snapshots`)).body;
    expect(history.snapshots).toHaveLength(1);
    expect(history.conflicts).toEqual([
      expect.objectContaining({ reported_at: "2026-06-01T10:00:00.000Z", received: { views: 1_234, likes: null, comments: null, shares: null } }),
    ]);
  });
});

describe("identidade do post", () => {
  it("reconectar a conta (conexão nova) não duplica posts", async () => {
    const api = setup();
    const posts = postsOfMay(3);
    const first = await api.connect("crt_ana", "tiktok", "tok-antigo", posts);
    await api.sync(first);
    const second = await api.connect("crt_ana", "tiktok", "tok-novo", posts);
    const run = await api.sync(second);
    expect(run.body.stats).toMatchObject({ new_posts: 0, duplicates_ignored: 3 });
    expect((await api.posts("crt_ana")).body.post_count).toBe(3);
  });

  it("rede sem data da métrica (X) usa o cabeçalho Date da resposta: o histórico cresce, o total não", async () => {
    const api = setup();
    const connection = await api.connect("crt_ana", "x", "tok", postsOfMay(2, 1, { asOf: undefined }));
    vi.advanceTimersByTime(1_250);
    await api.sync(connection);
    vi.advanceTimersByTime(60_000);
    const again = await api.sync(connection);
    expect(again.body.stats).toMatchObject({ applied: 2, decreases: 0 });

    const { body } = await api.posts("crt_ana");
    expect(body.totals.views.sum).toBe(sumViews([1, 2]));
    // Date tem resolução de 1 s: 15:01:01.250 vira 15:01:01.000; a busca guarda o milissegundo.
    expect(body.posts[0]).toMatchObject({ current_reported_at: "2026-06-01T15:01:01.000Z", current_fetched_at: "2026-06-01T15:01:01.250Z" });
    const history = (await api.get(`/posts/${body.posts[0].id}/snapshots`)).body.snapshots;
    expect(history.map((snapshot: { reported_at_source: string }) => snapshot.reported_at_source)).toEqual(["response_date", "response_date"]);
  });

  it("sem data da métrica, uma resposta com Date mais antigo (réplica atrasada) não apaga a mais nova", async () => {
    const api = setup();
    const connection = await api.connect("crt_ana", "x", "tok", [{ id: "x1", publishedAt: "2026-05-01T12:00:00.000Z", views: 1_000 }]);
    await api.sync(connection);
    vi.advanceTimersByTime(60_000);
    api.network.setPost("tok", { id: "x1", publishedAt: "2026-05-01T12:00:00.000Z", views: 900 });
    api.network.failNext("tok", { type: "dated", date: "2026-06-01T14:30:00.000Z" });
    const run = await api.sync(connection);
    expect(run.body.stats).toMatchObject({ applied: 0, stale: 1 });
    expect((await api.posts("crt_ana")).body.posts[0]).toMatchObject({ views: 1_000, current_reported_at: "2026-06-01T15:00:00.000Z" });
  });

  it("sem data da métrica e sem cabeçalho Date, usa a hora da busca", async () => {
    const api = setup({ dateHeader: false });
    const connection = await api.connect("crt_ana", "x", "tok", postsOfMay(1, 1, { asOf: undefined }));
    vi.advanceTimersByTime(1_250);
    await api.sync(connection);
    const post = (await api.posts("crt_ana")).body.posts[0];
    expect(post.current_reported_at).toBe("2026-06-01T15:00:01.250Z");
    const [snapshot] = (await api.get(`/posts/${post.id}/snapshots`)).body.snapshots;
    expect(snapshot.reported_at_source).toBe("fetched_at");
  });

  it("duas respostas no mesmo segundo com números diferentes: fica a primeira e o conflito é registrado", async () => {
    const api = setup();
    const connection = await api.connect("crt_ana", "x", "tok", [{ id: "x1", publishedAt: "2026-05-01T12:00:00.000Z", views: 1_000 }]);
    await api.sync(connection);
    vi.advanceTimersByTime(400);
    api.network.setPost("tok", { id: "x1", publishedAt: "2026-05-01T12:00:00.000Z", views: 1_010 });
    const run = await api.sync(connection);
    expect(run.body.stats).toMatchObject({ applied: 0, conflicts: 1 });
    expect((await api.posts("crt_ana")).body.posts[0].views).toBe(1_000);
  });
});

describe("quando a métrica foi buscada", () => {
  it("cada snapshot guarda a data informada pela rede e o momento da busca; o post guarda a última checagem", async () => {
    const api = setup();
    const connection = await api.connect("crt_ana", "instagram", "tok", postsOfMay(1));
    vi.advanceTimersByTime(5_000);
    await api.sync(connection);
    vi.advanceTimersByTime(3_600_000);
    await api.sync(connection);

    const post = (await api.posts("crt_ana")).body.posts[0];
    expect(post).toMatchObject({
      current_reported_at: "2026-06-01T12:00:00.000Z",
      current_fetched_at: "2026-06-01T15:00:05.000Z",
      last_checked_at: "2026-06-01T16:00:05.000Z",
    });
    const [snapshot] = (await api.get(`/posts/${post.id}/snapshots`)).body.snapshots;
    expect(snapshot).toMatchObject({ reported_at: "2026-06-01T12:00:00.000Z", reported_at_source: "provider", fetched_at: "2026-06-01T15:00:05.000Z" });
  });

  it("métrica que a rede não informa fica nula, não zero", async () => {
    const api = setup();
    const connection = await api.connect("crt_ana", "youtube", "tok", postsOfMay(2, 1, { shares: 77 }));
    await api.sync(connection);
    const { body } = await api.posts("crt_ana");
    expect(body.posts.map((post: { shares: number | null }) => post.shares)).toEqual([null, null]);
    expect(body.totals.shares).toEqual({ sum: 0, posts_not_reported: 2 });
  });
});
