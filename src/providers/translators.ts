import type { Platform, PostMetrics, ProviderPage, ProviderPost } from "./types.ts";

// Um tradutor por rede: converte o corpo de resposta de cada uma para o formato único.
// Cada rede nomeia as métricas de um jeito, e nem toda rede informa todas.

type Json = Record<string, unknown>;

class MalformedResponse extends Error {}

function object(value: unknown, where: string): Json {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new MalformedResponse(`${where}: objeto esperado`);
  return value as Json;
}

function list(value: unknown, where: string): unknown[] {
  if (!Array.isArray(value)) throw new MalformedResponse(`${where}: lista esperada`);
  return value;
}

function text(value: unknown, where: string): string {
  if (typeof value !== "string" || !value) throw new MalformedResponse(`${where}: texto esperado`);
  return value;
}

/** Ausente → null. Aceita número ou texto numérico (o YouTube manda contagens como texto). */
function count(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  const parsed = typeof value === "string" ? Number(value) : value;
  if (typeof parsed !== "number" || !Number.isSafeInteger(parsed) || parsed < 0) {
    throw new MalformedResponse(`contagem inválida: ${String(value)}`);
  }
  return parsed;
}

function isoInstant(value: unknown, where: string): string {
  const date = typeof value === "number" ? new Date(value * 1000) : new Date(text(value, where));
  if (Number.isNaN(date.getTime())) throw new MalformedResponse(`${where}: data inválida`);
  return date.toISOString();
}

function post(externalId: unknown, publishedAt: unknown, reportedAt: unknown, metrics: PostMetrics): ProviderPost {
  return {
    externalId: text(externalId, "id"),
    publishedAt: isoInstant(publishedAt, "publicação"),
    reportedAt: reportedAt === undefined || reportedAt === null ? null : isoInstant(reportedAt, "data da métrica"),
    metrics,
  };
}

// O tradutor só olha o corpo; o cabeçalho Date é do adaptador.
type TranslatedPage = Omit<ProviderPage, "respondedAt">;

const translators: Record<Platform, (body: unknown) => TranslatedPage> = {
  // { data: [{ id, timestamp, play_count, like_count, comments_count, insights_as_of }], paging: { cursors: { after }, next } }
  instagram(body) {
    const root = object(body, "instagram");
    const paging = root.paging === undefined ? {} : object(root.paging, "paging");
    const cursors = paging.cursors === undefined ? {} : object(paging.cursors, "cursors");
    return {
      posts: list(root.data, "data").map((raw) => {
        const item = object(raw, "media");
        return post(item.id, item.timestamp, item.insights_as_of, {
          views: count(item.play_count),
          likes: count(item.like_count),
          comments: count(item.comments_count),
          shares: null,
        });
      }),
      nextCursor: paging.next ? text(cursors.after, "after") : null,
    };
  },

  // { data: { videos: [{ id, create_time, view_count, like_count, comment_count, share_count, stats_as_of }], cursor, has_more } }
  tiktok(body) {
    const data = object(object(body, "tiktok").data, "data");
    return {
      posts: list(data.videos, "videos").map((raw) => {
        const item = object(raw, "video");
        return post(item.id, item.create_time, item.stats_as_of, {
          views: count(item.view_count),
          likes: count(item.like_count),
          comments: count(item.comment_count),
          shares: count(item.share_count),
        });
      }),
      nextCursor: data.has_more ? String(data.cursor) : null,
    };
  },

  // { items: [{ id, snippet: { publishedAt }, statistics: { viewCount, likeCount, commentCount }, statisticsAsOf }], nextPageToken }
  youtube(body) {
    const root = object(body, "youtube");
    return {
      posts: list(root.items, "items").map((raw) => {
        const item = object(raw, "video");
        const statistics = object(item.statistics, "statistics");
        return post(item.id, object(item.snippet, "snippet").publishedAt, item.statisticsAsOf, {
          views: count(statistics.viewCount),
          likes: count(statistics.likeCount),
          comments: count(statistics.commentCount),
          shares: null,
        });
      }),
      nextCursor: typeof root.nextPageToken === "string" ? root.nextPageToken : null,
    };
  },

  // { data: [{ id, created_at, public_metrics: { impression_count, like_count, reply_count, retweet_count } }], meta: { next_token } }
  // O X não informa a que instante os números se referem: reportedAt fica null.
  x(body) {
    const root = object(body, "x");
    const meta = root.meta === undefined ? {} : object(root.meta, "meta");
    return {
      posts: list(root.data, "data").map((raw) => {
        const item = object(raw, "tweet");
        const metrics = object(item.public_metrics, "public_metrics");
        return post(item.id, item.created_at, null, {
          views: count(metrics.impression_count),
          likes: count(metrics.like_count),
          comments: count(metrics.reply_count),
          shares: count(metrics.retweet_count),
        });
      }),
      nextCursor: typeof meta.next_token === "string" ? meta.next_token : null,
    };
  },
};

export function translatePage(platform: Platform, body: unknown): TranslatedPage {
  return translators[platform](body);
}

export { MalformedResponse };
