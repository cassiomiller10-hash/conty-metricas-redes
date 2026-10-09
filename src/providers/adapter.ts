import type { Clock } from "../clock.ts";
import { MalformedResponse, translatePage } from "./translators.ts";
import { type FetchPostsRequest, type MetricsProvider, type Platform, ProviderError } from "./types.ts";

/** Resposta no formato HTTP. Em produção viria de `fetch`; aqui vem do provedor falso. */
export type HttpResponse = { status: number; headers: Record<string, string>; body: unknown };

export type Transport = (
  request: FetchPostsRequest & { platform: Platform },
  signal: AbortSignal,
) => Promise<HttpResponse>;

/** `Retry-After` em segundos ("30") ou em data HTTP ("Wed, 21 Oct 2026 07:28:00 GMT"). */
export function parseRetryAfter(value: string | undefined, now: Date): number | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return null;
  return Math.max(0, date - now.getTime());
}

/** Cabeçalho `Date` (IMF-fixdate, resolução de 1 s) em ISO. Ausente ou ilegível → null. */
export function parseHttpDate(value: string | undefined): string | null {
  if (value === undefined) return null;
  const date = Date.parse(value);
  return Number.isNaN(date) ? null : new Date(date).toISOString();
}

/**
 * Traduz o mundo da rede (status HTTP, cabeçalhos, nomes de campo) para o contrato de
 * types.ts. Daqui para dentro, o sync só vê ProviderPage ou ProviderError.
 */
export function createProvider(platform: Platform, transport: Transport, clock: Clock): MetricsProvider {
  return {
    platform,
    async fetchPosts(request, signal) {
      let response: HttpResponse;
      try {
        response = await transport({ ...request, platform }, signal);
      } catch {
        // Conexão caiu ou foi cancelada pelo nosso timeout: as duas são passageiras.
        throw new ProviderError(signal.aborted ? { kind: "timeout" } : { kind: "server_error", status: 0 });
      }
      const { status } = response;
      if (status === 200) {
        try {
          return { ...translatePage(platform, response.body), respondedAt: parseHttpDate(response.headers.date) };
        } catch (error) {
          if (error instanceof MalformedResponse) {
            throw new ProviderError({ kind: "rejected", status, message: `resposta fora do formato: ${error.message}` });
          }
          throw error;
        }
      }
      if (status === 429) {
        const retryAfter = response.headers["retry-after"];
        throw new ProviderError({ kind: "rate_limited", retryAfterMs: parseRetryAfter(retryAfter, clock.now()) });
      }
      if (status === 401 || status === 403) throw new ProviderError({ kind: "revoked" });
      if (status >= 500) throw new ProviderError({ kind: "server_error", status });
      throw new ProviderError({ kind: "rejected", status, message: `a rede recusou o pedido (${status})` });
    },
  };
}
