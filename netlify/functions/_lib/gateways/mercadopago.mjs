/**
 * Adaptador Mercado Pago — ESQUELETO, ainda não implementado.
 *
 * Implemente criarCobranca() no formato do contrato (ver index.mjs)
 * e mude GATEWAY=mercadopago no Netlify.
 *
 * Env: MERCADOPAGO_ACCESS_TOKEN
 * Docs: https://www.mercadopago.com.br/developers/pt/reference
 */

import { ErroDeGateway } from './index.mjs'

export const nome = 'mercadopago'

export async function criarCobranca({ pedido, cliente, referencia }) {
  throw new ErroDeGateway('Adaptador Mercado Pago ainda não implementado', 501)

  /* Esboço, via Preference (Checkout Pro):

  const token = process.env.MERCADOPAGO_ACCESS_TOKEN

  const r = await fetch('https://api.mercadopago.com/checkout/preferences', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      external_reference: referencia,
      items: [{
        title: pedido.descricao,
        quantity: 1,
        unit_price: pedido.total,
        currency_id: 'BRL',
      }],
      payer: {
        name: cliente.nome,
        email: cliente.email,
        identification: { type: 'CPF', number: cliente.cpf },
      },
    }),
  })

  const p = await r.json()
  if (!r.ok) throw new ErroDeGateway(`Mercado Pago ${r.status}`)

  return {
    id: p.id,
    metodo: pedido.metodo,
    total: pedido.total,
    redirectUrl: p.init_point,
    pix: null,
  }
  */
}
