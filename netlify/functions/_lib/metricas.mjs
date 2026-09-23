/**
 * Contadores do site (visitas, checkouts), guardados no Netlify Blobs.
 *
 * Regra de ouro deste arquivo: métrica NUNCA pode derrubar a loja.
 * Toda falha é engolida de propósito — se o Blobs estiver fora, a página
 * continua carregando e o pedido continua sendo criado.
 */

let getStore = null

async function loja(nome = 'metricas') {
  if (!getStore) ({ getStore } = await import('@netlify/blobs'))
  return getStore(nome)
}

/**
 * Data de "hoje" no fuso de Brasília, formato AAAA-MM-DD.
 *
 * De propósito NÃO usa `new Date().toISOString().slice(0,10)`: isso vira
 * o dia à meia-noite UTC, que é 21h em Brasília — três horas de visita
 * de noite (21h-meia-noite) já contavam pro dia seguinte. Toda chave
 * "tipo:dia" do sistema (visita, checkout, cidade, origem, carrinho)
 * precisa vir daqui pra virar o dia junto com o relógio de Brasília.
 */
export function diaBR(quando) {
  const partes = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(quando || new Date())
  const p = {}
  partes.forEach((x) => { p[x.type] = x.value })
  return `${p.year}-${p.month}-${p.day}`
}

/** Soma 1 na chave do dia. Ex.: "visita:2026-09-06". */
export async function contar(chave) {
  try {
    const store = await loja()
    const atual = Number(await store.get(chave)) || 0
    await store.set(chave, String(atual + 1))
  } catch { /* silêncio proposital */ }
}

/**
 * Grava o horário atual na chave, sem somar — diferente de `contar()`.
 * Usado pra saber a ÚLTIMA vez que algo aconteceu (ex.: última visita de
 * uma cidade), pra poder ordenar "quem apareceu agora" primeiro no painel,
 * já que o contador sozinho só diz quantidade, não quando foi a mais recente.
 */
export async function marcar(chave) {
  try {
    const store = await loja()
    await store.set(chave, String(Date.now()))
  } catch { /* silêncio proposital */ }
}

/** Devolve { "visita:2026-09-06": 12, "checkout:2026-09-06": 3, ... } */
export async function lerContadores() {
  const saida = {}
  try {
    const store = await loja()
    const { blobs } = await store.list()
    await Promise.all(
      blobs.map(async (b) => {
        saida[b.key] = Number(await store.get(b.key)) || 0
      })
    )
  } catch { /* sem métricas é melhor que erro 500 */ }
  return saida
}

/* ---------------- Presença ao vivo ---------------- */

/** Marca "ainda no site" — pinga a cada ~25s enquanto a aba está aberta. */
export async function marcarAtivo(sid, geo) {
  try {
    const store = await loja('ativos')
    await store.setJSON(sid, { em: Date.now(), cidade: geo?.cidade || '', uf: geo?.uf || '', pais: geo?.pais || '' })
  } catch { /* silêncio proposital */ }
}

/** Quem bateu presença nos últimos 90s. Aproveita a leitura pra limpar quem já saiu. */
export async function lerAtivos() {
  const agora = Date.now()
  const saida = []
  try {
    const store = await loja('ativos')
    const { blobs } = await store.list()
    await Promise.all(blobs.map(async (b) => {
      const d = await store.get(b.key, { type: 'json' }).catch(() => null)
      if (!d) return
      if (agora - d.em <= 90_000) saida.push({ cidade: d.cidade, uf: d.uf, pais: d.pais || '', em: d.em })
      else store.delete(b.key).catch(() => {})
    }))
  } catch { /* sem dados é melhor que erro 500 */ }
  return saida
}

/* ---------------- Conversao paga do Google ---------------- */

/**
 * O caminho de uma venda ate o Google:
 *   1. a pessoa chega pelo anuncio com ?gclid=... e o site guarda isso
 *   2. ela fecha o pedido e o gclid vem junto -> guardamos por referencia
 *   3. o Asaas confirma o pagamento -> a venda entra na fila de conversao
 *
 * Isso existe porque a conversao do navegador dispara quando o Pix e
 * GERADO. Quem gera e nao paga contaria como venda, e o Google aprenderia
 * a procurar gerador de Pix em vez de comprador.
 */
export async function guardarCliqueDoPedido(referencia, clique) {
  try {
    const id = String(clique?.id ?? '').trim()
    if (!referencia || !id) return
    const store = await loja('cliques')
    await store.setJSON(referencia, { id, em: Number(clique.em) || Date.now() })
  } catch { /* silêncio proposital */ }
}

