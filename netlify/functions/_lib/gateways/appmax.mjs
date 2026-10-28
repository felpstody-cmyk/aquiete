/**
 * Adaptador da Appmax.
 *
 * Existe por um motivo só: na Appmax quem aparece como recebedor do Pix é
 * "Appmax", não a razão social do lojista. No Asaas aparecia
 * "68601075 FELIPE STRAUSS", que é o CNPJ do MEI colado no nome, e quem
 * acabou de conhecer a loja vê isso na hora de confirmar e desiste.
 *
 * ATENÇÃO, nunca ativar no painel da Appmax a opção "Recebimento de Pix
 * via Max": ela troca "Appmax" pela razão social do vendedor, que é
 * exatamente o problema que esta migração resolve.
 *
 * O fluxo deles tem três passos, nesta ordem, e cada um depende do
 * anterior:
 *
 *   1. POST /v1/customers  -> data.customer.id
 *   2. POST /v1/orders     -> data.order.id   (precisa do customer_id)
 *   3. POST /v1/payments/pix -> data.payment  (precisa do order_id)
 *
 * TODO valor vai em CENTAVOS. R$ 129,90 é 12990. Mandar reais faz a
 * cobrança sair cem vezes menor e o erro passa despercebido.
 */

import { ErroDeGateway } from './index.mjs'

export const nome = 'appmax'

/*
 * O host que emite o token NÃO é o mesmo que atende a API. Pedir o token
 * em api.* devolve erro, e era assim que este arquivo estava escrito até
 * eu conferir a documentação. Os quatro endereços abaixo estão na
 * referência oficial da Appmax, não foram deduzidos.
 */
const HOSTS = {
  producao: { api: 'https://api.appmax.com.br', auth: 'https://auth.appmax.com.br' },
  sandbox: { api: 'https://api.sandboxappmax.com.br', auth: 'https://auth.sandboxappmax.com.br' },
}

/** Reais -> centavos. Arredonda pra não deixar fração escapar em float. */
const centavos = (v) => Math.round(Number(v || 0) * 100)

const soDigitos = (v) => String(v ?? '').replace(/\D/g, '')

function config() {
  const id = process.env.APPMAX_CLIENT_ID
  const segredo = process.env.APPMAX_CLIENT_SECRET
  if (!id || !segredo) {
    throw new ErroDeGateway('APPMAX_CLIENT_ID / APPMAX_CLIENT_SECRET não configurados no Netlify', 500)
  }
  const ambiente = (process.env.APPMAX_AMBIENTE || 'producao').toLowerCase()
  const hosts = HOSTS[ambiente] || HOSTS.producao
  return { id, segredo, api: hosts.api, auth: hosts.auth }
}

/*
 * O token do OAuth vale por um tempo e pedir um novo a cada cobrança
 * gastaria uma chamada inteira antes de cada pagamento. A função do
 * Netlify fica quente entre uma execução e outra, então guardar aqui no
 * módulo aproveita isso. Quando ela esfria, a variável some junto e o
 * próximo pedido simplesmente busca outro token.
 *
 * Tiro 60 segundos do prazo de propósito: token que vence no meio da
 * cobrança derruba o pedido de um cliente real.
 */
let tokenCache = { valor: '', expiraEm: 0 }

