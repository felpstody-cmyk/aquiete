/**
 * POST /api/evento
 *
 * Recebe eventos de comportamento (scroll máximo, tempo na página, em
 * quais botões clicou) por sessão. Chamado via navigator.sendBeacon
 * quando a pessoa sai ou troca de aba — sem cookie, só o sid aleatório
 * que o navegador já gera pro "ativo agora" (visita.mjs / ativo.mjs).
 */

import { registrarEvento } from './_lib/jornada.mjs'
import { geoDe } from './_lib/geo.mjs'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

export default async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS })
  if (req.method !== 'POST') return new Response(null, { status: 405, headers: CORS })

  let corpo
  try { corpo = await req.json() } catch { return new Response(null, { status: 204, headers: CORS }) }

  const sid = String(corpo?.sid ?? '').trim()
  const pagina = String(corpo?.pagina ?? '').trim()

  if (sid && pagina) {
    const dados = {}
    if (corpo.scrollMax != null) dados.scrollMax = Math.max(0, Math.min(100, Number(corpo.scrollMax) || 0))
    if (corpo.segundos != null) dados.segundos = Math.max(0, Number(corpo.segundos) || 0)
    if (Array.isArray(corpo.cliques)) {
      dados.cliques = corpo.cliques.map((c) => String(c).slice(0, 30)).slice(0, 20)
    }
    try { await registrarEvento(sid, pagina, dados, geoDe(req)) } catch { /* nunca derruba a página */ }
  }

  return new Response(null, { status: 204, headers: CORS })
}

export const config = { path: '/api/evento' }