/** Chamado quando o pagamento e confirmado. Sem clique guardado, nao faz nada. */
export async function registrarVendaPaga({ referencia, valor, quando }) {
  try {
    if (!referencia) return
    const cliques = await loja('cliques')
    const clique = await cliques.get(referencia, { type: 'json' }).catch(() => null)
    if (!clique?.id) return
    const store = await loja('conversoes-google')
    await store.setJSON(referencia, {
      gclid: clique.id,
      valor: Number(valor) || 0,
      quando: quando || Date.now(),
      enviada: false,
    })
  } catch { /* silêncio proposital */ }
}

/** Vendas pagas que vieram de anuncio, pro painel montar o arquivo do Google. */
export async function lerConversoesGoogle() {
  const saida = []
  try {
    const store = await loja('conversoes-google')
    const { blobs } = await store.list()
    await Promise.all(blobs.map(async (b) => {
      const d = await store.get(b.key, { type: 'json' }).catch(() => null)
      if (d) saida.push(Object.assign({ referencia: b.key }, d))
    }))
  } catch { /* sem dados é melhor que erro 500 */ }
  return saida.sort((a, b) => (b.quando || 0) - (a.quando || 0))
}

/* ---------------- Carrinho abandonado ---------------- */

/** Guarda quem começou a digitar no checkout. E-mail como chave: escrever de novo só atualiza. */
export async function salvarCarrinho(email, dados) {
  try {
    const store = await loja('carrinhos')
    // Mescla em vez de sobrescrever: se já mandamos o e-mail de recuperação,
    // continuar digitando não pode apagar essa marca.
    let atual = await store.get(email, { type: 'json' }).catch(() => null)
    // Quem já pagou e voltou pra comprar de novo começa um carrinho novo —
    // senão a marca de "pago" da compra anterior esconderia este.
    if (atual?.pago && !dados.pedido && !dados.pago) atual = null
    const novo = Object.assign({}, atual, dados)
    // "criado" é a primeira vez que o e-mail apareceu; "em" é o último toque.
    if (!atual) novo.criado = dados.em || Date.now()
    await store.setJSON(email, novo)
    // Só conta como "carrinho novo" na primeira vez que esse e-mail aparece —
    // os próximos toques (continuar digitando, blur de outro campo) não
    // podem inflar a métrica do dia.
    if (!atual) await contar(`carrinho:${diaBR()}`)
  } catch { /* silêncio proposital */ }
}

/**
 * Quanto tempo esperar o pagamento antes de o pedido virar "abandonado".
 * Antes o carrinho era apagado assim que o Pix saía, e quem gerava o Pix e
 * não pagava sumia do sistema — tinha que ser cadastrado na mão. Agora o
 * carrinho fica guardado com o pedido e só sai quando o pagamento cai.
 * Boleto demora pra compensar, então espera bem mais antes de acusar.
 */
export const PRAZO_PAGAMENTO_MIN = { pix: 90, card: 90, boleto: 72 * 60 }

function prazoDe(metodo) {
  return PRAZO_PAGAMENTO_MIN[metodo] ?? PRAZO_PAGAMENTO_MIN.pix
}

/** Pedido gerado mas ainda dentro do prazo de pagar: não é abandono (ainda). */
function aguardandoPagamento(d, agora) {
  return !!(d.pedido && !d.pago && (agora - d.pedido.em) / 60_000 < prazoDe(d.pedido.metodo))
}

/**
 * Situação de um carrinho, na ordem em que a pessoa avança:
 *   digitando  -> mexeu no checkout há menos de 10 min
 *   abandonado -> digitou e sumiu sem gerar pedido
 *   aguardando -> gerou Pix/boleto/cartão e ainda tá no prazo de pagar
 *   nao-pagou  -> gerou o pedido e o prazo passou sem pagamento
 *   pago       -> o Asaas confirmou
 */
export function situacaoCarrinho(d, agora = Date.now()) {
  if (d.pago) return 'pago'
  if (d.pedido) return aguardandoPagamento(d, agora) ? 'aguardando' : 'nao-pagou'
  return (agora - d.em) / 60_000 < 10 ? 'digitando' : 'abandonado'
}

/** Índice referência do pedido -> e-mail, pro webhook achar o carrinho mesmo sem o cliente. */
async function lojaRef() { return loja('carrinhos-ref') }

/**
 * Chamado quando o pedido sai (Pix, boleto ou cartão gerado). Cria o
 * carrinho se ele ainda não existia — quem digita rápido e já clica em
 * pagar pode chegar aqui antes do /api/carrinho salvar.
 */
