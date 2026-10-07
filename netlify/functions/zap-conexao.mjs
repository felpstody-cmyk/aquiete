/**
 * POST /api/zap-conexao
 *
 * Webhook da WAME pro evento `connection`. Ela chama isto no instante em
 * que a conexão do chip da loja muda de estado — é o que faz o conserto
 * ser imediato em vez de esperar a ronda de 10 minutos.
 *
 * Por que não tem token:
 *
 * O corpo da requisição é IGNORADO de propósito. Chegou qualquer coisa
 * aqui, a função vai perguntar pra própria WAME como a conexão está e age
 * pelo que a WAME responder. Então uma chamada forjada não consegue
 * desligar nada, religar nada nem mentir que caiu: no máximo gasta uma
 * consulta. E tem trava de 30 segundos pra nem isso virar enxurrada.
 *
 * Trocar isso por um segredo na URL só funcionaria se o segredo estivesse
 * configurado dos dois lados, e um segredo esquecido dá falsa sensação de
 * proteção. Aqui a segurança vem de a função não confiar no que recebe.
 */

import { vigiar } from './_lib/zapvigia.mjs'
import { podeNotificar } from './_lib/notificar.mjs'

const json = (dados, status = 200) =>
  new Response(JSON.stringify(dados), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  })

export default async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204 })
  if (req.method !== 'POST') return json({ erro: 'Use POST' }, 405)

  // Uma troca de estado costuma gerar vários eventos seguidos. Sem isto,
  // cada um viraria uma consulta e um restart em cima do outro.
  if (!(await podeNotificar('zap-vigia-webhook', 0.5))) {
    return json({ ok: true, ignorado: 'chamada recente' })
  }

  const r = await vigiar({ origem: 'webhook' })
  return json({ ok: true, ...r })
}

export const config = { path: '/api/zap-conexao' }
