/**
 * GET    /api/admin-comentarios            (x-admin-token)  tudo, inclusive o que espera
 * POST   /api/admin-comentarios            (x-admin-token)  aprova, responde ou apaga
 *        { id, acao: "aprovar" | "esconder" | "apagar", resposta?, zap? }
 *
 * O comentário que chega fica invisível até passar por aqui. É o que
 * separa "comentário de verdade embaixo do artigo" de "qualquer um
 * escreve qualquer coisa no meu site".
 *
 * Com `zap: true`, a resposta também vai pro WhatsApp de quem comentou.
 * Sem isso, aprovar com resposta publica um texto que a pessoa nunca vai
 * ler: ela comentou e foi embora, e a página não tem como chamar ela de
 * volta.
 */

import { enviarZap, textoRespostaComentario } from './_lib/zap.mjs'
import { registrarZap } from './_lib/zaplog.mjs'

/*
 * Onde cada comentário mora, pra mensagem poder levar o link.
 *
 * A chave `k=` da /psiquiatra é a MESMA de so-anuncio.mjs: aquela página
 * só abre pra quem chega pelo anúncio, e sem a chave a pessoa toma um 404
 * de verdade. O cookie que ela ganhou ao clicar no anúncio dura 7 dias,
 * então o link sem chave funciona hoje e quebra na semana que vem, ou
 * agora mesmo se ela abrir no computador em vez do celular. Se a chave
 * mudar lá, muda aqui — são os dois únicos lugares onde ela existe.
 *
 * O utm é pra venda que nascer dessa conversa aparecer como vinda daqui,
 * e não como "direto".
 */
const LINKS = {
  psiquiatra: 'https://aquieteagora.com.br/psiquiatra?k=ER4oKBdx',
  motivos: 'https://aquieteagora.com.br/motivos',
}

function linkDoComentario(pagina) {
  const base = LINKS[pagina] || LINKS.motivos
  return base + (base.includes('?') ? '&' : '?')
    + 'utm_source=whatsapp&utm_medium=comentario#comentarios'
}

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

  /*
   * A resposta no WhatsApp dela.
   *
   * O `wame` volta SEMPRE que der pra montar, mesmo sem `zap: true` e
   * mesmo quando o envio deu certo. Não é enfeite: a API responde
   * SENDING, que é "aceitei", e no log de zap da loja nenhuma mensagem
   * chegou a confirmar entrega ainda. Então o painel precisa ter o
   * caminho que não depende de provedor — a conversa aberta com o texto
   * já escrito — à mão, não só quando aparece erro.
   */
  const alvo = corpo.acao === 'aprovar' ? todos[i] : null
  let zap = null
  let wame = null

  if (alvo?.resposta && alvo?.zap) {
    const texto = textoRespostaComentario({
      nome: alvo.nome,
      resposta: alvo.resposta,
      link: linkDoComentario(alvo.pagina),
    })
    wame = `https://wa.me/${alvo.zap}?text=${encodeURIComponent(texto)}`

    if (corpo.zap) {
      zap = await enviarZap({ telefone: alvo.zap, texto })
      // Entra no mesmo log dos outros envios, pra confirmação de entrega
      // cair aqui pelo webhook igual às do Pix e do rastreio.
      await registrarZap({
        referencia: 'comentário',
        nome: alvo.nome,
        telefone: alvo.zap,
        etapa: 'resposta de comentário',
        resultado: zap,
      })
    }
  }

  return json({
    ok: true,
    esperando: todos.filter((c) => !c.aprovado).length,
    zap,
    wame,
  })
}

export const config = { path: '/api/admin-comentarios' }
