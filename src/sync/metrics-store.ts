import type { DatabaseSync } from "node:sqlite";
import { transaction } from "../db.ts";
import type { PostMetrics, ProviderPage } from "../providers/types.ts";

// Regra central: nada aqui soma números de buscas diferentes. Cada post tem UM valor atual,
// substituído só por um dado com data informada mais recente. O total é a soma dos atuais.

export type PageStats = {
  posts_received: number;
  new_posts: number;
  applied: number;
  stale: number;
  duplicates_ignored: number;
  conflicts: number;
  decreases: number;
};

export const emptyStats = (): PageStats => ({
  posts_received: 0,
  new_posts: 0,
  applied: 0,
  stale: 0,
  duplicates_ignored: 0,
  conflicts: 0,
  decreases: 0,
});

type PostRow = {
  id: string;
  views: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  current_reported_at: string | null;
};

type SnapshotRow = PostMetrics & { id: string };

const METRICS = ["views", "likes", "comments", "shares"] as const;

const sameMetrics = (left: PostMetrics, right: PostMetrics) => METRICS.every((key) => left[key] === right[key]);

/** Alguma métrica informada nos dois lados caiu. "Não informado" não conta como queda. */
const decreased = (previous: PostMetrics, next: PostMetrics) =>
  METRICS.some((key) => previous[key] !== null && next[key] !== null && (next[key] as number) < (previous[key] as number));

function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
}

/** Grava uma página inteira numa transação: ou a página toda entra, ou nada dela entra. */
export function savePage(
  db: DatabaseSync,
  context: { syncRunId: string; connectionId: string; creatorId: string; platform: string; fetchedAt: string },
  page: Pick<ProviderPage, "posts" | "respondedAt">,
): PageStats {
  const stats = emptyStats();
  transaction(db, () => {
    for (const incoming of page.posts) {
      stats.posts_received += 1;
      let post = db
        .prepare("SELECT * FROM posts WHERE platform = ? AND external_id = ?")
        .get(context.platform, incoming.externalId) as PostRow | undefined;
      if (!post) {
        const id = newId("pst");
        db.prepare(
          "INSERT INTO posts (id, platform, external_id, creator_id, first_connection_id, published_at) VALUES (?, ?, ?, ?, ?, ?)",
        ).run(id, context.platform, incoming.externalId, context.creatorId, context.connectionId, incoming.publishedAt);
        post = { id, views: null, likes: null, comments: null, shares: null, current_reported_at: null };
        stats.new_posts += 1;
      }
      db.prepare("UPDATE posts SET last_checked_at = ? WHERE id = ?").run(context.fetchedAt, post.id);

      // A que instante o dado se refere, do mais ao menos confiável: a data da métrica informada
      // pela rede; o relógio da rede ao responder (cabeçalho Date, resolução de 1 s); a hora da busca,
      // que já não protege contra resposta atrasada.
      const [reportedAt, reportedAtSource] = incoming.reportedAt
        ? [incoming.reportedAt, "provider"]
        : page.respondedAt
          ? [page.respondedAt, "response_date"]
          : [context.fetchedAt, "fetched_at"];
      const existing = db
        .prepare("SELECT id, views, likes, comments, shares FROM metric_snapshots WHERE post_id = ? AND reported_at = ?")
        .get(post.id, reportedAt) as SnapshotRow | undefined;
      if (existing) {
        if (sameMetrics(existing, incoming.metrics)) {
          stats.duplicates_ignored += 1;
        } else {
          db.prepare(
            "INSERT INTO metric_conflicts (post_id, sync_run_id, reported_at, kept_snapshot_id, received_json, detected_at) VALUES (?, ?, ?, ?, ?, ?)",
          ).run(post.id, context.syncRunId, reportedAt, existing.id, JSON.stringify(incoming.metrics), context.fetchedAt);
          stats.conflicts += 1;
        }
        continue;
      }

      const isNewer = post.current_reported_at === null || reportedAt > post.current_reported_at;
      const isDrop = isNewer && post.current_reported_at !== null && decreased(post, incoming.metrics);
      const snapshotId = newId("snp");
      const { views, likes, comments, shares } = incoming.metrics;
      db.prepare(
        "INSERT INTO metric_snapshots (id, post_id, sync_run_id, reported_at, reported_at_source, fetched_at, views, likes, comments, shares, outcome, decreased) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(
        snapshotId,
        post.id,
        context.syncRunId,
        reportedAt,
        reportedAtSource,
        context.fetchedAt,
        views,
        likes,
        comments,
        shares,
        isNewer ? "applied" : "stale",
        isDrop ? 1 : 0,
      );
      if (!isNewer) {
        // Dado mais antigo que o atual (resposta atrasada): fica no histórico, não muda o valor atual.
        stats.stale += 1;
        continue;
      }
      db.prepare(
        "UPDATE posts SET views = ?, likes = ?, comments = ?, shares = ?, current_snapshot_id = ?, current_reported_at = ?, current_fetched_at = ? WHERE id = ?",
      ).run(views, likes, comments, shares, snapshotId, reportedAt, context.fetchedAt, post.id);
      stats.applied += 1;
      if (isDrop) stats.decreases += 1;
    }
  });
  return stats;
}

export function addStats(total: PageStats, page: PageStats): PageStats {
  const sum = { ...total };
  for (const key of Object.keys(sum) as Array<keyof PageStats>) sum[key] += page[key];
  return sum;
}
