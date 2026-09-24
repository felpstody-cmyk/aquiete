/**
 * Comportamento de navegação por sessão: até onde rolou a página, quanto
 * tempo ficou e em quais botões (data-cta) clicou. Mesma sessão (sid) do
 * "ativo agora" — sem cookie, sem dado pessoal.
 */

import { diaBR } from './metricas.mjs'

let getStore = null

async function loja() {
  if (!getStore) ({ getStore } = await import('@netlify/blobs'))
  return getStore('jornada')
}

/**
 * A chave leva o dia na frente: "2026-09-24/abc123".
 *
 * Sem isso a leitura precisava buscar TODAS as sessões guardadas, uma por
 * uma, pra depois jogar fora as velhas — e desde que a sessão passou a
 * nascer na carga da página (em vez de só quando a aba sumia) isso virou
 * milhares de buscas por sincronização e a função estourava o tempo
 * (504 em 24/09/2026). Com o dia na chave dá pra pedir só os últimos.
 *
 * Sessão que atravessa a meia-noite vira duas — acontece pouco e é bem
 * mais barato que o problema que isso resolve.
 */
function chaveDe(sid, quando) { return `${diaBR(quando)}/${sid}` }

/** Quantos dias a leitura varre. O painel filtra por período em cima
 *  disso, e ninguém olha comportamento de mais de uma semana atrás. */
const DIAS_LIDOS = 8
/** Teto duro de sessões lidas por chamada, pra função nunca mais estourar
 *  o tempo por volume — mesmo num dia fora da curva. */
const TETO_SESSOES = 1500

/** Atualiza o registro da sessão numa página (scroll máximo, segundos e/ou
 *  cliques). `geo`, quando vem, fica gravado uma vez no topo da sessão —
 *  não muda de página pra página. */
export async function registrarEvento(sid, pagina, dados, geo) {
  try {
    const store = await loja()
    const chave = chaveDe(sid)
    const atual = (await store.get(chave, { type: 'json' }).catch(() => null)) || { paginas: {} }
    const pag = atual.paginas[pagina] || {}
    // `primeiro` nunca é reescrito: é com ele que o painel ordena as páginas
    // na ordem real da visita. A ordem das chaves do objeto é a ordem em que
    // os avisos CHEGARAM, e eles chegam por sendBeacon quando a aba some —
    // dois avisos quase juntos podem chegar trocados e inverter a história.
    atual.paginas[pagina] = Object.assign({}, pag, dados, {
      atualizado: Date.now(),
      primeiro: pag.primeiro || Date.now(),
    })
    if (geo?.cidade && geo?.uf) { atual.cidade = geo.cidade; atual.uf = geo.uf; atual.pais = geo.pais || '' }
    // De onde a sessão veio, gravado uma vez. Sessão que só tem checkout e
    // não tem origem nenhuma é link colado ou robô — é o que separa uma
    // coisa da outra sem ficar no achismo.
    if (!atual.ref && dados.ref) atual.ref = dados.ref
    if (!atual.camp && dados.camp) atual.camp = dados.camp
    delete atual.paginas[pagina].ref
    delete atual.paginas[pagina].camp
    await store.setJSON(chave, atual)
  } catch { /* nunca derruba a página */ }
}

/** Apaga o registro de uma sessão — usado quando é teste do próprio dono. */
export async function apagarSessao(sid) {
  try {
    const store = await loja()
    await store.delete(sid)
  } catch { /* nunca derruba a página */ }
}

/**
 * Devolve o resumo agregado por página (scroll médio e tempo médio) e a
 * lista de sessões individuais, mais recente primeiro, pra ver pessoa por
 * pessoa até onde foi e o que clicou. Aproveita a leitura pra limpar
 * sessões com mais de 30 dias (sem isso acumula pra sempre).
 */
export async function lerComportamento() {
  const somas = {}
  const sessoes = []
  try {
    const store = await loja()
    const agora = Date.now()

    // Só os últimos dias, pedidos por prefixo. Antes era store.list() sem
    // filtro: buscava tudo que existia pra depois descartar o velho.
    const dias = []
    for (let i = 0; i < DIAS_LIDOS; i++) {
      dias.push(diaBR(new Date(agora - i * 24 * 3600 * 1000)))
    }
    const listas = await Promise.all(
      dias.map((d) => store.list({ prefix: `${d}/` }).catch(() => ({ blobs: [] })))
    )
    // Transição: o que foi gravado antes da chave com data não tem barra
    // no nome. Entra em quantidade limitada pra não repetir o estouro, e
    // some sozinho conforme envelhece.
    let legado = []
    try {
      const todas = await store.list()
      legado = (todas.blobs || []).filter((b) => !b.key.includes('/')).slice(0, 300)
    } catch { /* sem o histórico velho é melhor que 504 */ }

    const blobs = listas.flatMap((l) => l.blobs || []).concat(legado).slice(0, TETO_SESSOES)

    await Promise.all(blobs.map(async (b) => {
      const r = await store.get(b.key, { type: 'json' }).catch(() => null)
      if (!r || !r.paginas) return

      const atualizados = Object.values(r.paginas).map((d) => d.atualizado || 0)
      const maisRecente = atualizados.length ? Math.max(...atualizados) : 0

      Object.entries(r.paginas).forEach(([pagina, d]) => {
        if (!somas[pagina]) somas[pagina] = { somaScroll: 0, somaSegundos: 0, amostras: 0 }
        somas[pagina].somaScroll += Number(d.scrollMax) || 0
        somas[pagina].somaSegundos += Number(d.segundos) || 0
        somas[pagina].amostras += 1
      })

      sessoes.push({
        sid: b.key, cidade: r.cidade || '', uf: r.uf || '', pais: r.pais || '',
        paginas: r.paginas, ultimaAtividade: maisRecente,
        ref: r.ref || '', camp: r.camp || '',
      })
    }))
  } catch { /* sem dado é melhor que erro 500 */ }

  const porPagina = {}
  Object.entries(somas).forEach(([pagina, s]) => {
    porPagina[pagina] = {
      mediaScroll: s.amostras ? Math.round(s.somaScroll / s.amostras) : 0,
      mediaSegundos: s.amostras ? Math.round(s.somaSegundos / s.amostras) : 0,
      amostras: s.amostras,
    }
  })
  // Faxina: um dia velho por chamada. Como a leitura só olha os últimos
  // dias, sem isto o que passa da janela ficaria guardado pra sempre.
  try {
    const velho = diaBR(new Date(Date.now() - 31 * 24 * 3600 * 1000))
    const store = await loja()
    const { blobs } = await store.list({ prefix: `${velho}/` })
    await Promise.all((blobs || []).slice(0, 300).map((b) => store.delete(b.key).catch(() => {})))
  } catch { /* faxina que falha não pode derrubar a leitura */ }

  sessoes.sort((a, b) => b.ultimaAtividade - a.ultimaAtividade)
  return { porPagina, sessoes: sessoes.slice(0, 200) }
}
