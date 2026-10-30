/**
 * GET /api/admin-capi   (cabeçalho x-admin-token: ADMIN_TOKEN)
 *
 * Responde uma pergunta que não dava pra responder de fora: os dois
 * pixels estão de pé?
 *
 * Com dois pixels no ar — o nosso e o do parceiro, que anuncia com a
 * conta e o dinheiro dele — "o evento foi?" passou a ter duas respostas,
 * e nenhuma das duas aparecia em lugar nenhum. O token vive só na
 * variável de ambiente, como tem que ser, então não dá pra conferir pelo
 * painel do Netlify nem por fora: a única forma é perguntar pro Meta
 * daqui de dentro.
 *
 * O que ele faz, por pixel:
 *   1. diz se as duas variáveis existem
 *   2. lê os escopos do token no Meta (um token só de leitura de
 *      qualidade passa na validação e mesmo assim não envia nada)
 *   3. tenta enviar um PageView de teste
 *
 * O teste vai com `test_event_code`, então cai na aba "Eventos de teste"
 * e não entra no dado que o Meta usa pra otimizar campanha.
 *
 * NUNCA devolve o valor de token nenhum. Só se existe e o que ele pode.
 */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type, x-admin-token',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
}

const json = (dados, status = 200) =>
  new Response(JSON.stringify(dados, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...CORS },
  })

const VERSAO = 'v21.0'

async function conferir(nome, pixel, token) {
  if (!pixel && !token) return { nome, estado: 'nao configurado', pixel: null }
  if (!pixel) return { nome, estado: 'falta o id do pixel', pixel: null }
  if (!token) return { nome, estado: 'falta o token', pixel }

  const saida = { nome, pixel, estado: 'conferindo' }

  // Escopos do token. Serve pra distinguir dois erros que parecem iguais:
  // token errado e token certo sem permissao de escrita.
  try {
    const r = await fetch(
      `https://graph.facebook.com/${VERSAO}/debug_token` +
        `?input_token=${encodeURIComponent(token)}&access_token=${encodeURIComponent(token)}`
    )
    const d = await r.json()
    if (d?.data) {
      saida.escopos = d.data.scopes || []
      saida.expira = d.data.expires_at === 0 ? 'nunca' : new Date(d.data.expires_at * 1000).toISOString()
      saida.tokenValido = !!d.data.is_valid
    } else {
      saida.escopos = []
      saida.tokenValido = false
      saida.erroEscopo = d?.error?.message || 'sem resposta'
    }
  } catch (e) {
    saida.erroEscopo = e.message
  }

  // O que importa de verdade: o Meta aceita um evento deste token?
  try {
    const r = await fetch(`https://graph.facebook.com/${VERSAO}/${pixel}/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        access_token: token,
        test_event_code: 'TEST_AQ_DIAG',
        data: [
          {
            event_name: 'PageView',
            event_time: Math.floor(Date.now() / 1000),
            event_id: `diagnostico-${Date.now()}`,
            action_source: 'website',
            event_source_url: 'https://aquieteagora.com.br/oferta',
            user_data: { client_ip_address: '189.1.1.1', client_user_agent: 'diagnostico-aquiete' },
          },
        ],
      }),
    })
    const d = await r.json().catch(() => ({}))
    if (r.ok) {
      saida.envio = 'aceito'
      saida.recebidos = d.events_received
      saida.estado = 'ok'
    } else {
      saida.envio = 'recusado'
      saida.motivo = d?.error?.message || `HTTP ${r.status}`
      saida.estado = 'token sem permissao de envio'
    }
  } catch (e) {
    saida.envio = 'falhou'
    saida.motivo = e.message
    saida.estado = 'erro de rede'
  }

  return saida
}

export default async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS })

  const esperado = process.env.ADMIN_TOKEN
  if (!esperado) return json({ erro: 'ADMIN_TOKEN não configurado no Netlify' }, 500)
  if (req.headers.get('x-admin-token') !== esperado) return json({ erro: 'Token inválido' }, 401)

  const [casa, parceiro] = await Promise.all([
    conferir('casa', process.env.META_PIXEL_ID, process.env.META_CAPI_TOKEN),
    conferir('parceiro', process.env.META_PIXEL_ID_PARCEIRO, process.env.META_CAPI_TOKEN_PARCEIRO),
  ])

  return json({ casa, parceiro, em: new Date().toISOString() })
}

export const config = { path: '/api/admin-capi' }
