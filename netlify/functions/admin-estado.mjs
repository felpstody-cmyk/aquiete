/**
 * GET/POST /api/admin-estado   (cabeçalho x-admin-token: ADMIN_TOKEN)
 *
 * Guarda despesas, lotes de estoque, pedidos manuais, status manual dos
 * pedidos do site e as configurações do painel — a parte que antes só
 * existia no localStorage de um navegador. Com isso o sistema funciona
 * igual em qualquer aparelho, não só no PC que configurou primeiro.
 *
 * Documento único (não é por pedido/lote) — o volume é baixo (é um MEI
 * só, não uma equipe) e assim não precisa de lógica de mesclagem entre
 * aparelhos: quem sincronizar por último manda.
 */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type, x-admin-token',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
}

const json = (dados, status = 200) =>
  new Response(JSON.stringify(dados), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...CORS },
  })

let getStore = null
async function loja() {
  if (!getStore) ({ getStore } = await import('@netlify/blobs'))
  return getStore('admin-estado')
}

export default async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS })

  const esperado = process.env.ADMIN_TOKEN
  if (!esperado) return json({ erro: 'ADMIN_TOKEN não configurado no Netlify' }, 500)
  if (req.headers.get('x-admin-token') !== esperado) return json({ erro: 'Token inválido' }, 401)

  const store = await loja()

  if (req.method === 'GET') {
    const doc = await store.get('estado', { type: 'json' }).catch(() => null)
    return json(doc || {})
  }

  if (req.method === 'POST') {
    const corpo = await req.json().catch(() => null)
    if (!corpo) return json({ erro: 'corpo inválido' }, 400)
    const doc = {
      manuais: Array.isArray(corpo.manuais) ? corpo.manuais : [],
      statusManual: corpo.statusManual && typeof corpo.statusManual === 'object' ? corpo.statusManual : {},
      despesas: Array.isArray(corpo.despesas) ? corpo.despesas : [],
      lotes: Array.isArray(corpo.lotes) ? corpo.lotes : [],
      cfg: corpo.cfg && typeof corpo.cfg === 'object' ? corpo.cfg : {},
      atualizadoEm: Date.now(),
    }
    await store.setJSON('estado', doc)
    return json({ ok: true })
  }

  return json({ erro: 'Método não permitido' }, 405)
}

export const config = { path: '/api/admin-estado' }
