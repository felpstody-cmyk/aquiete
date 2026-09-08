/**
 * POST /api/carrinho
 *
 * Guarda quem começou a digitar no checkout e ainda não finalizou — o
 * "carrinho abandonado". Chave é o e-mail: escrever de novo só atualiza.
 * criar-pedido.mjs remove a entrada quando o pedido sai de verdade.
 */

import { salvarCarrinho } from './_lib/metricas.mjs'

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

  const email = String(corpo.email ?? '').trim().toLowerCase()
  if (email && /^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/.test(email)) {
    try {
      await salvarCarrinho(email, {
        nome: String(corpo.nome ?? '').trim(),
        telefone: String(corpo.telefone ?? '').trim(),
        kit: String(corpo.kit ?? '').trim(),
        em: Date.now(),
      })
    } catch { /* nunca derruba o checkout */ }
  }

  return new Response(null, { status: 204, headers: CORS })
}

export const config = { path: '/api/carrinho' }
