# Diário de decisões: Desafio 04 (Métricas das redes do criador)

Registro cronológico do raciocínio. Cada entrada separa quem fez o quê:

- 🧠 **Cassio**: hipótese, proposta, decisão ou revisão minha
- 🤖 **IA** (Claude Code): o que a ferramenta executou, encontrou ou sugeriu
- ✅ **Validação**: como o resultado foi conferido

---

## 1. Enunciado

- 🤖 **IA**: abriu o desafio na plataforma. É um repositório novo (sem base).

**Requisitos:** serviço que recebe uma conexão já autorizada (token fictício, sem OAuth real) e sincroniza métricas de posts do Instagram, TikTok, YouTube e X. Ele precisa sobreviver a timeout, resposta duplicada e limite de taxa. Duas sincronizações com janelas sobrepostas não podem contar o mesmo post duas vezes. Num 429 com `Retry-After`, o serviço espera esse prazo, e o número de tentativas tem teto.

**Entrega:** API com provedor simulado, README e testes do sync; explicação da idempotência (mesmo post de novo, janelas sobrepostas); comportamento no 429 com teste que usa `Retry-After` e relógio controlado; declaração de uso de IA.

**Avaliação:** mesmo snapshot não duplica número; falha transitória com retry limitado; 429 espera o prazo do provedor sem passar do teto configurado; dá para saber quando a métrica foi buscada; fronteira legível entre o provedor falso e a regra de negócio.

- 🤖 **IA**: levantou 7 decisões em aberto: o que guardar, as chaves de idempotência, `Retry-After` acima do teto, quais falhas são transitórias, falha no meio da paginação, modo de execução e concorrência, e o tratamento das 4 redes.

## 2. Desenho

### 🧠 Decisões do Cassio

