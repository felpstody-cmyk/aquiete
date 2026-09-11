/**
 * Bloqueia quem acessa o site vindo de uma cidade específica — hoje, só
 * Chapecó (SC), por causa de um concorrente/ex-sócio de olho no site.
 *
 * Devolve o 404 de verdade (mesmo conteúdo de /404.html), não uma
 * mensagem de "você foi bloqueado" — pra quem tá espiando achar que o
 * link caiu ou nunca existiu, em vez de descobrir que foi identificado
 * e tentar contornar (trocar de rede, usar VPN, etc.).
 *
 * Roda só nas páginas que um visitante normal abre (loja, checkout,
 * termos) — nunca em /api/* nem no painel administrativo.
 *
 * PASSE LIVRE: o bloqueio é só por IP/localização, não sabe diferenciar
 * o dono do site de quem ele quer barrar. Configure a variável de
 * ambiente BLOQUEIO_LIBERA_CHAVE no Netlify (Site configuration >
 * Environment variables) e abra, uma única vez, de qualquer navegador
 * que precise ficar liberado:
 *
 *   https://aquieteagora.com.br/?libera=<valor da BLOQUEIO_LIBERA_CHAVE>
 *
 * Isso grava um cookie de 1 ano — depois disso não precisa mais do link,
 * mesmo de Chapecó. A chave fica só na variável de ambiente, nunca aqui
 * no código, porque este arquivo vai pro GitHub.
 *
 * Pra tirar o bloqueio de vez: apaga esse arquivo, ou esvazia
 * CIDADES_BLOQUEADAS.
 */
const CIDADES_BLOQUEADAS = ['chapeco']
const COOKIE_LIBERA = 'aq_libera'

function normaliza(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
}

function temCookieLibera(request) {
  const bruto = request.headers.get('cookie') || ''
  return bruto.split(';').some((par) => par.trim() === `${COOKIE_LIBERA}=1`)
}

export default async (request, context) => {
  const url = new URL(request.url)
  const chave = Deno.env.get('BLOQUEIO_LIBERA_CHAVE')
  const pedeLiberacao = !!chave && url.searchParams.get('libera') === chave

  if (pedeLiberacao || temCookieLibera(request)) {
    const resp = await context.next()
    if (pedeLiberacao) {
      resp.headers.append('Set-Cookie', `${COOKIE_LIBERA}=1; Max-Age=31536000; Path=/; SameSite=Lax; Secure`)
    }
    return resp
  }

  const cidade = normaliza(context.geo?.city)
  if (cidade && CIDADES_BLOQUEADAS.includes(cidade)) {
    const pagina = await fetch(new URL('/404.html', request.url))
    return new Response(pagina.body, { status: 404, headers: pagina.headers })
  }
  return context.next()
}

export const config = {
  path: ['/', '/index.html', '/checkout', '/checkout.html', '/termos', '/termos.html'],
}
