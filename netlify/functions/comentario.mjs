/**
 * Comentários nas páginas de artigo.
 *
 *   POST /api/comentario   { pagina, nome, texto }   público
 *   GET  /api/comentario?pagina=motivos              público, só aprovados
 *
 * Nada aparece na página sem o Felipe aprovar. Comentário entra como
 * `aprovado: false`, ele recebe um toque no celular e decide. Isso serve
 * pra duas coisas ao mesmo tempo: barra ofensa e spam, e garante que o
 * que está embaixo do artigo é gente de verdade — que é o ponto todo de
 * ter comentário numa página que vende.
 *
 * A aprovação é feita por admin-comentarios, com o ADMIN_TOKEN.
 */

import { push, podeNotificar } from './_lib/notificar.mjs'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
}

const json = (dados, status = 200, cache = 'no-store') =>
  new Response(JSON.stringify(dados), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': cache, ...CORS },
  })

const LIMITE = 300          // guarda os últimos, não a eternidade
const MAX_TEXTO = 600
const MAX_NOME = 40

let getStore = null
async function loja() {
  if (!getStore) ({ getStore } = await import('@netlify/blobs'))
  return getStore('comentarios')
}

/** Só o que vai pra tela. Sem IP, sem nada que identifique além do nome. */
function publico(c) {
  return { id: c.id, nome: c.nome, texto: c.texto, em: c.em, resposta: c.resposta || null }
}

function limpar(s, max) {
  return String(s ?? '')
    .replace(/[\u0000-\u001F\u007F]/g, ' ')   // controles
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
}

export default async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS })

  const url = new URL(req.url)
  const store = await loja()

  // ---------------------------------------------------------- leitura
  if (req.method === 'GET') {
    const pagina = limpar(url.searchParams.get('pagina'), 40) || 'motivos'
    const todos = (await store.get('lista', { type: 'json' }).catch(() => null)) || []
    const meus = todos.filter((c) => c.pagina === pagina && c.aprovado).map(publico)
    // Cache curto: comentário novo não precisa aparecer no mesmo segundo,
    // e assim a página não bate no Blobs a cada visita.
    return json({ comentarios: meus }, 200, 'public, max-age=60')
  }

  if (req.method !== 'POST') return json({ erro: 'Use POST' }, 405)

  let corpo
  try { corpo = await req.json() } catch { return json({ erro: 'JSON inválido' }, 400) }

  const pagina = limpar(corpo.pagina, 40) || 'motivos'
  const nome = limpar(corpo.nome, MAX_NOME)
  const texto = limpar(corpo.texto, MAX_TEXTO)

  if (texto.length < 3) return json({ erro: 'Escreva seu comentário.' }, 400)
  if (!nome) return json({ erro: 'Diga como quer ser chamada.' }, 400)

  // Trava por pessoa: um comentário a cada 10 min no mesmo navegador não
  // dá, porque aqui não há sessão. A trava é por nome+página, que já
  // segura o engraçadinho que aperta enviar dez vezes.
  const chaveTrava = 'coment:' + pagina + ':' + nome.toLowerCase().slice(0, 20)
  if (!(await podeNotificar(chaveTrava, 10))) {
    return json({ ok: true, aviso: 'Já recebemos seu comentário.' })
  }

  const todos = (await store.get('lista', { type: 'json' }).catch(() => null)) || []
  const novo = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
    pagina,
    nome,
    texto,
    em: Date.now(),
    aprovado: false,
    resposta: null,
  }
  await store.setJSON('lista', [novo, ...todos].slice(0, LIMITE))

  push(
    [
      '💬 Comentário novo em /' + pagina,
      '',
      nome + ':',
      texto.slice(0, 220),
      '',
      'Entra na página só depois que você aprovar.',
    ].join('\n'),
    'Aquiete — comentário pra aprovar',
    { tags: 'speech_balloon' },
  ).catch(() => {})

  return json({ ok: true })
}

export const config = { path: '/api/comentario' }
