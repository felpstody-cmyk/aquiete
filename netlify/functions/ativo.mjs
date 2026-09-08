/**
 * GET /api/ativo?sid=...   — "sinal de vida" de quem está no site agora.
 *
 * Não conta como visita (isso é o /api/visita); só marca presença por
 * uns 90s pra aparecer no painel "pessoas ativas agora" do sistema.
 */

import { marcarAtivo } from './_lib/metricas.mjs'
import { geoDe } from './_lib/geo.mjs'

export default async (req) => {
  const url = new URL(req.url)
  const sid = url.searchParams.get('sid') || ''
  if (sid) {
    try { await marcarAtivo(sid, geoDe(req)) } catch { /* nunca derruba a pagina */ }
  }
  return new Response(null, {
    status: 204,
    headers: { 'Access-Control-Allow-Origin': '*' },
  })
}

export const config = { path: '/api/ativo' }
