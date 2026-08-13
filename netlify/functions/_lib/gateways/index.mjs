/**
 * Seletor de gateway.
 *
 * TROCAR DE GATEWAY = mudar a variável GATEWAY no painel do Netlify.
 * Nada mais no código precisa ser tocado — nem o checkout, nem a função.
 *
 * ------------------------------------------------------------------
 *  CONTRATO QUE TODO ADAPTADOR PRECISA CUMPRIR
 * ------------------------------------------------------------------
 *  export const nome = 'asaas'
 *
 *  export async function criarCobranca({ pedido, cliente, referencia })
 *
 *    pedido    { kitId, metodo, descricao, subtotal, frete, total }
 *    cliente   { nome, cpf, email, telefone, cep, rua, numero,
 *                complemento, bairro, cidade }
 *    referencia  string única do pedido (vai para o extrato)
 *
 *  Precisa devolver SEMPRE este formato, seja qual for o gateway:
 *
 *    {
 *      id:          string,               // id da cobrança no gateway
 *      metodo:      'pix'|'card'|'boleto',
 *      total:       number,
 *      redirectUrl: string | null,        // página de pagamento, se houver
 *      pix:         { payload, qrBase64 } | null,
 *    }
 *
 *  Erros: lance ErroDeGateway(mensagem, status).
 * ------------------------------------------------------------------
 */

import * as asaas from './asaas.mjs'
import * as pagarme from './pagarme.mjs'
import * as mercadopago from './mercadopago.mjs'

const ADAPTADORES = { asaas, pagarme, mercadopago }

export function obterGateway() {
  const escolhido = (process.env.GATEWAY || 'asaas').toLowerCase()
  const adaptador = ADAPTADORES[escolhido]
  if (!adaptador) {
    throw new ErroDeGateway(
      `GATEWAY="${escolhido}" não existe. Disponíveis: ${Object.keys(ADAPTADORES).join(', ')}`,
      500,
    )
  }
  return adaptador
}

export class ErroDeGateway extends Error {
  constructor(msg, status = 502) { super(msg); this.name = 'ErroDeGateway'; this.status = status }
}
