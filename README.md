# Métricas das redes do criador

Serviço que recebe uma conexão já autorizada com Instagram, TikTok, YouTube ou X (token fictício, sem OAuth) e sincroniza as métricas dos posts. Ele sobrevive a timeout, resposta duplicada e limite de taxa sem contar nada duas vezes.

## Como rodar

Node 22.

```bash
npm install
npm test
npm run dev   # http://127.0.0.1:3004, banco em data/metricas.sqlite
```

No `npm run dev`, o provedor falso já tem uma conta em cada rede (tokens `demo-instagram`, `demo-tiktok`, `demo-youtube`, `demo-x`, posts de maio de 2026). As falhas da rede são simuladas nos testes. Exemplos completos de request e response: [`docs/EXEMPLOS.md`](docs/EXEMPLOS.md).

## Onde fica a fronteira

```
 provedor falso              fronteira com as redes                regra de negócio
┌───────────────┐   HTTP    ┌──────────────────────────┐  tipos   ┌─────────────────────────────┐
│ fake-network  │ ───────►  │ adapter.ts               │ ───────► │ sync-service.ts (paginação, │
│ (4 formatos,  │ status,   │  status → falha tipada   │ Provider │   bloqueio, tentativas)     │
│  falhas       │ headers,  │  Retry-After → ms        │ Page /   │ retry-policy.ts (pura)      │
│  programadas) │ corpo     │ translators.ts           │ Provider │ metrics-store.ts (valor     │
└───────────────┘           │  campos de cada rede     │ Error    │   atual + histórico)        │
                            │  → views/likes/…         │          └─────────────────────────────┘
                            └──────────────────────────┘
```

O sync só conhece [`src/providers/types.ts`](src/providers/types.ts): métricas já traduzidas (`views`, `likes`, `comments`, `shares`) e falhas já classificadas (`timeout`, `server_error`, `rate_limited`, `revoked`, `rejected`). Trocar o provedor falso por `fetch` muda só o `Transport`.

## Idempotência: por que nada conta duas vezes

As redes informam **totais** ("o post tem 10.400 views"), não incrementos. Então o serviço **nunca soma números de buscas diferentes**:

- **Um valor atual por post.** O post é identificado por **rede + id na rede**. A conexão não entra na identidade, então reconectar a conta não duplica posts. O total do criador é a soma dos valores atuais, um por post.
- **O valor atual só é substituído, nunca acumulado**, e só por um dado com **data informada pela rede** mais recente.
- **Histórico de snapshots.** Cada busca grava o que a rede disse, a que instante o número se refere (`reported_at`) e quando buscamos (`fetched_at`). O dado é identificado por **post + `reported_at`** (índice único).

O que acontece quando o mesmo post chega de novo:

| Chegada | Resultado |
|---|---|
| Mesmo post, mesma data, mesmos números (página repetida, janela sobreposta) | Ignorada (`duplicates_ignored`) |
| Data mais nova | Substitui o valor atual. Se algum número caiu, aceita e marca `decreased` |
| Data mais antiga (resposta atrasada) | Vai para o histórico como `stale` e não mexe no valor atual |
| Mesma data, números diferentes | Erro da rede: fica o primeiro e o conflito vai para `metric_conflicts` |

**Janelas sobrepostas.** Um sync de 1 a 7/5 seguido de outro de 5 a 12/5 traz os dias 5 a 7 duas vezes. Eles caem no mesmo post e no mesmo dado: na segunda vez são ignorados ou, se a rede tiver número mais novo, substituem o anterior. Nunca somam.

**Quando a rede não diz a data do número.** No provedor falso, Instagram, TikTok e YouTube trazem um campo com o instante a que as métricas se referem, e o X não traz. Nas APIs reais, contadores acumulados (views, curtidas) **em geral não vêm com essa data**, então esse é o caso comum. A data do dado é escolhida nesta ordem:

