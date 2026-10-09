import { describe, expect, it } from "vitest";
import { createProvider, parseHttpDate } from "../src/providers/adapter.ts";
import { systemClock } from "../src/clock.ts";
import { FakeNetwork } from "../src/providers/fake-network.ts";
import { ProviderError, PLATFORMS } from "../src/providers/types.ts";

const post = {
  id: "abc",
  publishedAt: "2026-05-10T12:00:00.000Z",
  asOf: "2026-06-01T12:00:00.000Z",
  views: 10_400,
  likes: 820,
  comments: 41,
  shares: 12,
};

async function fetchOne(platform: (typeof PLATFORMS)[number]) {
  const network = new FakeNetwork(systemClock, 2, false);
  network.addAccount("tok", platform, [post]);
  const provider = createProvider(platform, network.transport, systemClock);
  const request = { token: "tok", from: "2026-05-01T00:00:00.000Z", to: "2026-05-31T23:59:59.999Z", cursor: null };
  return provider.fetchPosts(request, new AbortController().signal);
}

describe("tradutores das redes", () => {
  it.each([
    ["instagram", { reportedAt: "2026-06-01T12:00:00.000Z", metrics: { views: 10_400, likes: 820, comments: 41, shares: null } }],
    ["tiktok", { reportedAt: "2026-06-01T12:00:00.000Z", metrics: { views: 10_400, likes: 820, comments: 41, shares: 12 } }],
    ["youtube", { reportedAt: "2026-06-01T12:00:00.000Z", metrics: { views: 10_400, likes: 820, comments: 41, shares: null } }],
    ["x", { reportedAt: null, metrics: { views: 10_400, likes: 820, comments: 41, shares: 12 } }],
  ] as const)("%s chega no formato único", async (platform, expected) => {
    const page = await fetchOne(platform);
    expect(page).toEqual({
      posts: [{ externalId: "abc", publishedAt: "2026-05-10T12:00:00.000Z", ...expected }],
      nextCursor: null,
      respondedAt: null,
    });
  });

  it("resposta fora do formato vira recusa, não exceção solta", async () => {
    const provider = createProvider("youtube", async () => ({ status: 200, headers: {}, body: { items: "quebrado" } }), systemClock);
    const request = { token: "t", from: "a", to: "b", cursor: null };
    await expect(provider.fetchPosts(request, new AbortController().signal)).rejects.toSatisfy(
      (error: unknown) => error instanceof ProviderError && error.failure.kind === "rejected",
    );
  });
});

describe("cabeçalho Date da resposta", () => {
  it("vira respondedAt da página, em ISO", async () => {
    const transport = async () => ({ status: 200, headers: { date: "Mon, 01 Jun 2026 15:00:07 GMT" }, body: { data: [], meta: {} } });
    const page = await createProvider("x", transport, systemClock).fetchPosts(
      { token: "t", from: "a", to: "b", cursor: null },
      new AbortController().signal,
    );
    expect(page.respondedAt).toBe("2026-06-01T15:00:07.000Z");
  });

  it("ausente ou ilegível vira null", () => {
    expect(parseHttpDate(undefined)).toBeNull();
    expect(parseHttpDate("ontem à tarde")).toBeNull();
  });
});