> **O ponto de partida**
> As redes não me dizem “ganhou mais 200 views”. Elas dizem “o post tem 10.400 views agora”. Então decidi que o sistema nunca soma números que vêm de buscas diferentes. Cada post tem um único valor atual, que vai sendo substituído por versões mais novas. O total da campanha é a soma desses valores atuais, um por post. Se eu seguir essa regra, buscar o mesmo post duas vezes não tem como contar em dobro.
>
> **1. O que eu guardo**
> Guardo duas coisas. A primeira é o histórico: toda vez que busco a métrica de um post, registro o que a rede disse, o momento que a rede informou para aquele número e o momento em que eu busquei. Isso me permite saber depois quando cada número foi buscado e reconstruir o que aconteceu. A segunda é o valor atual de cada post, que é o que o ranking usa.
> Quando chega um número menor que o anterior, vale o número com a data mais recente informada pela rede. Pensei nas outras opções. Se valesse sempre o último que busquei, uma resposta atrasada poderia apagar um dado mais novo. Se valesse sempre o maior, eu esconderia quedas reais: se a rede removeu views falsas, a marca continuaria vendo o número inflado. Então, se o número caiu e a data é mais nova, aceito a queda e deixo registrado que ela aconteceu. Se a data é mais antiga, o número vai para o histórico, mas não muda o valor atual.
> Fica uma ressalva: nem toda rede real informa essa data. Quando não informar, uso o momento em que busquei, sabendo que perco parte dessa proteção.
>
> **2. Como reconheço “o mesmo post” e “o mesmo dado”**
> Um post é identificado pela rede mais o código do post naquela rede. Não uso a conexão como parte da identidade porque, se o criador desconectar e conectar de novo, a conexão muda, mas o post é o mesmo, e eu não quero que ele apareça duas vezes no ranking.
> Um mesmo dado é identificado pelo post mais a data informada pela rede. Se esse par já existe, a segunda chegada é ignorada. Se a rede mandar a mesma data com números diferentes, considero um erro dela: mantenho o primeiro e registro o conflito.
> Com isso, janelas sobrepostas ficam resolvidas. Se uma busca cobre os dias 1 a 7 e outra os dias 5 a 12, os posts dos dias 5 a 7 aparecem nas duas. Mas eles caem no mesmo registro: ou o dado é igual e nada muda, ou é mais novo e substitui o anterior. Nunca soma.
>
> **3. Quando a rede manda esperar mais do que meu limite**
> Se a rede diz “espere 120 segundos” e meu limite é 60, eu paro a sincronização e registro a partir de quando posso tentar de novo. Esperar só 60 seria desrespeitar a rede e provavelmente tomar outro bloqueio. Se alguém pedir um novo sync antes do prazo, o sistema responde que ainda não pode e informa quanto falta.
> Tenho dois limites configuráveis: o tempo máximo que aceito esperar de uma vez e o número máximo de tentativas.
>
> **4. O que vale tentar de novo**
> Tento de novo quando a falha parece passageira: a rede demorou demais para responder, deu erro do lado dela ou pediu para eu esperar. Não tento de novo quando o problema não vai se resolver sozinho. Se o acesso foi revogado, marco a conexão como “precisa reconectar” e paro. Se o pedido foi recusado por estar errado, também paro, porque insistir não muda nada.
> Entre uma tentativa e outra, espero um tempo que vai aumentando (meio segundo, depois um, depois dois...) até um máximo, com uma pequena variação para não bater sempre no mesmo instante. Isso acontece por no máximo 4 tentativas. Nunca fica em loop infinito.
>
> **5. Se der erro no meio**
> Se os posts vêm em 5 páginas e a página 3 falha de vez, as páginas 1 e 2 ficam salvas. Cada post salvo está correto e tem sua data. Jogar isso fora seria desperdiçar dados bons, e com os limites de uso das redes um sync longo talvez nunca terminasse inteiro. A sincronização fica marcada como “parcial”. Rodar de novo do começo é seguro, porque o que já foi salvo não duplica.
>
> **6. Como a sincronização roda**
> Para este desafio, ela roda na própria chamada: peço a sincronização e recebo o resultado. É mais simples de testar e de demonstrar. Sei que, com esperas e novas tentativas, a resposta pode demorar. Se fosse para produção, eu mandaria isso para uma fila. Deixei a lógica separada da API justamente para essa troca ser fácil.
> Se pedirem duas sincronizações da mesma conexão ao mesmo tempo, a segunda é recusada e o sistema informa qual já está rodando. Se uma sincronização travar e ficar “rodando” por tempo demais, considero abandonada para não bloquear a conexão para sempre. Mesmo sem esse bloqueio, nada duplicaria, porque as regras dos itens 1 e 2 já garantem isso. O bloqueio existe para não gastar à toa o limite de uso da rede.
>
> **7. As quatro redes**
> Existe uma forma única de o sistema conversar com qualquer rede. Por trás dela, cada rede tem um tradutor próprio: o Instagram chama curtidas de um jeito, o TikTok de outro, o YouTube de outro, e o tradutor converte tudo para os mesmos nomes (visualizações, curtidas, comentários, compartilhamentos). Quando uma rede não fornece alguma métrica, guardo “não informado”, não zero.
> O provedor falso imita as quatro redes, cada uma com seus próprios nomes de campo. Nos testes, consigo mandar ele simular problemas: demorar demais, devolver a mesma página duas vezes, pedir para esperar 30 segundos. A regra de negócio nunca vê os detalhes de cada rede. Ela só recebe métricas já traduzidas e avisos claros do tipo “acesso revogado”, “espere X segundos” ou “falha passageira”.
>
> **Como provo que funciona**
> Nos testes, o relógio é controlado. Quando a rede manda esperar 30 segundos, o teste avança o relógio 30 segundos em vez de esperar de verdade. Assim consigo verificar que:
> - a mesma página recebida duas vezes não muda o total;
> - janelas sobrepostas contam cada post uma vez só;
> - uma resposta antiga não apaga uma mais nova;
> - uma queda real é aceita e registrada;
> - um pedido de espera de 30 segundos é respeitado;
> - um pedido de espera acima do limite faz o sync parar e anotar quando pode voltar;
> - as tentativas param no limite;
> - o acesso revogado para na hora;
> - uma falha no meio preserva o que já foi salvo;
> - duas sincronizações simultâneas não rodam juntas.

### 🤖 Análise da IA
- **A regra central fecha a dupla contagem pela raiz:** total = soma dos valores atuais, um por post, e o valor atual só é substituído. Janela sobreposta e página duplicada viram, no máximo, uma escrita a mais no histórico, nunca um número a mais no total.
- **Pontos que o desenho não fecha** (a IA vai implementar com o padrão indicado; o Cassio confirma depois):
  1. **Teto de tentativas por chamada (página) ou por sync?** Padrão: **por chamada**, 4 no total. Um sync de 50 páginas pode fazer até 200 chamadas, mas cada página para no teto.
  2. **Um 429 que foi esperado conta como tentativa?** Padrão: **sim**. Senão, um provedor que mandasse esperar 10 s para sempre manteria o sync vivo para sempre.
  3. **429 sem `Retry-After`:** padrão: tratar como falha passageira, com o mesmo backoff exponencial. `Retry-After` em segundos e em data HTTP são aceitos.
  4. **Timeout:** o próprio serviço impõe um limite por chamada (configurável) e cancela a chamada pendente. Não depende de o provedor desistir.
  5. **Post colaborativo** (o mesmo post aparece em duas contas, como no Collab do Instagram): com a identidade rede + código, ele conta uma vez, atribuído ao primeiro criador que o trouxe. Fica documentado como limitação.
  6. **Rede sem data própria** (no provedor falso, o X): o snapshot usa a hora da busca. Página repetida gera um registro a mais no histórico, mas o valor atual e o total não mudam.
  7. **Sync abandonado:** um sync "rodando" sem sinal de vida por mais de 10 minutos (configurável) é marcado `abandoned` na próxima tentativa. O bloqueio é garantido pelo banco (índice único parcial sobre syncs em andamento), não por um `if` no código.
