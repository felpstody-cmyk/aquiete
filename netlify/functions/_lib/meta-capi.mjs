/**
 * Conversions API do Meta — eventos enviados pelo servidor.
 *
 * Variáveis de ambiente:
 *   META_PIXEL_ID    id do pixel (só números)
 *   META_CAPI_TOKEN  token de acesso gerado no Gerenciador de Eventos
 *   META_TEST_EVENT  opcional: código TEST#### para ver o evento chegando
 *
 * Sem as duas primeiras, nada é enviado e nada quebra.
 *
 * Por que existe: o pixel do navegador perde de 20 a 40% dos eventos para
 * bloqueador de anúncio e iOS. O evento daqui não passa pelo navegador do
 * cliente, então chega sempre — e o Meta otimiza a campanha com dado real.
 */

import { createHash } from 'node:crypto'

const VERSAO = 'v21.0'

/** O Meta exige SHA-256 em qualquer dado pessoal. Enviar cru é violação. */
const hash = (valor) => {
  const limpo = String(valor ?? '').trim().toLowerCase()
  return limpo ? createHash('sha256').update(limpo).digest('hex') : null
}

/** Telefone precisa ir só com dígitos e código do país. */
const hashTelefone = (tel) => {
  const digitos = String(tel ?? '').replace(/\D/g, '')
  if (!digitos) return null
  return hash(digitos.startsWith('55') ? digitos : '55' + digitos)
}

const semNulos = (obj) =>
  Object.fromEntries(Object.entries(obj).filter(([, v]) => v != null))

/**
 * Quem é a pessoa, do jeito que o Meta exige: tudo que identifica vai
 * em SHA-256. IP, navegador e os cookies _fbp/_fbc vão crus, porque
 * nesses campos o Meta pede assim — e são eles que deixam o Meta casar
 * a pessoa com o anúncio que ela viu.
 */
function identidade(cliente, rede = {}) {
  return semNulos({
    em: [hash(cliente.email)].filter(Boolean),
    ph: [hashTelefone(cliente.telefone)].filter(Boolean),
    fn: [hash(String(cliente.nome).split(' ')[0])].filter(Boolean),
    ln: [hash(String(cliente.nome).split(' ').slice(-1)[0])].filter(Boolean),
    ct: [hash(cliente.cidade)].filter(Boolean),
    zp: [hash(String(cliente.cep).replace(/\D/g, ''))].filter(Boolean),
    country: [hash('br')],
    client_ip_address: rede.ip || null,
    client_user_agent: rede.ua || null,
    fbp: rede.fbp || null,
    fbc: rede.fbc || null,
  })
}

/**
 * Pix gerado, mandado pelo servidor.
 *
 * Esse é o evento que a campanha otimiza hoje. Pelo navegador ele só
 * existia pra quem aceitou o cookie: 13 no mês inteiro. O `event_id` é
 * a referência do pedido, igual à que o checkout usa no eventID, então
 * o Meta junta os dois em vez de contar duas vezes.
 */
export async function enviarPagamento({ referencia, total, cliente, kitId, unidades, ip, ua, fbp, fbc }) {
  const pixel = process.env.META_PIXEL_ID
  const token = process.env.META_CAPI_TOKEN
  if (!pixel || !token) return { enviado: false, motivo: 'sem credenciais' }

  const evento = {
    event_name: 'AddPaymentInfo',
    event_time: Math.floor(Date.now() / 1000),
    event_id: referencia,
    action_source: 'website',
    event_source_url: 'https://aquieteagora.com.br/checkout',
    user_data: identidade(cliente, { ip, ua, fbp, fbc }),
    custom_data: {
      currency: 'BRL',
      value: Number(total),
      content_type: 'product',
      content_ids: [`aquiete-kit-${kitId}`],
      contents: [{ id: `aquiete-kit-${kitId}`, quantity: unidades, item_price: Number((total / unidades).toFixed(2)) }],
      num_items: unidades,
    },
  }

  return postar(evento, pixel, token)
}

