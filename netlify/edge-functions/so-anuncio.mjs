/**
 * Página só de anúncio.
 *
 * /psiquiatra só abre pra quem chega com a chave no link, que é o link
 * que vai no anúncio:
 *
 *   https://aquieteagora.com.br/psiquiatra?k=ER4oKBdx&utm_source=...
 *
 * Quem digita o endereço puro, ou acha o link sem a chave, recebe o 404 de
 * verdade (mesmo conteúdo de /404.html), como se a página não existisse.
 *
 * A chave não é segredo: ela vai dentro de todo link de anúncio, então
 * quem clicou tem. Por isso mora aqui no código e não em variável de
 * ambiente. O que ela barra é o curioso e o concorrente que tentam o
 * endereço direto. Quem recebeu o link completo de alguém entra, e não
 * tem como evitar isso sem quebrar o próprio anúncio.
 *
 * Pra matar um link antigo: tira a chave dele da lista. Pra campanha nova
 * com link próprio: acrescenta outra chave.
 *
 * O cookie existe pra pessoa não tomar 404 se recarregar a página ou
 * voltar da oferta sem o ?k= no endereço.
 */
const CHAVES = ['ER4oKBdx']
const COOKIE = 'aq_anuncio'

function temCookie(request) {
  const bruto = request.headers.get('cookie') || ''
  return bruto.split(';').some((par) => par.trim() === `${COOKIE}=1`)
}

async function pagina404(request) {
  const pagina = await fetch(new URL('/404.html', request.url))
  return new Response(pagina.body, { status: 404, headers: pagina.headers })
}

export default async (request, context) => {
  const url = new URL(request.url)
  const veioDoAnuncio = CHAVES.includes(url.searchParams.get('k') || '')

  if (!veioDoAnuncio && !temCookie(request)) return pagina404(request)

  const resp = await context.next()
  if (veioDoAnuncio) {
    resp.headers.append('Set-Cookie', `${COOKIE}=1; Max-Age=604800; Path=/; SameSite=Lax; Secure`)
  }
  return resp
}

export const config = {
  path: ['/psiquiatra', '/psiquiatra.html'],
}
