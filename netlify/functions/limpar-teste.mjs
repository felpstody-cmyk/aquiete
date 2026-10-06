/**
 * TEMPORARIO — apaga pedidos de teste no Asaas e carrinhos no Blobs.
 * Apagar e definitivo, entao esta funcao so aceita IDs EXPLICITOS: nao
 * existe "apagar todos", nem filtro por nome. Quem decide o que some e
 * quem chama, nunca ela. Apagar o arquivo depois de usar.
 *
 * POST /api/limpar-teste   { pedidos: ["pay_..."], carrinhos: ["email"] }
 */
import { removerCarrinho } from './_lib/metricas.mjs'

const json = (d, s = 200) =>
  new Response(JSON.stringify(d, null, 2), {
    status: s, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  })

const BASES = {
  sandbox: 'https://api-sandbox.asaas.com/v3',
  producao: 'https://api.asaas.com/v3',
}

export default async (req) => {
  if (req.headers.get('x-admin-token') !== process.env.ADMIN_TOKEN) return json({ erro: 'Token invalido' }, 401)
  if (req.method !== 'POST') return json({ erro: 'Use POST' }, 405)

  const corpo = await req.json().catch(() => ({}))
  const pedidos = Array.isArray(corpo.pedidos) ? corpo.pedidos : []
  const carrinhos = Array.isArray(corpo.carrinhos) ? corpo.carrinhos : []
  if (!pedidos.length && !carrinhos.length) return json({ erro: 'nada informado' }, 400)

  const base = BASES[(process.env.ASAAS_AMBIENTE || 'producao').toLowerCase()] || BASES.producao
  const chave = process.env.ASAAS_API_KEY

  const feitos = []
  for (const id of pedidos) {
    if (!/^pay_[a-z0-9]+$/i.test(id)) { feitos.push({ id, erro: 'formato' }); continue }
    try {
      const r = await fetch(`${base}/payments/${id}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json', access_token: chave },
      })
      const j = await r.json().catch(() => ({}))
      feitos.push({ id, ok: r.ok && j.deleted !== false, status: r.status })
    } catch (e) {
      feitos.push({ id, erro: String(e.message || e) })
    }
  }

  const carros = []
  for (const email of carrinhos) {
    try { await removerCarrinho(email); carros.push({ email, ok: true }) }
    catch (e) { carros.push({ email, erro: String(e.message || e) }) }
  }

  return json({ pedidos: feitos, carrinhos: carros })
}

export const config = { path: '/api/limpar-teste' }
