/**
 * GET    /api/admin-comentarios            (x-admin-token)  tudo, inclusive o que espera
 * POST   /api/admin-comentarios            (x-admin-token)  aprova, responde ou apaga
 *        { id, acao: "aprovar" | "esconder" | "apagar" | "zap", resposta?, zap? }
 *
 * O comentário que chega fica invisível até passar por aqui. É o que
 * separa "comentário de verdade embaixo do artigo" de "qualquer um
 * escreve qualquer coisa no meu site".
 *
 * Responder é três coisas diferentes, e por isso são três caminhos:
 *
 *   aprovar + zap:true   publica o comentário com a resposta E manda o zap
 *   aprovar              publica e não manda mensagem nenhuma
 *   zap                  manda o zap e a página nem sabe que existiu
 *
 * O último é o que faltava. Responder alguém pelo WhatsApp não é motivo
 * pra aquele comentário virar conteúdo do site: ele escolhe o que fica na
 * página, e isso é independente de ele querer falar com a pessoa.
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
  } else if (corpo.acao === 'zap') {
    /*
     * Resposta que vai SÓ pelo WhatsApp.
     *
     * Não toca em `aprovado` nem em `resposta` de propósito: é isso que
     * mantém o comentário fora da página. Fica guardado em `respostaZap`,
     * que a lista branca do `publico()` não devolve — então o registro
     * conta o que foi dito e a página continua sem saber.
     */
    if (!corpo.resposta) return json({ erro: 'Faltando a resposta' }, 400)
    if (!todos[i].zap) return json({ erro: 'Esse comentário não deixou WhatsApp' }, 400)
    todos[i].respostaZap = String(corpo.resposta).trim().slice(0, 600)
    todos[i].respostaZapEm = Date.now()
  } else {
    return json({ erro: 'acao deve ser aprovar, esconder, apagar ou zap' }, 400)
  }

  await store.setJSON('lista', todos)

  /*
   * A resposta no WhatsApp dela.
   *
   * O envio chega: conferido em 31/10/2026, mensagem recebida no celular.
   *
   * O que não dá pra usar como prova é o log. A API responde SENDING, que
   * é "aceitei", e o webhook de status nunca confirmou entrega de nenhuma
   * das mensagens da loja — ou seja, "aceita" parada no log não quer
   * dizer que falhou. Por isso o `wame` volta SEMPRE que der pra montar:
   * é a conversa aberta com o texto já escrito, pra ele mandar na mão se
   * a pessoa disser que não recebeu.
   */
  const alvo = corpo.acao === 'apagar' ? null : todos[i]
  const soNoZap = corpo.acao === 'zap'
  const resposta = soNoZap
    ? alvo?.respostaZap
    : (corpo.acao === 'aprovar' ? alvo?.resposta : null)

  let zap = null
  let wame = null

  if (resposta && alvo?.zap) {
    /*
     * O link entra só quando a resposta está mesmo na página.
     *
     * Sem esse `!soNoZap` a mensagem diria "seu comentário já está
     * publicado, com essa resposta embaixo" pra exatamente quem ele
     * respondeu pra NÃO publicar. O texto se ajusta sozinho: sem link, a
     * frase toda desaparece em vez de ficar meia.
     */
    const texto = textoRespostaComentario({
      nome: alvo.nome,
      resposta,
      link: soNoZap ? '' : linkDoComentario(alvo.pagina),
    })
    wame = `https://wa.me/${alvo.zap}?text=${encodeURIComponent(texto)}`

    if (soNoZap || corpo.zap) {
      zap = await enviarZap({ telefone: alvo.zap, texto })
      // Entra no mesmo log dos outros envios, pra confirmação de entrega
      // cair aqui pelo webhook igual às do Pix e do rastreio.
      await registrarZap({
        referencia: 'comentário',
        nome: alvo.nome,
        telefone: alvo.zap,
        etapa: soNoZap ? 'resposta só no zap' : 'resposta de comentário',
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
