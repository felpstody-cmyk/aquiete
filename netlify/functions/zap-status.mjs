/**
 * POST /api/zap-status — a WAME avisa o que aconteceu com cada mensagem
 * que a loja mandou.
 *
 * Por que existe: a resposta do envio diz {"code":"SENDING"}, que é "a
 * API aceitou", não "chegou no celular". O log mostrava "enviado" para
 * mensagem que nunca foi entregue, e quando alguém dizia "não recebi"
 * não havia como saber quem estava certo.
 *
 * O formato é o da Meta (webhookFormat: "meta" na conta), então o aviso
 * chega em entry[].changes[].value.statuses[], cada um com o id da
 * mensagem e o estado.
 *
 * Responde 200 sempre: webhook que devolve erro faz o provedor parar de
 * mandar aviso, e aí a gente perde o dado de vez.
 */

import { marcarEntrega } from './_lib/zaplog.mjs'

const ok = (dados = { ok: true }) =>
  new Response(JSON.stringify(dados), {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  })

/** Os nomes que a Meta usa, no vocabulário do painel. */
const TRADUZ = {
  sent: 'enviada',
  delivered: 'entregue',
  read: 'lida',
  failed: 'falhou',
  deleted: 'apagada',
}

/** Acha os status em qualquer profundidade: o formato varia por provedor. */
function acharStatus(corpo) {
  const achados = []
  const visitar = (no, nivel = 0) => {
    if (!no || typeof no !== 'object' || nivel > 6) return
    if (Array.isArray(no)) { no.forEach((x) => visitar(x, nivel + 1)); return }
    if (Array.isArray(no.statuses)) achados.push(...no.statuses)
    // Alguns provedores mandam um status solto, sem a lista da Meta.
    if (no.id && no.status && !Array.isArray(no.statuses)) achados.push(no)
    Object.values(no).forEach((x) => visitar(x, nivel + 1))
  }
  visitar(corpo)
  return achados
}

export default async (req) => {
  if (req.method !== 'POST') return ok({ ok: true, nota: 'use POST' })

  const corpo = await req.json().catch(() => null)
  if (!corpo) return ok({ ok: true, nota: 'corpo vazio' })

  const statuses = acharStatus(corpo)
  if (!statuses.length) return ok({ ok: true, achados: 0 })

  let atualizadas = 0
  for (const s of statuses.slice(0, 40)) {
    const situacao = TRADUZ[String(s.status || '').toLowerCase()]
    if (!situacao) continue
    const motivo = s.errors?.[0]?.title || s.errors?.[0]?.message || ''
    if (await marcarEntrega(String(s.id || ''), situacao, motivo)) atualizadas++
  }

  return ok({ ok: true, achados: statuses.length, atualizadas })
}

export const config = { path: '/api/zap-status' }
