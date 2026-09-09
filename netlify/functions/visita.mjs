/**
 * GET /api/visita        — conta uma visita
 * GET /api/visita?t=checkout — conta quem chegou no checkout
 *
 * Responde 204 sem corpo. É chamado pelo próprio site.
 */

import { contar } from './_lib/metricas.mjs'
import { geoDe } from './_lib/geo.mjs'
import { origemDe } from './_lib/origem.mjs'

export default async (req) => {
  const url = new URL(req.url)
  const dia = new Date().toISOString().slice(0, 10)
  const tipo = url.searchParams.get('t') === 'checkout' ? 'checkout' : 'visita'
  await contar(`${tipo}:${dia}`)

  // So registra cidade/origem na visita da pagina inicial — contar de novo
  // no checkout inflaria a mesma pessoa duas vezes na lista. O dia entra na
  // chave pra essas listas poderem ser filtradas pelo mesmo seletor de
  // período (hoje/ontem/7 dias/mês) usado no resto do sistema.
  if (tipo === 'visita') {
    const geo = geoDe(req)
    if (geo?.cidade && geo?.uf) {
      await contar(`cidade:${dia}:${geo.cidade}|${geo.uf}|${geo.pais || '??'}`)
    }
    const origem = origemDe(url)
    if (origem) await contar(`origem:${dia}:${origem}`)
  }

  return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } })
}

export const config = { path: '/api/visita' }
