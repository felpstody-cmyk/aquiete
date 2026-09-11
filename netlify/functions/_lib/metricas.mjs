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

/* ---------------- Carrinho abandonado ---------------- */

/** Guarda quem começou a digitar no checkout. E-mail como chave: escrever de novo só atualiza. */
export async function salvarCarrinho(email, dados) {
  try {
    const store = await loja('carrinhos')
    // Mescla em vez de sobrescrever: se já mandamos o e-mail de recuperação,
    // continuar digitando não pode apagar essa marca.
    const atual = await store.get(email, { type: 'json' }).catch(() => null)
    await store.setJSON(email, Object.assign({}, atual, dados))
    // Só conta como "carrinho novo" na primeira vez que esse e-mail aparece —
    // os próximos toques (continuar digitando, blur de outro campo) não
    // podem inflar a métrica do dia.
    if (!atual) await contar(`carrinho:${diaBR()}`)
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
      const etapa = d.etapa || 0
      if (etapa >= ETAPAS_CARRINHO.length) return
      const horasDesde = (agora - d.em) / 3_600_000
      if (horasDesde < ETAPAS_CARRINHO[etapa].horasDesde) return
      if (horasDesde > 7 * 24) return
      saida.push({ email: b.key, nome: d.nome, kit: d.kit, etapa })
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

/** Quem digitou os dados e sumiu sem finalizar — pra chamar de volta. */
export async function lerCarrinhosAbandonados() {
  const agora = Date.now()
  const saida = []
  try {
    const store = await loja('carrinhos')
    const { blobs } = await store.list()
    await Promise.all(blobs.map(async (b) => {
      const d = await store.get(b.key, { type: 'json' }).catch(() => null)
      if (!d) return
      const minutos = (agora - d.em) / 60_000
      // pessoa ainda digitando não conta como abandonada; lixo de mais
      // de uma semana é limpo em vez de acumular pra sempre
      if (minutos > 7 * 24 * 60) { store.delete(b.key).catch(() => {}); return }
      if (minutos >= 10) saida.push(Object.assign({ email: b.key }, d))
    }))
  } catch { /* sem dados é melhor que erro 500 */ }
  return saida
}