1. **Data da métrica informada pela rede** (`reported_at_source: "provider"`).
2. **Cabeçalho `Date` da resposta** (`"response_date"`): o relógio do servidor da rede ao responder. Uma resposta servida por uma réplica ou um cache atrasado traz um `Date` mais antigo e não apaga um dado mais novo. O `Date` tem resolução de 1 s: duas respostas no mesmo segundo com números diferentes viram conflito (fica a primeira).
3. **Hora da busca** (`"fetched_at"`), quando nem o cabeçalho vem. O total continua sem duplicar, mas perde-se a proteção contra resposta atrasada.

## Falhas, 429 e limites

| A rede respondeu | O serviço faz |
|---|---|
| Não respondeu em 10 s | Cancela a chamada (timeout próprio) e tenta de novo com backoff |
| 5xx ou falha de conexão | Tenta de novo com backoff: 0,5 s → 1 s → 2 s → … até 8 s, com até +20% de variação |
| 429 com `Retry-After` ≤ 60 s | Espera **exatamente** o prazo pedido e tenta de novo |
| 429 com `Retry-After` > 60 s | **Não espera.** Encerra o sync, grava `retry_not_before` na conexão e recusa novos syncs até lá (`429` com `Retry-After`) |
| 429 sem `Retry-After` | Trata como falha passageira (backoff) |
| 401/403 | Para na hora e marca a conexão `needs_reconnect` |
| Outro 4xx ou resposta fora do formato | Para na hora (`rejected`) |

- **Teto de tentativas:** 4 por chamada, contando a primeira. Um 429 esperado também conta, então uma rede que pede "espere 5 s" para sempre não mantém o sync vivo.
- Os limites ficam em [`src/sync/retry-policy.ts`](src/sync/retry-policy.ts) (`DEFAULT_RETRY`) e podem ser trocados por `createApp`. A decisão "tentar de novo, esperar quanto, ou parar" é uma função pura.
- **Falha no meio:** cada página é gravada numa transação. Se a página 3 de 5 falhar de vez, as páginas 1 e 2 ficam salvas e o sync termina `partial`. Rodar de novo do começo é seguro.
- **Concorrência:** um sync por conexão, garantido por índice único parcial no banco. O segundo pedido recebe `409` com o id do que está rodando. Um sync sem sinal de vida há mais de 10 minutos vira `abandoned`.
- Cada tentativa fica em `sync_attempts` (página, tentativa, horário, resultado e quanto esperou) e aparece em `GET /syncs/:id`.

## Quando a métrica foi buscada

- `posts.current_reported_at`: a que instante o valor atual se refere, segundo a rede.
- `posts.current_fetched_at`: quando buscamos esse valor.
- `posts.last_checked_at`: última vez que perguntamos à rede sobre o post, mesmo que nada tenha mudado.
- Em cada snapshot: `reported_at`, `reported_at_source` (`provider`, `response_date` ou `fetched_at`) e `fetched_at`.

## Endpoints

| Endpoint | O que faz |
|---|---|
| `POST /connections` `{ creator_id, platform, access_token }` | Registra a conexão. O token nunca volta na resposta |
| `GET /connections/:id` | Estado da conexão (`active` / `needs_reconnect`, `retry_not_before`) |
| `POST /connections/:id/syncs` `{ from, to }` | Roda o sync na própria chamada e devolve o resultado |
| `GET /syncs/:id` | Status, motivo da parada, estatísticas e tentativas |
| `GET /creators/:id/posts` | Valor atual de cada post e totais (`sum` + quantos posts não informam a métrica) |
| `GET /posts/:id/snapshots` | Histórico e conflitos do post |

Métrica que a rede não informa (por exemplo, compartilhamentos no Instagram e no YouTube) é `null`, nunca zero.

## Testes

`npm test` roda 42 testes. O relógio é controlado pelos timers falsos do Vitest, e nada espera de verdade:

