/**
 * Bloqueia:
 *  1) uma cidade específica (hoje, Chapecó/SC — concorrente/ex-sócio de olho
 *     no site);
 *  2) qualquer acesso de fora do Brasil — a loja só vende e envia pro
 *     Brasil, então visita de fora é sempre bot/scraper/crawler de baixa
 *     qualidade poluindo métrica e engordando o custo por clique/anúncio,
 *     nunca cliente de verdade.
 *
 * Devolve o 404 de verdade (mesmo conteúdo de /404.html), não uma
 * mensagem de "você foi bloqueado" — pra quem tá espiando (ou o robô)
 * achar que o link caiu ou nunca existiu, em vez de descobrir que foi
 * identificado e tentar contornar (trocar de rede, usar VPN, etc.).
 *
 * EXCEÇÃO: robôs legítimos de rede social/busca (Facebook, WhatsApp,
 * Google, Bing) passam direto mesmo vindo de fora do Brasil — são eles
 * que geram a prévia do link no anúncio e indexam o site. Bloquear eles
 * quebraria a prévia do anúncio ou marcaria o link como inacessível.
 *
 * Roda nas páginas que um visitante normal abre (loja, checkout, termos)
 * E também nos dois endpoints de API que recebem dado de cliente direto
 * do formulário (criar pedido, carrinho) — um bot esperto pode atacar a
 * API sem nunca carregar a página, então bloquear só o HTML não adianta
 * contra tentativa de fraude/roubo de dado ali. NUNCA roda no painel
 * administrativo nem nos outros endpoints (webhook do Asaas, cron,
 * rastreio de visita) — bloquear esses quebraria o sistema de verdade.
 *
 * PASSE LIVRE: o bloqueio é só por IP/localização, não sabe diferenciar
 * o dono do site de quem ele quer barrar. Configure a variável de
 * ambiente BLOQUEIO_LIBERA_CHAVE no Netlify (Site configuration >
 * Environment variables) e abra, uma única vez, de qualquer navegador
 * que precise ficar liberado (inclusive fora do Brasil):
 *
 *   https://aquieteagora.com.br/?libera=<valor da BLOQUEIO_LIBERA_CHAVE>
 *
 * Isso grava um cookie de 1 ano — depois disso não precisa mais do link.
 * A chave fica só na variável de ambiente, nunca aqui no código, porque
 * este arquivo vai pro GitHub.
 *
 * Pra tirar o bloqueio de cidade: esvazia CIDADES_BLOQUEADAS.
 * Pra tirar o bloqueio de fora do Brasil: apaga o bloco "só Brasil" abaixo.
 */
const CIDADES_BLOQUEADAS = ['chapeco']
const COOKIE_LIBERA = 'aq_libera'

// Substring do User-Agent (minúsculo) — se bater qualquer um, deixa passar
// mesmo sendo de fora do Brasil.
const ROBOS_LIBERADOS = [
  'facebookexternalhit', 'facebookcatalog', 'meta-externalagent', 'whatsapp',
  'googlebot', 'google-inspectiontool', 'bingbot', 'adsbot-google',
]

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

function eRoboLiberado(request) {
  const ua = (request.headers.get('user-agent') || '').toLowerCase()
  return ROBOS_LIBERADOS.some((r) => ua.includes(r))
}

async function pagina404(request) {
  const pagina = await fetch(new URL('/404.html', request.url))
  return new Response(pagina.body, { status: 404, headers: pagina.headers })
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

  if (eRoboLiberado(request)) return context.next()

  const cidade = normaliza(context.geo?.city)
  if (cidade && CIDADES_BLOQUEADAS.includes(cidade)) return pagina404(request)

  const pais = context.geo?.country?.code || ''
  if (pais && pais !== 'BR') return pagina404(request)

  return context.next()
}

export const config = {
  path: [
    '/', '/index.html', '/checkout', '/checkout.html', '/termos', '/termos.html',
    '/api/criar-pedido', '/api/carrinho',
  ],
}
