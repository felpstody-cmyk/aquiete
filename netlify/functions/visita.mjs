/**
 * GET /api/visita        — conta uma visita
 * GET /api/visita?t=checkout — conta quem chegou no checkout
 *
 * Responde 204 sem corpo. É chamado pelo próprio site.
 */

import { contar, marcar, diaBR } from './_lib/metricas.mjs'
import { geoDe } from './_lib/geo.mjs'
import { origemDe } from './_lib/origem.mjs'

export default async (req) => {
  const url = new URL(req.url)
  const dia = diaBR()
  const tipo = url.searchParams.get('t') === 'checkout' ? 'checkout' : 'visita'
  await contar(`${tipo}:${dia}`)

  // So registra cidade/origem na visita da pagina inicial — contar de novo
  // no checkout inflaria a mesma pessoa duas vezes na lista. O dia entra na
  // chave pra essas listas poderem ser filtradas pelo mesmo seletor de
  // período (hoje/ontem/7 dias/mês) usado no resto do sistema.
  if (tipo === 'visita') {
    const geo = geoDe(req)
    if (geo?.cidade && geo?.uf) {
      const chaveCidade = `${geo.cidade}|${geo.uf}|${geo.pais || '??'}`
      await contar(`cidade:${dia}:${chaveCidade}`)
      // Guarda também QUANDO foi a última visita dessa cidade, pra ordenar
      // "quem apareceu agora" no topo do painel, em vez de só por volume.
      await marcar(`ultimaCidade:${dia}:${chaveCidade}`)
    }
    const origem = origemDe(url)
    if (origem) await contar(`origem:${dia}:${origem}`)
  }

  return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } })
}

export const config = { path: '/api/visita' }