- **Relógio controlado:** o serviço espera através de uma interface de relógio (`now`, `sleep`). Nos testes, os timers do Vitest são falsos e o teste avança o tempo, conferindo que nada é chamado antes de passarem os 30 s.
- 🤖 **IA**: criou a pasta `~/orca/conty-metricas-redes` (git, autoria configurada, stack dos desafios anteriores). Nada foi publicado.

## 3. Implementação

- 🤖 **IA**: implementou na pasta `~/orca/conty-metricas-redes`, seguindo o desenho do Cassio e os padrões da seção 2 para os pontos em aberto:
  - **Fronteira:** `providers/fake-network.ts` (4 formatos de resposta, falhas programáveis) → `providers/adapter.ts` (status HTTP e `Retry-After` viram falhas tipadas) e `providers/translators.ts` (campos de cada rede → `views/likes/comments/shares`, ausente = `null`) → `providers/types.ts`, o único contrato que a regra de negócio conhece.
  - **Regra de negócio:** `sync/retry-policy.ts` (decisão pura: tentar, esperar quanto, pausar ou parar), `sync/metrics-store.ts` (valor atual + histórico, página numa transação), `sync/sync-service.ts` (paginação, timeout próprio, bloqueio, tentativas registradas em `sync_attempts`).
- **Ajuste encontrado ao gerar os exemplos:** `POST /connections` devolvia o `access_token`. A IA corrigiu e adicionou um teste garantindo que o token nunca volta.
- **Ressalva encontrada ao escrever o README:** nas APIs reais, contadores acumulados em geral não vêm com a data a que se referem. O provedor falso simula essa data em 3 das 4 redes para exercitar a regra, mas na prática o caso sem data (hora da busca) seria o comum. Ficou registrado no README; o tratamento está na seção de confirmações do Cassio.

### ✅ Validação
- `npm test`: **37 de 37**, com relógio controlado (timers falsos do Vitest). Typecheck limpo.
- Testes de mutação: 9 erros introduzidos de propósito, cada um derrubou ao menos um teste (somar em vez de substituir: 3; esperar metade do `Retry-After`: 3; clamp no teto em vez de parar: 3; sem teto de tentativas: 4; revogado como passageiro: 2; último buscado vence: 1; esconder queda: 1; sem timeout próprio: 1; conexão na identidade do post: 1).
- Servidor HTTP real com SQLite em arquivo: as 4 redes de demonstração sincronizadas (6 posts, total de 123.800 views, conferido à mão).

## 4. Confirmações e cabeçalho Date

- 🧠 **Cassio**: confirmou os padrões da seção 2 (teto por chamada, 429 contando como tentativa, 429 sem `Retry-After` com backoff, timeout próprio, bloqueio por índice único, post colaborativo atribuído ao primeiro criador). Decidiu implementar o cabeçalho `Date` da resposta como data do dado quando a rede não informa a data da métrica, e publicar.
- 🤖 **IA**: implementou a ordem `provider` → `response_date` → `fetched_at`. O adaptador lê o `Date` e entrega `respondedAt` na página; o tradutor continua olhando só o corpo. Como o `Date` tem resolução de 1 s, duas respostas no mesmo segundo com números diferentes caem na regra de conflito (fica a primeira). O provedor falso passou a mandar `Date` como um servidor real, com opção de omitir e uma falha `dated` que simula réplica ou cache atrasado.

### ✅ Validação
- `npm test`: **42 de 42**. Typecheck limpo.
- Testes novos: X usa o `Date` (com o segundo truncado); resposta com `Date` mais antigo não apaga a mais nova; sem `Date`, cai para a hora da busca; mesmo segundo com números diferentes vira conflito.
- Mutação: ignorar o `Date` na regra derrubou 3 testes; o adaptador não ler o `Date` derrubou 4.
- Exemplos de `docs/EXEMPLOS.md` regenerados com o código final.

## 5. Publicação

- 🤖 **IA**: criou `cassiomiller10-hash/conty-metricas-redes` (público) e enviou a `main`.
