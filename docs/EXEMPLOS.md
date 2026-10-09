# Exemplos de request e response

Gerados executando a API com o relógio controlado dos testes (início em `2026-06-01T15:00:00Z`) e o provedor falso. Os ids mudam a cada execução. Alguns responses estão recortados nos campos relevantes ao passo; o 2 e o 3 estão inteiros.

Com `npm run dev`, o provedor falso já tem as contas `demo-instagram`, `demo-tiktok`, `demo-youtube` e `demo-x` (posts de maio de 2026), mas não simula falhas: elas são programadas nos testes.

### 1. Registrar a conexão (token fictício)
```bash
curl -s -X POST localhost:3004/connections \
  -H 'content-type: application/json' \
  -d '{"creator_id":"crt_ana","platform":"instagram","access_token":"demo-instagram"}'
```
`201`
```json
{
  "id": "con_c1c6d302d95b",
  "creator_id": "crt_ana",
  "platform": "instagram",
  "status": "active",
  "retry_not_before": null,
  "created_at": "2026-06-01T15:00:00.000Z"
}
```

### 2. Sincronizar (a rede respondeu 429 com Retry-After: 30 na primeira chamada)
```bash
curl -s -X POST localhost:3004/connections/con_c1c6d302d95b/syncs \
  -H 'content-type: application/json' \
  -d '{"from":"2026-05-01T00:00:00Z","to":"2026-05-31T23:59:59Z"}'
```
`201`
```json
{
  "id": "syn_bb02e6dcf0f8",
  "connection_id": "con_c1c6d302d95b",
  "window_from": "2026-05-01T00:00:00.000Z",
  "window_to": "2026-05-31T23:59:59.000Z",
  "status": "completed",
  "stop_reason": null,
  "started_at": "2026-06-01T15:00:00.000Z",
  "heartbeat_at": "2026-06-01T15:00:30.000Z",
  "finished_at": "2026-06-01T15:00:30.000Z",
  "pages_saved": 2,
  "error": null,
  "stats": {
    "posts_received": 3,
    "new_posts": 3,
    "applied": 3,
    "stale": 0,
    "duplicates_ignored": 0,
    "conflicts": 0,
    "decreases": 0
  },
  "attempts": [
    {
      "page": 1,
      "attempt": 1,
      "started_at": "2026-06-01T15:00:00.000Z",
      "outcome": "rate_limited",
      "wait_ms": 30000
    },
    {
      "page": 1,
      "attempt": 2,
      "started_at": "2026-06-01T15:00:30.000Z",
      "outcome": "ok",
      "wait_ms": null
    },
    {
      "page": 2,
      "attempt": 1,
      "started_at": "2026-06-01T15:00:30.000Z",
      "outcome": "ok",
      "wait_ms": null
    }
  ]
}
```

### 3. Posts do criador com valor atual e total
```bash
curl -s -X GET localhost:3004/creators/crt_ana/posts
```
`200`
```json
{
  "creator_id": "crt_ana",
  "post_count": 3,
  "totals": {
    "views": {
      "sum": 16500,
      "posts_not_reported": 0
    },
    "likes": {
      "sum": 1195,
      "posts_not_reported": 0
    },
    "comments": {
      "sum": 56,
      "posts_not_reported": 0
    },
    "shares": {
      "sum": 0,
      "posts_not_reported": 3
    }
  },
  "posts": [
    {
      "id": "pst_45b5f0b9b2bf",
      "platform": "instagram",
      "external_id": "ig_1",
      "published_at": "2026-05-20T10:00:00.000Z",
      "views": 10400,
      "likes": 820,
      "comments": 41,
      "shares": null,
      "current_reported_at": "2026-06-01T12:00:00.000Z",
      "current_fetched_at": "2026-06-01T15:00:30.000Z",
      "last_checked_at": "2026-06-01T15:00:30.000Z"
    },
    {
      "id": "pst_5212c95a9b94",
      "platform": "instagram",
      "external_id": "ig_2",
      "published_at": "2026-05-24T18:30:00.000Z",
      "views": 5120,
      "likes": 300,
      "comments": 12,
      "shares": null,
      "current_reported_at": "2026-06-01T12:00:00.000Z",
      "current_fetched_at": "2026-06-01T15:00:30.000Z",
      "last_checked_at": "2026-06-01T15:00:30.000Z"
    },
    {
      "id": "pst_1d2b799ee8c3",
      "platform": "instagram",
      "external_id": "ig_3",
      "published_at": "2026-05-28T09:15:00.000Z",
      "views": 980,
      "likes": 75,
      "comments": 3,
      "shares": null,
      "current_reported_at": "2026-06-01T12:00:00.000Z",
      "current_fetched_at": "2026-06-01T15:00:30.000Z",
      "last_checked_at": "2026-06-01T15:00:30.000Z"
    }
  ]
}
```

