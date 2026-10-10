/**
 * GET    /api/admin-comentarios            (x-admin-token)  tudo, inclusive o que espera
 * POST   /api/admin-comentarios            (x-admin-token)  aprova, responde ou apaga
 *        { id, acao: "aprovar" | "esconder" | "apagar", resposta? }
 *
 * O comentário que chega fica invisível até passar por aqui. É o que
 * separa "comentário de verdade embaixo do artigo" de "qualquer um
 * escreve qualquer coisa no meu site".
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
  return getStore('comentarios')
}

export default async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS })

  const esperado = process.env.ADMIN_TOKEN
  if (!esperado) return json({ erro: 'ADMIN_TOKEN não configurado no Netlify' }, 500)
  if (req.headers.get('x-admin-token') !== esperado) return json({ erro: 'Token inválido' }, 401)

  const store = await loja()
  const todos = (await store.get('lista', { type: 'json' }).catch(() => null)) || []

  if (req.method === 'GET') {
    return json({
      esperando: todos.filter((c) => !c.aprovado).length,
      comentarios: todos,
    })
  }

  if (req.method !== 'POST') return json({ erro: 'Use POST' }, 405)

  const corpo = await req.json().catch(() => null)
  if (!corpo?.id || !corpo?.acao) return json({ erro: 'Faltando id ou acao' }, 400)

  const i = todos.findIndex((c) => c.id === corpo.id)
  if (i < 0) return json({ erro: 'Comentário não encontrado' }, 404)

  if (corpo.acao === 'apagar') {
    todos.splice(i, 1)
  } else if (corpo.acao === 'aprovar') {
    todos[i].aprovado = true
    // A resposta da loja aparece logo abaixo do comentário, como numa
    // conversa. Opcional: sem ela, só o comentário entra.
    if (corpo.resposta) todos[i].resposta = String(corpo.resposta).trim().slice(0, 600)
  } else if (corpo.acao === 'esconder') {
    todos[i].aprovado = false
  } else {
    return json({ erro: 'acao deve ser aprovar, esconder ou apagar' }, 400)
  }

  await store.setJSON('lista', todos)
  return json({ ok: true, esperando: todos.filter((c) => !c.aprovado).length })
}

export const config = { path: '/api/admin-comentarios' }
