// Contrato entre a regra de negócio e qualquer rede. O sync só conhece estes tipos:
// métricas já traduzidas e falhas já classificadas. Nomes de campo, códigos HTTP e
// formatos de cada rede ficam do outro lado, em adapter.ts e translators.ts.

export const PLATFORMS = ["instagram", "tiktok", "youtube", "x"] as const;
export type Platform = (typeof PLATFORMS)[number];

/** `null` = a rede não informa essa métrica. Nunca vira zero. */
export type PostMetrics = {
  views: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
};

export type ProviderPost = {
  externalId: string;
  publishedAt: string;
  /** Instante a que a rede diz que os números se referem. `null` quando a rede não informa. */
  reportedAt: string | null;
  metrics: PostMetrics;
};

export type ProviderPage = {
  posts: ProviderPost[];
  nextCursor: string | null;
  /** Cabeçalho `Date` da resposta: o relógio da rede ao responder (resolução de 1 s). `null` se ausente. */
  respondedAt: string | null;
};

export type FetchPostsRequest = { token: string; from: string; to: string; cursor: string | null };

export type ProviderFailure =
  | { kind: "timeout" }
  | { kind: "server_error"; status: number }
  | { kind: "rate_limited"; retryAfterMs: number | null }
  | { kind: "revoked" }
  | { kind: "rejected"; status: number; message: string };

export class ProviderError extends Error {
  constructor(readonly failure: ProviderFailure) {
    super(`provedor: ${failure.kind}`);
  }
}

export type MetricsProvider = {
  platform: Platform;
  fetchPosts(request: FetchPostsRequest, signal: AbortSignal): Promise<ProviderPage>;
};
