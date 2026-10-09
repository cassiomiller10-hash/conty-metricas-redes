import { vi } from "vitest";
import { DEFAULT_SYNC_CONFIG, createApp } from "../src/app.ts";
import { systemClock } from "../src/clock.ts";
import { openDatabase } from "../src/db.ts";
import { type FakePost, FakeNetwork } from "../src/providers/fake-network.ts";
import type { Platform } from "../src/providers/types.ts";
import type { SyncConfig } from "../src/sync/sync-service.ts";

export const START = "2026-06-01T15:00:00.000Z";
export const WINDOW = { from: "2026-05-01T00:00:00.000Z", to: "2026-05-31T23:59:59.999Z" };

/**
 * Relógio controlado: os timers falsos do Vitest assumem Date e setTimeout. Nenhum teste espera
 * de verdade; quem avança o tempo é o teste. Jitter zerado para os tempos serem exatos.
 */
export function setup(options: { pageSize?: number; config?: Partial<SyncConfig>; dateHeader?: boolean } = {}) {
  vi.useFakeTimers({ now: new Date(START) });
  const db = openDatabase(":memory:");
  const network = new FakeNetwork(systemClock, options.pageSize ?? 2, options.dateHeader ?? true);
  const app = createApp(db, network.transport, {
    random: () => 0,
    config: { ...DEFAULT_SYNC_CONFIG, ...options.config },
  });

  async function call(method: string, path: string, payload?: unknown) {
    const res = await app.request(path, {
      method,
      headers: { "content-type": "application/json" },
      body: payload === undefined ? undefined : JSON.stringify(payload),
    });
    // biome-ignore lint: corpo genérico nos testes
    return { status: res.status, headers: res.headers, body: (await res.json()) as any };
  }

  return {
    db,
    network,
    get: (path: string) => call("GET", path),
    post: (path: string, payload?: unknown) => call("POST", path, payload),
    async connect(creatorId: string, platform: Platform, token: string, posts?: FakePost[]) {
      if (posts) network.addAccount(token, platform, posts);
      const res = await call("POST", "/connections", { creator_id: creatorId, platform, access_token: token });
      return res.body.id as string;
    },
    /** Começa o sync sem esperar; o teste decide quanto tempo passa. */
    startSync: (connectionId: string, window = WINDOW) => call("POST", `/connections/${connectionId}/syncs`, window),
    /** Roda o sync deixando todos os timers vencerem. */
    async sync(connectionId: string, window = WINDOW) {
      const pending = call("POST", `/connections/${connectionId}/syncs`, window);
      await vi.runAllTimersAsync();
      return pending;
    },
    posts: (creatorId: string) => call("GET", `/creators/${creatorId}/posts`),
    elapsedMs: (iso: string) => Date.parse(iso) - Date.parse(START),
  };
}

/** Posts publicados em maio, um por dia a partir de `firstDay`. */
export function postsOfMay(count: number, firstDay = 1, base: Partial<FakePost> = {}): FakePost[] {
  return Array.from({ length: count }, (_, index) => {
    const day = String(firstDay + index).padStart(2, "0");
    return {
      id: `p${day}`,
      publishedAt: `2026-05-${day}T12:00:00.000Z`,
      asOf: "2026-06-01T12:00:00.000Z",
      views: 1_000 * (firstDay + index),
      likes: 10 * (firstDay + index),
      comments: firstDay + index,
      ...base,
    };
  });
}