### 4. Nova janela sobreposta: nada duplica, e a queda de views do ig_1 é aceita e registrada
```bash
curl -s -X POST localhost:3004/connections/con_c1c6d302d95b/syncs \
  -H 'content-type: application/json' \
  -d '{"from":"2026-05-15T00:00:00Z","to":"2026-05-31T23:59:59Z"}'
```
`201`
```json
{
  "id": "syn_828cd2c135fb",
  "status": "completed",
  "pages_saved": 2,
  "stats": {
    "posts_received": 3,
    "new_posts": 0,
    "applied": 1,
    "stale": 0,
    "duplicates_ignored": 2,
    "conflicts": 0,
    "decreases": 1
  }
}
```

### 5. Histórico do post: o que a rede disse, a que instante se refere e quando buscamos
```bash
curl -s -X GET localhost:3004/posts/pst_45b5f0b9b2bf/snapshots
```
`200`
```json
{
  "snapshots": [
    {
      "id": "snp_e67f62eb878b",
      "sync_run_id": "syn_bb02e6dcf0f8",
      "reported_at": "2026-06-01T12:00:00.000Z",
      "reported_at_source": "provider",
      "fetched_at": "2026-06-01T15:00:30.000Z",
      "views": 10400,
      "likes": 820,
      "comments": 41,
      "shares": null,
      "outcome": "applied",
      "decreased": false
    },
    {
      "id": "snp_4d684cb73264",
      "sync_run_id": "syn_828cd2c135fb",
      "reported_at": "2026-06-01T14:00:00.000Z",
      "reported_at_source": "provider",
      "fetched_at": "2026-06-01T16:00:30.000Z",
      "views": 9800,
      "likes": 830,
      "comments": 42,
      "shares": null,
      "outcome": "applied",
      "decreased": true
    }
  ],
  "conflicts": []
}
```

### 6. A rede pede 120 s, acima do teto de 60 s: o sync para e anota quando pode voltar
```bash
curl -s -X POST localhost:3004/connections/con_c1c6d302d95b/syncs \
  -H 'content-type: application/json' \
  -d '{"from":"2026-05-01T00:00:00Z","to":"2026-05-31T23:59:59Z"}'
```
`201`
```json
{
  "id": "syn_b7281780f978",
  "status": "failed",
  "stop_reason": "rate_limited",
  "error": "a rede pediu 120 s, acima do teto de 60 s",
  "attempts": [
    {
      "page": 1,
      "attempt": 1,
      "started_at": "2026-06-01T17:00:30.000Z",
      "outcome": "rate_limited",
      "wait_ms": null
    }
  ]
}
```

### 7. Novo sync antes do prazo
```bash
curl -s -X POST localhost:3004/connections/con_c1c6d302d95b/syncs \
  -H 'content-type: application/json' \
  -d '{"from":"2026-05-01T00:00:00Z","to":"2026-05-31T23:59:59Z"}'
```
`429` com `Retry-After: 75`
```json
{
  "error": "aguardando_limite_da_rede",
  "message": "A rede pediu para esperar antes de um novo sync.",
  "retry_not_before": "2026-06-01T17:02:30.000Z",
  "retry_in_seconds": 75
}
```