export async function enviarCompra({ referencia, total, cliente, kitId, unidades }) {
  const pixel = process.env.META_PIXEL_ID
  const token = process.env.META_CAPI_TOKEN
  if (!pixel || !token) {
    console.log('[capi] META_PIXEL_ID ou META_CAPI_TOKEN ausente — evento não enviado')
    return { enviado: false, motivo: 'sem credenciais' }
  }

  const evento = {
    event_name: 'Purchase',
    event_time: Math.floor(Date.now() / 1000),
    // Mesmo id do pixel do navegador: é assim que o Meta deduplica e não
    // conta a mesma compra duas vezes.
    event_id: referencia,
    action_source: 'website',
    event_source_url: 'https://aquieteagora.com.br/checkout',
    user_data: identidade(cliente),
    custom_data: {
      currency: 'BRL',
      value: Number(total),
      content_type: 'product',
      content_ids: [`aquiete-kit-${kitId}`],
      contents: [{ id: `aquiete-kit-${kitId}`, quantity: unidades, item_price: Number((total / unidades).toFixed(2)) }],
      num_items: unidades,
    },
  }

  return postar(evento, pixel, token)
}

/** O envio em si. Dois chamadores: a Compra e os eventos de funil. */
async function postar(evento, pixel, token) {
  const corpo = { data: [evento] }
  if (process.env.META_TEST_EVENT) corpo.test_event_code = process.env.META_TEST_EVENT

  const r = await fetch(
    `https://graph.facebook.com/${VERSAO}/${pixel}/events?access_token=${encodeURIComponent(token)}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(corpo) }
  )

  const resposta = await r.json().catch(() => ({}))
  if (!r.ok) {
    throw new Error(`Meta ${r.status}: ${resposta?.error?.message || 'erro desconhecido'}`)
  }
  return { enviado: true, recebidos: resposta.events_received }
}

/**
 * Eventos de funil mandados pelo servidor.
 *
 * Por que existe: o pixel do navegador só liga pra quem aceita o cookie.
 * Medido em 13/09 a 10/10, o Meta estava vendo 228 de 1.928 visitas — 12%.
 * O algoritmo escolhia pra quem mostrar o anúncio com um oitavo do dado.
 *
 * O `eventId` é o mesmo que o navegador usa quando o pixel está ligado,
 * então o Meta junta os dois em vez de contar duas vezes.
 *
 * Quem clicou "Só o necessário" não chega aqui: isso é barrado antes, em
 * /api/sinal. O botão é uma promessa escrita na tela.
 */
const DE_FUNIL = new Set(['ViewContent', 'InitiateCheckout'])

export async function enviarSinal({ nome, eventId, url, ip, ua, fbp, fbc, valor }) {
  const pixel = process.env.META_PIXEL_ID
  const token = process.env.META_CAPI_TOKEN
  if (!pixel || !token) return { enviado: false, motivo: 'sem credenciais' }
  if (!DE_FUNIL.has(nome)) return { enviado: false, motivo: 'evento fora da lista' }
  if (!eventId) return { enviado: false, motivo: 'sem id pra deduplicar' }

  const evento = {
    event_name: nome,
    event_time: Math.floor(Date.now() / 1000),
    event_id: eventId,
    action_source: 'website',
    event_source_url: url || 'https://aquieteagora.com.br/',
    // IP e navegador vao crus de proposito: o Meta exige assim nestes
    // campos, e e o que permite ele casar a pessoa com o anuncio.
    user_data: semNulos({
      client_ip_address: ip || null,
      client_user_agent: ua || null,
      fbp: fbp || null,
      fbc: fbc || null,
      country: [hash('br')],
    }),
    custom_data: semNulos({
      currency: valor != null ? 'BRL' : null,
      value: valor != null ? Number(valor) : null,
      content_type: 'product',
      content_ids: ['aquiete-30ml'],
    }),
  }

  return postar(evento, pixel, token)
}