- **429 com `Retry-After: 30`:** o teste avança 29,999 s e confere que não houve nova chamada; avança mais 1 ms e confere a segunda chamada exatamente em +30 s ([`test/rate-limit.test.ts`](test/rate-limit.test.ts)). Também cobre `Retry-After` em data HTTP, espera acima do teto, recusa de sync antes do prazo e o 429 contando como tentativa.
- **Idempotência:** página repetida, item repetido, janelas sobrepostas, número mais novo substituindo, resposta antiga sem efeito, queda aceita e registrada, conflito, reconexão e o X sem data da métrica (cabeçalho `Date`, réplica atrasada, sem cabeçalho, mesmo segundo) ([`test/idempotency.test.ts`](test/idempotency.test.ts)).
- **Retry:** timeout cancelado em 10 s, backoff 0,5/1/2 s, exatamente 4 chamadas no teto, revogado e recusado parando na hora, e a política como função pura ([`test/retry.test.ts`](test/retry.test.ts)).
- **Falha no meio, sync simultâneo, sync abandonado** e o bloqueio garantido pelo banco ([`test/partial-and-concurrency.test.ts`](test/partial-and-concurrency.test.ts)).
- **Tradutores** das 4 redes e validações da API.

Para conferir que os testes pegam erros de verdade, foram introduzidos erros de propósito. Cada um derrubou pelo menos um teste: somar em vez de substituir, o último buscado vencer, esconder queda, esperar metade do `Retry-After`, esperar só até o teto em vez de parar, remover o teto de tentativas, tratar revogado como passageiro, não ter timeout próprio, colocar a conexão na identidade do post e ignorar o cabeçalho `Date`.

## O que ficou de fora, e o que eu faria diferente com mais tempo

- **Fila em vez de sync na requisição.** Com esperas de até 60 s e várias tentativas, a resposta pode demorar. Em produção, `runSync` iria para um worker (a lógica já está separada da API) e o cliente acompanharia por `GET /syncs/:id`.
- **OAuth real, renovação de token e autenticação da própria API:** fora do escopo. O token fica em texto no banco.
- **Post colaborativo** (o mesmo post em duas contas, como no Collab do Instagram) conta uma vez e fica atribuído ao primeiro criador que o trouxe. O certo é modelar a autoria compartilhada.
- **Orçamento de chamadas por rede.** O teto é por chamada; um sync com muitas páginas pode fazer muitas chamadas. Um limitador por conta, que respeite a cota da rede antes de levar o 429, evitaria isso.
- **Campanhas e ranking:** o serviço entrega o valor atual por post e o total por criador. O ranking da campanha seria uma soma desses valores atuais.
- **Sync incremental:** hoje cada sync relê a janela inteira. Com cursor salvo, uma retomada continuaria de onde parou.

## Uso de IA

Ferramenta: Claude Code (Claude Opus 5.5).

- **Decisões minhas:** nunca somar números de buscas diferentes (um valor atual por post, substituído); guardar valor atual e histórico; vencer a data informada pela rede, aceitando e registrando quedas; identidade do post sem a conexão e do dado por post + data; conflito mantém o primeiro; usar o cabeçalho `Date` da resposta quando a rede não informa a data da métrica; parar quando o `Retry-After` passa do teto e recusar novo sync até o prazo; o que é passageiro e o que não é; backoff com variação e 4 tentativas; salvar páginas já recebidas e marcar parcial; sync na requisição com bloqueio por conexão e expiração; um tradutor por rede, com "não informado" em vez de zero; a lista do que os testes precisam provar.
- **Feito pela IA:** as respostas para os pontos que o desenho não fechava, confirmadas por mim (teto por chamada, 429 contando como tentativa, 429 sem `Retry-After`, timeout próprio, bloqueio por índice único no banco); a observação de que as APIs reais em geral não informam a data da métrica e a sugestão do cabeçalho `Date`; toda a implementação; o provedor falso com os formatos de cada rede; os testes com relógio controlado; os testes de mutação; os exemplos gerados executando a API; o rascunho deste README. Ao gerar os exemplos, a IA percebeu que `POST /connections` devolvia o token e corrigiu, com teste.
- **O que revisei:** a revisão foi feita ao longo do processo, junto com a ferramenta. Cada decisão foi discutida comigo antes de virar código, e acompanhei os testes, os erros introduzidos de propósito e as validações.

O raciocínio passo a passo, separando o que foi meu e o que foi da IA, está em [`DECISOES.md`](DECISOES.md).
