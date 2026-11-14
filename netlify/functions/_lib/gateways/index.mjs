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
 *  export async function criarCobranca({ pedido, cliente, referencia,
 *                                        ip, cartao, parcelas })
 *
 *    pedido    { kitId, metodo, descricao, subtotal, frete, total }
 *    cliente   { nome, cpf, email, telefone, cep, rua, numero,
 *                complemento, bairro, cidade }
 *    referencia  string única do pedido (vai para o extrato)
 *    ip        IP de QUEM COMPRA (antifraude). Nunca o do servidor.
 *    cartao    { numero, nome, validade, cvv } | null — só existe no
 *              cartão transparente. É de passagem: não pode ser
 *              guardado, logado nem repassado a mais ninguém.
 *    parcelas  number — quantas vezes no cartão. 1 quando não se aplica.
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
 *  Quando o gateway cobrou o cartão na hora, acrescenta:
 *
 *    {
 *      transparente: true,
 *      parcelas:     number,
 *      pago:         boolean,             // dinheiro dentro AGORA
 *      status:       string,              // status cru do gateway
 *      desafio3ds:   string | null,       // URL do banco, se exigido
 *    }
 *
 *  Nesse caso `redirectUrl` TEM que vir null: a venda já aconteceu, e
 *  mandar a pessoa pra página do gateway desfaria o motivo de existir
 *  do checkout transparente.
 *
 *  Opcional, e só o Asaas tem hoje:
 *
 *    export async function simularParcelas(valor, ate)
 *
 *  Devolve as opções de parcela COMO O GATEWAY AS CALCULA. Existe pra
 *  tabela de parcelas nunca ser calculada por nós — ver parcelas.mjs.
 *
 *  Erros: lance ErroDeGateway(mensagem, status).
 * ------------------------------------------------------------------
 */

import * as appmax from './appmax.mjs'
import * as asaas from './asaas.mjs'
import * as pagarme from './pagarme.mjs'
import * as mercadopago from './mercadopago.mjs'

const ADAPTADORES = { appmax, asaas, pagarme, mercadopago }

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

/**
 * Ate quantas vezes o cartao pode ser parcelado.
 *
 * NAO e preferencia de tela: e caixa. No parcelado o Asaas libera parcela
 * por parcela, uma por mes. Uma venda de R$ 129,90 em 12x entrega R$ 10,82
 * por mes durante um ano — o frasco sai hoje e o dinheiro chega ate
 * novembro do ano que vem. Com o estoque e a midia pagos a vista, isso
 * quebra o caixa mesmo com a venda indo bem.
 *
 * Em 2x o atraso e de um mes e meio, que e pouco.
 *
 * O teto vale no SERVIDOR, nao so no seletor: o checkout manda o numero
 * de parcelas e esse numero nao pode ser confiado.
 */
export const MAX_PARCELAS = 2

export class ErroDeGateway extends Error {
  constructor(msg, status = 502) { super(msg); this.name = 'ErroDeGateway'; this.status = status }
}
