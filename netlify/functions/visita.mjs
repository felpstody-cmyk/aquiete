/**
 * GET /api/visita        — conta uma visita
 * GET /api/visita?t=checkout — conta quem chegou no checkout
 *
 * Responde 204 sem corpo. É chamado pelo próprio site.
 */

import { contar } from './_lib/metricas.mjs'

export default async (req) => {
  const dia = new Date().toISOString().slice(0, 10)
  const tipo = new URL(req.url).searchParams.get('t') === 'checkout' ? 'checkout' : 'visita'
  await contar(`${tipo}:${dia}`)
  return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } })
}

export const config = { path: '/api/visita' }
