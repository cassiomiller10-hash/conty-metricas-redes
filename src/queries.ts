import type { DatabaseSync } from "node:sqlite";

// Leituras da API. O total soma o valor ATUAL de cada post (um número por post),
// nunca os snapshots.

export function getConnection(db: DatabaseSync, id: string) {
  const row = db
    .prepare("SELECT id, creator_id, platform, status, retry_not_before, created_at FROM connections WHERE id = ?")
    .get(id);
  return row ?? null;
}

export function getSyncRun(db: DatabaseSync, id: string) {
  const run = db.prepare("SELECT * FROM sync_runs WHERE id = ?").get(id) as
    | (Record<string, unknown> & { stats_json: string })
    | undefined;
  if (!run) return null;
  const { stats_json, ...rest } = run;
  const attempts = db
    .prepare("SELECT page, attempt, started_at, outcome, wait_ms FROM sync_attempts WHERE sync_run_id = ? ORDER BY seq")
    .all(id);
  return { ...rest, stats: JSON.parse(stats_json) as Record<string, number>, attempts };
}

type PostView = {
  id: string;
  platform: string;
  external_id: string;
  published_at: string;
  views: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  current_reported_at: string | null;
  current_fetched_at: string | null;
  last_checked_at: string | null;
};

export function listCreatorPosts(db: DatabaseSync, creatorId: string) {
  const posts = db
    .prepare(
      `SELECT id, platform, external_id, published_at, views, likes, comments, shares,
              current_reported_at, current_fetched_at, last_checked_at
       FROM posts WHERE creator_id = ? ORDER BY published_at, platform, external_id`,
    )
    .all(creatorId) as PostView[];
  const metrics = ["views", "likes", "comments", "shares"] as const;
  const totals = Object.fromEntries(
    metrics.map((metric) => [
      metric,
      {
        sum: posts.reduce((total, post) => total + (post[metric] ?? 0), 0),
        posts_not_reported: posts.filter((post) => post[metric] === null).length,
      },
    ]),
  );
  return { creator_id: creatorId, post_count: posts.length, totals, posts };
}

export function getPostHistory(db: DatabaseSync, postId: string) {
  const post = db.prepare("SELECT * FROM posts WHERE id = ?").get(postId);
  if (!post) return null;
  const snapshots = db
    .prepare(
      `SELECT id, sync_run_id, reported_at, reported_at_source, fetched_at, views, likes, comments, shares, outcome, decreased
       FROM metric_snapshots WHERE post_id = ? ORDER BY reported_at`,
    )
    .all(postId)
    .map((row) => ({ ...row, decreased: row.decreased === 1 }));
  const conflicts = db
    .prepare("SELECT sync_run_id, reported_at, kept_snapshot_id, received_json, detected_at FROM metric_conflicts WHERE post_id = ? ORDER BY id")
    .all(postId)
    .map(({ received_json, ...row }) => ({ ...row, received: JSON.parse(String(received_json)) as unknown }));
  return { post, snapshots, conflicts };
}