export async function marcarCarrinhoComPedido(email, dados, pedido) {
  try {
    const chave = String(email ?? '').trim().toLowerCase()
    if (!chave) return
    const store = await loja('carrinhos')
    const atual = await store.get(chave, { type: 'json' }).catch(() => null)
    const extra = { pedido: Object.assign({ em: Date.now() }, pedido) }
    // Pix e boleto já têm o e-mail do próprio código (e o lembrete-pix de 3h).
    // Pular o toque de 2h da sequência evita a pessoa receber dois e-mails
    // quase juntos falando do mesmo pedido.
    if (pedido.metodo !== 'card') extra.etapa = Math.max(atual?.etapa || 0, 1)
    await salvarCarrinho(chave, Object.assign({}, dados, extra, { em: atual?.em || Date.now() }))
    if (pedido.referencia) (await lojaRef()).set(pedido.referencia, chave).catch(() => {})
  } catch { /* silêncio proposital */ }
}

/** Pagamento confirmado: o carrinho sai da lista de abandonados e das cobranças por e-mail. */
export async function marcarCarrinhoPago({ email, referencia }) {
  try {
    let chave = String(email ?? '').trim().toLowerCase()
    if (!chave && referencia) chave = String(await (await lojaRef()).get(referencia).catch(() => '') || '')
    if (!chave) return
    const store = await loja('carrinhos')
    const atual = await store.get(chave, { type: 'json' }).catch(() => null)
    if (!atual) return
    await store.setJSON(chave, Object.assign({}, atual, { pago: Date.now() }))
  } catch { /* silêncio proposital */ }
}

/**
 * Sequência de lembrete: vai espaçando e para sozinha — não fica mandando
 * pra sempre. 3 toques: 2h, 1 dia, 3 dias. Depois disso, silêncio.
 */
export const ETAPAS_CARRINHO = [
  { horasDesde: 2 },
  { horasDesde: 24 },
  { horasDesde: 72 },
]

/** Carrinhos na hora certa do próximo toque da sequência (e ainda não esgotaram os 3). */
export async function carrinhosPendentesDeEmail() {
  const agora = Date.now()
  const saida = []
  try {
    const store = await loja('carrinhos')
    const { blobs } = await store.list()
    await Promise.all(blobs.map(async (b) => {
      const d = await store.get(b.key, { type: 'json' }).catch(() => null)
      if (!d) return
      // Pagou, ou ainda tá no prazo de pagar o Pix/boleto: não cobra por e-mail.
      if (d.pago || aguardandoPagamento(d, agora)) return
      const etapa = d.etapa || 0
      if (etapa >= ETAPAS_CARRINHO.length) return
      const horasDesde = (agora - d.em) / 3_600_000
      if (horasDesde < ETAPAS_CARRINHO[etapa].horasDesde) return
      if (horasDesde > 7 * 24) return
      saida.push({ email: b.key, nome: d.nome, kit: d.kit, telefone: d.telefone || '', etapa })
    }))
  } catch { /* sem carrinho pra lembrar é melhor que erro 500 */ }
  return saida
}

/** Avança pro próximo toque da sequência (ou fecha, se era o último). */
export async function marcarEmailCarrinho(email, etapa) {
  try {
    const store = await loja('carrinhos')
    const atual = await store.get(email, { type: 'json' }).catch(() => null)
    if (!atual) return
    await store.setJSON(email, Object.assign({}, atual, { etapa: etapa + 1, ultimoEmail: Date.now() }))
  } catch { /* silêncio proposital */ }
}

/** Some da lista quando o pedido sai de verdade — não é mais "abandonado". */
export async function removerCarrinho(email) {
  try {
    const store = await loja('carrinhos')
    await store.delete(String(email ?? '').trim().toLowerCase())
  } catch { /* silêncio proposital */ }
}

/**
 * Todos os carrinhos da última semana, com a situação de cada um — o que
 * explica a diferença entre "carrinhos novos" e "abandonados" no painel
 * (quem ainda tá digitando, quem gerou Pix e tá no prazo, quem pagou).
 * Lixo de mais de uma semana é limpo em vez de acumular pra sempre.
 */
export async function lerTodosCarrinhos() {
  const agora = Date.now()
  const saida = []
  try {
    const store = await loja('carrinhos')
    const { blobs } = await store.list()
    await Promise.all(blobs.map(async (b) => {
      const d = await store.get(b.key, { type: 'json' }).catch(() => null)
      if (!d) return
      if ((agora - d.em) / 60_000 > 7 * 24 * 60) { store.delete(b.key).catch(() => {}); return }
      saida.push(Object.assign({ email: b.key, situacao: situacaoCarrinho(d, agora) }, d))
    }))
  } catch { /* sem dados é melhor que erro 500 */ }
  return saida
}

/**
 * Quem digitou os dados e sumiu sem finalizar — pra chamar de volta.
 * Inclui quem gerou Pix/boleto/cartão e não pagou no prazo (situacao
 * "nao-pagou"), que antes sumia do sistema porque o pedido apagava o carrinho.
 */
export async function lerCarrinhosAbandonados(todos) {
  const lista = todos || await lerTodosCarrinhos()
  return lista.filter((c) => c.situacao === 'abandonado' || c.situacao === 'nao-pagou')
}
