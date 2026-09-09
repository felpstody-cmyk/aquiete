/**
 * POST /api/admin-sessao   (cabeçalho x-admin-token: ADMIN_TOKEN)
 * body: { sid }
 *
 * Apaga o registro de comportamento (rolagem, tempo, cliques) de uma
 * sessão — pra tirar teste do próprio dono da lista "pessoa por pessoa".
 */

import { apagarSessao } from './_lib/jornada.mjs'

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
  if (req.method !== 'POST') return json({ erro: 'Método não permitido' }, 405)

  const esperado = process.env.ADMIN_TOKEN
  if (!esperado) return json({ erro: 'ADMIN_TOKEN não configurado no Netlify' }, 500)
  if (req.headers.get('x-admin-token') !== esperado) return json({ erro: 'Token inválido' }, 401)

  const corpo = await req.json().catch(() => ({}))
  const sid = String(corpo?.sid || '').trim()
  if (!sid) return json({ erro: 'sid obrigatório' }, 400)

  await apagarSessao(sid)
  return json({ ok: true })
}

export const config = { path: '/api/admin-sessao' }
