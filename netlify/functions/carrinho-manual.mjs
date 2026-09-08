/**
 * POST /api/carrinho-manual   (cabeçalho x-admin-token: ADMIN_TOKEN)
 *
 * Adiciona um "carrinho abandonado" na mão — pra gente que chamou no
 * Instagram/WhatsApp e nunca chegou a abrir o checkout, ou pra testar a
 * sequência de e-mail sem esperar ninguém abandonar de verdade.
 */

import { salvarCarrinho } from './_lib/metricas.mjs'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type, x-admin-token',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const json = (dados, status = 200) =>
  new Response(JSON.stringify(dados), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...CORS },
  })

export default async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS })
  if (req.method !== 'POST') return json({ erro: 'Use POST' }, 405)

  const esperado = process.env.ADMIN_TOKEN
  if (!esperado) return json({ erro: 'ADMIN_TOKEN não configurado no Netlify' }, 500)
  if (req.headers.get('x-admin-token') !== esperado) return json({ erro: 'Token inválido' }, 401)

  let corpo
  try { corpo = await req.json() } catch { return json({ erro: 'JSON inválido' }, 400) }

  const email = String(corpo.email ?? '').trim().toLowerCase()
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/.test(email)) {
    return json({ erro: 'E-mail inválido' }, 400)
  }

  const horasAtras = Number(corpo.horasAtras) || 0
  await salvarCarrinho(email, {
    nome: String(corpo.nome ?? '').trim(),
    telefone: String(corpo.telefone ?? '').trim(),
    kit: String(corpo.kit ?? '').trim(),
    em: Date.now() - horasAtras * 3_600_000,
  })

  return json({ ok: true })
}

export const config = { path: '/api/carrinho-manual' }
