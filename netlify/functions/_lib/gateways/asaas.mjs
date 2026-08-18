/**
 * Adaptador Asaas — https://docs.asaas.com
 *
 * Variáveis de ambiente (painel do Netlify > Site settings > Environment):
 *   ASAAS_API_KEY   chave da API (começa com "$aact_")
 *   ASAAS_AMBIENTE  "sandbox" (padrão) ou "producao"
 *
 * Comece SEMPRE em sandbox. Só troque para produção depois de fazer
 * um pedido de teste inteiro e ver o dinheiro cair.
 */

import { ErroDeGateway } from './index.mjs'

export const nome = 'asaas'

const BASES = {
  sandbox: 'https://api-sandbox.asaas.com/v3',
  producao: 'https://api.asaas.com/v3',
}

/** Asaas usa nomes próprios para as formas de pagamento. */
const BILLING = { pix: 'PIX', card: 'CREDIT_CARD', boleto: 'BOLETO' }

function config() {
  const chave = process.env.ASAAS_API_KEY
  if (!chave) throw new ErroDeGateway('ASAAS_API_KEY não configurada no Netlify', 500)
  const base = BASES[(process.env.ASAAS_AMBIENTE || 'sandbox').toLowerCase()] || BASES.sandbox
  return { chave, base }
}

async function chamar(caminho, opcoes = {}) {
  const { chave, base } = config()
  const resposta = await fetch(base + caminho, {
    ...opcoes,
    headers: {
      'Content-Type': 'application/json',
      access_token: chave,
      ...opcoes.headers,
    },
  })

  const corpo = await resposta.json().catch(() => ({}))
  if (!resposta.ok) {
    const detalhe = corpo?.errors?.[0]?.description || resposta.statusText
    throw new ErroDeGateway(`Asaas ${resposta.status}: ${detalhe}`)
  }
  return corpo
}

/** Reaproveita o cliente pelo CPF em vez de duplicar cadastro a cada compra. */
async function acharOuCriarCliente(cliente) {
  const busca = await chamar(`/customers?cpfCnpj=${cliente.cpf}&limit=1`)
  if (busca?.data?.length) return busca.data[0].id

  const novo = await chamar('/customers', {
    method: 'POST',
    body: JSON.stringify({
      name: cliente.nome,
      cpfCnpj: cliente.cpf,
      email: cliente.email,
      mobilePhone: cliente.telefone,
      postalCode: cliente.cep,
      address: cliente.rua,
      addressNumber: cliente.numero,
      complement: cliente.complemento || null,
      province: cliente.bairro,
      notificationDisabled: false,
    }),
  })
  return novo.id
}

function vencimento(diasAFrente) {
  const d = new Date(Date.now() + diasAFrente * 86400000)
  return d.toISOString().slice(0, 10)
}

export async function criarCobranca({ pedido, cliente, referencia }) {
  const customerId = await acharOuCriarCliente(cliente)

  const cobranca = await chamar('/payments', {
    method: 'POST',
    body: JSON.stringify({
      customer: customerId,
      billingType: BILLING[pedido.metodo],
      value: pedido.total,
      // Pix expira rápido de propósito; boleto precisa de folga bancária
      dueDate: vencimento(pedido.metodo === 'boleto' ? 3 : 1),
      description: pedido.descricao,
      externalReference: referencia,
    }),
  })

  // Pix: buscamos o QR para exibir sem tirar o cliente da página.
  // Uma segunda tentativa cobre o caso de a chave Pix da conta ainda estar
  // sendo provisionada — sem QR o cliente vê erro e abandona a compra.
  let pix = null
  if (pedido.metodo === 'pix') {
    let qr = null
    for (let tentativa = 1; tentativa <= 3; tentativa++) {
      try {
        qr = await chamar(`/payments/${cobranca.id}/pixQrCode`)
        if (qr?.encodedImage) break
      } catch (e) {
        if (tentativa === 3) throw e
      }
      await new Promise((r) => setTimeout(r, 700 * tentativa))
    }
    if (!qr?.encodedImage) {
      throw new ErroDeGateway('Não foi possível gerar o QR do Pix. Tente outro método.')
    }
    pix = { payload: qr.payload, qrBase64: qr.encodedImage }
  }

  return {
    id: cobranca.id,
    metodo: pedido.metodo,
    total: pedido.total,
    // Cartão e boleto vão para a página do Asaas: os dados sensíveis
    // ficam lá, e você não entra no escopo pesado de PCI-DSS
    redirectUrl: pedido.metodo === 'pix'
      ? null
      : (cobranca.bankSlipUrl || cobranca.invoiceUrl || null),
    pix,
  }
}
