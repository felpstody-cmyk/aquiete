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
    // Até onde foi dentro do checkout. Isto NÃO depende de e-mail, que é
    // o que o carrinho exige — quem abre o checkout, olha e sai sem
    // digitar nada era invisível, e é justamente quem precisa aparecer.
    if (corpo.etapa != null) dados.etapa = Math.max(0, Math.min(3, Number(corpo.etapa) || 0))
    // Gesto humano de verdade (dedo, tecla, roda). Robô que rola por código
    // dispara scroll, mas não dispara nenhum destes.
    if (corpo.humano != null) dados.humano = !!corpo.humano
    if (corpo.tocou != null) dados.tocou = !!corpo.tocou
    if (corpo.digitou != null) dados.digitou = !!corpo.digitou
    // Só o NOME do campo que barrou e o motivo, nunca o que foi digitado.
    if (Array.isArray(corpo.travou)) {
      dados.travou = corpo.travou.map((t) => String(t).slice(0, 40)).slice(0, 12)
    }
    // Nomes dos campos já preenchidos — nunca o que foi digitado neles.
    // É o que mostra até onde a pessoa foi mesmo sem virar carrinho.
    if (Array.isArray(corpo.campos)) {
      dados.campos = corpo.campos.map((c) => String(c).slice(0, 20)).slice(0, 20)
    }
    // De onde veio: só o domínio de origem e o nome da campanha, nunca a
    // URL inteira (que pode carregar dado de quem clicou).
    if (corpo.ref != null) dados.ref = String(corpo.ref).slice(0, 60)
    if (corpo.camp != null) dados.camp = String(corpo.camp).slice(0, 60)
    try { await registrarEvento(sid, pagina, dados, geoDe(req)) } catch { /* nunca derruba a página */ }
  }

  return new Response(null, { status: 204, headers: CORS })
}

export const config = { path: '/api/evento' }