async function token() {
  const agora = Date.now()
  if (tokenCache.valor && agora < tokenCache.expiraEm) return tokenCache.valor

  const { id, segredo, auth } = config()
  const resposta = await fetch(`${auth}/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ grant_type: 'client_credentials', client_id: id, client_secret: segredo }),
  })
  const corpo = await resposta.json().catch(() => ({}))
  if (!resposta.ok || !corpo?.access_token) {
    throw new ErroDeGateway(`Appmax não autenticou (${resposta.status}). Confira as credenciais.`, 500)
  }
  const validade = Number(corpo.expires_in || 3600)
  tokenCache = { valor: corpo.access_token, expiraEm: agora + Math.max(60, validade - 60) * 1000 }
  return tokenCache.valor
}

async function chamar(caminho, corpo) {
  const { api } = config()
  const resposta = await fetch(api + caminho, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Authorization: `Bearer ${await token()}`,
    },
    body: JSON.stringify(corpo),
  })
  const dados = await resposta.json().catch(() => ({}))
  if (!resposta.ok) {
    // O 422 deles traz o motivo campo a campo. Sem isso o lojista recebe
    // "erro 422" e não tem como saber que faltou, por exemplo, o estado.
    const detalhe =
      dados?.message ||
      (dados?.errors && JSON.stringify(dados.errors)) ||
      resposta.statusText
    throw new ErroDeGateway(`Appmax ${resposta.status}: ${detalhe}`)
  }
  return dados
}

/*
 * O checkout grava a cidade como "Chapecó / SC", porque é assim que o
 * ViaCEP devolve e é assim que a pessoa lê na tela. A Appmax quer os dois
 * separados, então desmonto aqui em vez de mexer no formulário.
 */
function cidadeEstado(bruto) {
  const partes = String(bruto || '').split('/')
  const cidade = (partes[0] || '').trim()
  const uf = (partes[1] || '').trim().toUpperCase().slice(0, 2)
  return { cidade, uf }
}

/* "Felipe Strauss Toderati" -> first "Felipe", last "Strauss Toderati".
   Quem digita só o primeiro nome fica com sobrenome vazio, e a Appmax
   aceita: barrar aqui seria inventar uma regra que o checkout não tem. */
function nomePartido(bruto) {
  const partes = String(bruto || '').trim().split(/\s+/)
  return { first_name: partes.shift() || '', last_name: partes.join(' ') }
}

async function criarCliente(cliente, origem, ip) {
  const { cidade, uf } = cidadeEstado(cliente.cidade)
  const { first_name, last_name } = nomePartido(cliente.nome)

  const corpo = {
    first_name,
    last_name,
    email: cliente.email,
    phone: soDigitos(cliente.telefone),
    document_number: soDigitos(cliente.cpf),
    address: {
      postcode: soDigitos(cliente.cep),
      street: cliente.rua || '',
      number: String(cliente.numero || ''),
      complement: cliente.complemento || '',
      district: cliente.bairro || '',
      city: cidade,
      state: uf,
    },
  }

  // O IP é o que a Appmax usa na análise antifraude. Vem do cabeçalho da
  // requisição; quando não vier, é melhor omitir do que mandar mentira.
  if (ip) corpo.ip = ip

  /*
   * De qual anúncio a pessoa veio, gravado DENTRO do pedido, no gateway.
   * É o que faltava: antes isso morava num arquivo nosso que se apagava
   * sozinho em 15 dias, e quando foi preciso saber de onde veio a venda o
   * dado já não existia mais. Aqui ele vive enquanto o pedido existir.
   */
  if (origem && (origem.camp || origem.src)) {
    corpo.tracking = {}
    if (origem.src) corpo.tracking.utm_source = String(origem.src).slice(0, 100)
    if (origem.med) corpo.tracking.utm_medium = String(origem.med).slice(0, 100)
    if (origem.camp) corpo.tracking.utm_campaign = String(origem.camp).slice(0, 100)
    if (origem.anuncio) corpo.tracking.utm_content = String(origem.anuncio).slice(0, 100)
  }

  const dados = await chamar('/v1/customers', corpo)
  const id = dados?.data?.customer?.id
  if (!id) throw new ErroDeGateway('Appmax não devolveu o id do cliente')
  return id
}

async function criarPedido(customerId, pedido) {
  const produtos = centavos(pedido.subtotal)
  const dados = await chamar('/v1/orders', {
    customer_id: customerId,
    products_value: produtos,
    discount_value: 0,
    shipping_value: centavos(pedido.frete),
    products: [
      {
        sku: `kit-${pedido.kitId}`,
        name: pedido.descricao,
        quantity: 1,
        unit_value: produtos,
        type: 'physical',
      },
    ],
  })
  const id = dados?.data?.order?.id
  if (!id) throw new ErroDeGateway('Appmax não devolveu o id do pedido')
  return id
}

export async function criarCobranca({ pedido, cliente, referencia, origem, ip }) {
  if (pedido.metodo !== 'pix') {
    /*
     * Cartão na Appmax exige tokenizar o número no navegador antes
     * (POST /v1/payments/tokenize), porque o dado do cartão não pode
     * passar pelo nosso servidor. É outra mudança, no checkout, e ainda
     * não foi feita. Falhar com uma frase clara é melhor que gerar uma
     * cobrança quebrada e o cliente descobrir no meio do pagamento.
     */
    throw new ErroDeGateway(
      'No momento este pedido só pode ser pago no Pix. Escolha Pix para continuar.',
      400,
    )
  }

  const customerId = await criarCliente(cliente, origem, ip)
  const orderId = await criarPedido(customerId, pedido)

  const dados = await chamar('/v1/payments/pix', {
    order_id: orderId,
    payment_data: { pix: { document_number: soDigitos(cliente.cpf) } },
  })

  const pagamento = dados?.data?.payment || {}
  const payload = pagamento.pix_emv || ''
  if (!payload) {
    throw new ErroDeGateway('Não foi possível gerar o código do Pix. Tente de novo em instantes.')
  }

  return {
    id: String(orderId),
    metodo: 'pix',
    total: pedido.total,
    redirectUrl: null,
    // O QR vem em base64 puro, sem o "data:image/png;base64,". Quem monta
    // a tag <img> no checkout é quem acrescenta o prefixo, igual ao Asaas.
    pix: { payload, qrBase64: pagamento.pix_qrcode || '' },
  }
}
