import type { ProviderFailure } from "../providers/types.ts";

export type RetryConfig = {
  /** Tentativas por chamada à rede, contando a primeira. */
  maxAttempts: number;
  /** Backoff de falha passageira: base, base×2, base×4… até `maxBackoffMs`. */
  baseBackoffMs: number;
  maxBackoffMs: number;
  /** Variação aleatória somada ao backoff (0,2 = até +20%). Nunca reduz a espera. */
  jitterRatio: number;
  /** Maior `Retry-After` que o sync aceita esperar dentro da mesma execução. */
  maxRetryAfterMs: number;
  /** Tempo máximo de uma chamada à rede antes de cancelá-la. */
  requestTimeoutMs: number;
};

export const DEFAULT_RETRY: RetryConfig = {
  maxAttempts: 4,
  baseBackoffMs: 500,
  maxBackoffMs: 8_000,
  jitterRatio: 0.2,
  maxRetryAfterMs: 60_000,
  requestTimeoutMs: 10_000,
};

export type RetryDecision =
  | { action: "retry"; waitMs: number; reason: "retry_after" | "backoff" }
  /** A rede pediu mais espera do que o teto: o sync para e anota quando pode voltar. */
  | { action: "pause"; retryAfterMs: number }
  | { action: "stop"; reason: "attempts_exhausted" | "revoked" | "rejected" };

/** Decide o que fazer depois da tentativa `attempt` (1 = primeira) falhar. Função pura. */
export function decideRetry(
  failure: ProviderFailure,
  attempt: number,
  config: RetryConfig,
  random: () => number,
): RetryDecision {
  if (failure.kind === "revoked") return { action: "stop", reason: "revoked" };
  if (failure.kind === "rejected") return { action: "stop", reason: "rejected" };
  if (failure.kind === "rate_limited" && failure.retryAfterMs !== null && failure.retryAfterMs > config.maxRetryAfterMs) {
    return { action: "pause", retryAfterMs: failure.retryAfterMs };
  }
  if (attempt >= config.maxAttempts) return { action: "stop", reason: "attempts_exhausted" };
  if (failure.kind === "rate_limited" && failure.retryAfterMs !== null) {
    // Espera exatamente o que a rede pediu: nem menos (tomaria outro 429), nem jitter para mais.
    return { action: "retry", waitMs: failure.retryAfterMs, reason: "retry_after" };
  }
  // timeout, erro 5xx ou 429 sem Retry-After
  const exponential = Math.min(config.maxBackoffMs, config.baseBackoffMs * 2 ** (attempt - 1));
  return { action: "retry", waitMs: Math.round(exponential * (1 + config.jitterRatio * random())), reason: "backoff" };
}
