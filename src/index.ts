import { serve } from "@hono/node-server";
import { createApp } from "./app.ts";
import { systemClock } from "./clock.ts";
import { openDatabase } from "./db.ts";
import { FakeNetwork } from "./providers/fake-network.ts";

// Servidor de demonstração: o provedor falso já tem uma conta em cada rede.
const network = new FakeNetwork(systemClock, 2);
const asOf = "2026-06-01T12:00:00.000Z";
network.addAccount("demo-instagram", "instagram", [
  { id: "ig_1", publishedAt: "2026-05-20T10:00:00.000Z", asOf, views: 10_400, likes: 820, comments: 41 },
  { id: "ig_2", publishedAt: "2026-05-24T18:30:00.000Z", asOf, views: 5_120, likes: 300, comments: 12 },
  { id: "ig_3", publishedAt: "2026-05-28T09:15:00.000Z", asOf, views: 980, likes: 75, comments: 3 },
]);
network.addAccount("demo-tiktok", "tiktok", [
  { id: "tt_1", publishedAt: "2026-05-22T21:00:00.000Z", asOf, views: 88_000, likes: 9_100, comments: 230, shares: 410 },
]);
network.addAccount("demo-youtube", "youtube", [
  { id: "yt_1", publishedAt: "2026-05-18T14:00:00.000Z", asOf, views: 15_300, likes: 1_200, comments: 95 },
]);
network.addAccount("demo-x", "x", [
  { id: "x_1", publishedAt: "2026-05-26T12:00:00.000Z", views: 4_000, likes: 150, comments: 20, shares: 33 },
]);

const db = openDatabase(process.env.DB_PATH ?? "data/metricas.sqlite");
const port = Number(process.env.PORT ?? 3004);

serve({ fetch: createApp(db, network.transport).fetch, port }, (info) => {
  console.log(`métricas em http://127.0.0.1:${info.port}`);
  console.log("tokens de demonstração: demo-instagram, demo-tiktok, demo-youtube, demo-x");
});
