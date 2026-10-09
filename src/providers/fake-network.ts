import type { Clock } from "../clock.ts";
import type { HttpResponse, Transport } from "./adapter.ts";
import type { Platform } from "./types.ts";

// Provedor falso: imita as quatro redes, cada uma com seu formato de resposta, e deixa o
// teste programar problemas para as próximas chamadas. Não sabe nada da regra de negócio.

export type FakePost = {
  id: string;
  publishedAt: string;
  /** Instante a que a rede diz que os números se referem (o X não expõe). */
  asOf?: string;
  views?: number;
  likes?: number;
  comments?: number;
  shares?: number;
};

export type Fault =
  /** Responde normalmente (serve para posicionar a próxima falha na sequência). */
  | { type: "pass" }
  /** Não responde: só termina quando o serviço cancela a chamada. */
  | { type: "timeout" }
  /** Responde com esse status (por exemplo 429 com `retryAfter`, 500, 401, 400). */
  | { type: "status"; status: number; retryAfter?: string }
  /** Devolve de novo exatamente o último corpo enviado (resposta duplicada). */
  | { type: "repeat_last_response" }
  /** A página certa, mas com cada post repetido. */
  | { type: "duplicate_items" }
  /** Resposta normal com este cabeçalho `Date` (réplica ou cache atrasado da rede). */
  | { type: "dated"; date: string };

type Account = { platform: Platform; posts: Map<string, FakePost> };

export type FakeCall = { at: string; token: string; cursor: string | null; result: string };

export class FakeNetwork {
  readonly calls: FakeCall[] = [];
  private readonly accounts = new Map<string, Account>();
  private readonly faults = new Map<string, Fault[]>();
  private readonly lastBody = new Map<string, unknown>();

  constructor(
    private readonly clock: Clock,
    readonly pageSize = 2,
    /** Servidores reais mandam `Date`; desligar simula uma rede que não manda. */
    private readonly sendDateHeader = true,
  ) {}

  private headers(extra: Record<string, string> = {}, date = this.clock.now()): Record<string, string> {
    return this.sendDateHeader ? { date: date.toUTCString(), ...extra } : extra;
  }

  addAccount(token: string, platform: Platform, posts: FakePost[] = []): void {
    this.accounts.set(token, { platform, posts: new Map(posts.map((post) => [post.id, post])) });
  }

  /** Cria ou substitui o post (por exemplo, com números e `asOf` novos). */
  setPost(token: string, post: FakePost): void {
    this.account(token).posts.set(post.id, post);
  }

  /** As próximas chamadas deste token falham nesta ordem; depois volta ao normal. */
  failNext(token: string, ...faults: Fault[]): void {
    this.faults.set(token, [...(this.faults.get(token) ?? []), ...faults]);
  }

  readonly transport: Transport = (request, signal) => {
    const fault = this.faults.get(request.token)?.shift();
    const log = (result: string) =>
      this.calls.push({ at: this.clock.now().toISOString(), token: request.token, cursor: request.cursor, result });

    if (fault?.type === "timeout") {
      log("timeout");
      return new Promise<HttpResponse>((_, reject) => {
        signal.addEventListener("abort", () => reject(new Error("cancelada")), { once: true });
      });
    }
    if (fault?.type === "status") {
      log(`status ${fault.status}`);
      const headers = this.headers(fault.retryAfter === undefined ? {} : { "retry-after": fault.retryAfter });
      return Promise.resolve({ status: fault.status, headers, body: { error: "falha simulada" } });
    }
    if (fault?.type === "repeat_last_response" && this.lastBody.has(request.token)) {
      log("200 repetida");
      return Promise.resolve({ status: 200, headers: this.headers(), body: structuredClone(this.lastBody.get(request.token)) });
    }

    const account = this.accounts.get(request.token);
    if (!account || account.platform !== request.platform) {
      log("401");
      return Promise.resolve({ status: 401, headers: this.headers(), body: { error: "token inválido" } });
    }
    const inWindow = [...account.posts.values()]
      .filter((post) => post.publishedAt >= request.from && post.publishedAt <= request.to)
      .sort((left, right) => left.publishedAt.localeCompare(right.publishedAt) || left.id.localeCompare(right.id));
    const offset = request.cursor === null ? 0 : Number(request.cursor);
    let page = inWindow.slice(offset, offset + this.pageSize);
    if (fault?.type === "duplicate_items") page = page.flatMap((post) => [post, post]);
    const next = offset + this.pageSize < inWindow.length ? String(offset + this.pageSize) : null;
    const body = render(account.platform, page, next);
    this.lastBody.set(request.token, body);
    log(fault?.type === "duplicate_items" ? "200 com itens repetidos" : fault?.type === "dated" ? "200 com Date antigo" : "200");
    const date = fault?.type === "dated" ? new Date(fault.date) : this.clock.now();
    return Promise.resolve({ status: 200, headers: this.headers({}, date), body: structuredClone(body) });
  };

  private account(token: string): Account {
    const account = this.accounts.get(token);
    if (!account) throw new Error(`conta falsa ${token} não existe`);
    return account;
  }
}

/** Cada rede com os próprios nomes de campo e formato de paginação. */
function render(platform: Platform, posts: FakePost[], next: string | null): unknown {
  switch (platform) {
    case "instagram":
      return {
        data: posts.map((post) => ({
          id: post.id,
          timestamp: post.publishedAt,
          play_count: post.views,
          like_count: post.likes,
          comments_count: post.comments,
          insights_as_of: post.asOf,
        })),
        paging: next === null ? { cursors: {} } : { cursors: { after: next }, next: `https://graph.example/media?after=${next}` },
      };
    case "tiktok":
      return {
        data: {
          videos: posts.map((post) => ({
            id: post.id,
            create_time: Date.parse(post.publishedAt) / 1000,
            view_count: post.views,
            like_count: post.likes,
            comment_count: post.comments,
            share_count: post.shares,
            stats_as_of: post.asOf === undefined ? undefined : Date.parse(post.asOf) / 1000,
          })),
          cursor: next === null ? 0 : Number(next),
          has_more: next !== null,
        },
      };
    case "youtube":
      return {
        items: posts.map((post) => ({
          id: post.id,
          snippet: { publishedAt: post.publishedAt },
          statistics: {
            viewCount: post.views === undefined ? undefined : String(post.views),
            likeCount: post.likes === undefined ? undefined : String(post.likes),
            commentCount: post.comments === undefined ? undefined : String(post.comments),
          },
          statisticsAsOf: post.asOf,
        })),
        ...(next === null ? {} : { nextPageToken: next }),
      };
    case "x":
      return {
        data: posts.map((post) => ({
          id: post.id,
          created_at: post.publishedAt,
          public_metrics: {
            impression_count: post.views,
            like_count: post.likes,
            reply_count: post.comments,
            retweet_count: post.shares,
          },
        })),
        meta: next === null ? {} : { next_token: next },
      };
  }
}
