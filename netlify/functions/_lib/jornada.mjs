/**
 * Comportamento de navegação por sessão: até onde rolou a página, quanto
 * tempo ficou e em quais botões (data-cta) clicou. Mesma sessão (sid) do
 * "ativo agora" — sem cookie, sem dado pessoal.
 */

let getStore = null

async function loja() {
  if (!getStore) ({ getStore } = await import('@netlify/blobs'))
  return getStore('jornada')
}

/** Atualiza o registro da sessão numa página (scroll máximo, segundos e/ou
 *  cliques). `geo`, quando vem, fica gravado uma vez no topo da sessão —
 *  não muda de página pra página. */
export async function registrarEvento(sid, pagina, dados, geo) {
  try {
    const store = await loja()
    const atual = (await store.get(sid, { type: 'json' }).catch(() => null)) || { paginas: {} }
    const pag = atual.paginas[pagina] || {}
    atual.paginas[pagina] = Object.assign({}, pag, dados, { atualizado: Date.now() })
    if (geo?.cidade && geo?.uf) { atual.cidade = geo.cidade; atual.uf = geo.uf }
    await store.setJSON(sid, atual)
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
    const { blobs } = await store.list()
    const agora = Date.now()
    await Promise.all(blobs.map(async (b) => {
      const r = await store.get(b.key, { type: 'json' }).catch(() => null)
      if (!r || !r.paginas) return

      const atualizados = Object.values(r.paginas).map((d) => d.atualizado || 0)
      const maisRecente = atualizados.length ? Math.max(...atualizados) : 0
      if (agora - maisRecente > 30 * 24 * 3600 * 1000) {
        store.delete(b.key).catch(() => {})
        return
      }

      Object.entries(r.paginas).forEach(([pagina, d]) => {
        if (!somas[pagina]) somas[pagina] = { somaScroll: 0, somaSegundos: 0, amostras: 0 }
        somas[pagina].somaScroll += Number(d.scrollMax) || 0
        somas[pagina].somaSegundos += Number(d.segundos) || 0
        somas[pagina].amostras += 1
      })

      sessoes.push({
        cidade: r.cidade || '', uf: r.uf || '',
        paginas: r.paginas, ultimaAtividade: maisRecente,
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
  sessoes.sort((a, b) => b.ultimaAtividade - a.ultimaAtividade)
  return { porPagina, sessoes: sessoes.slice(0, 200) }
}
