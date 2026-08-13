/**
 * Adaptador Pagar.me — ESQUELETO, ainda não implementado.
 *
 * Existe para provar que a troca de gateway é só um arquivo:
 * implemente criarCobranca() devolvendo o formato do contrato
 * (ver index.mjs) e mude GATEWAY=pagarme no Netlify. Nada além
 * disso precisa mudar — nem o checkout, nem a função.
 *
 * Env: PAGARME_SECRET_KEY
 * Docs: https://docs.pagar.me/reference/criar-pedido
 */

import { ErroDeGateway } from './index.mjs'

export const nome = 'pagarme'

export async function criarCobranca({ pedido, cliente, referencia }) {
  throw new ErroDeGateway('Adaptador Pagar.me ainda não implementado', 501)

  /* Esboço da chamada, para quando for a hora:

  const chave = process.env.PAGARME_SECRET_KEY
  const auth = 'Basic ' + Buffer.from(chave + ':').toString('base64')

  const r = await fetch('https://api.pagar.me/core/v5/orders', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: auth },
    body: JSON.stringify({
      code: referencia,
      items: [{
        amount: Math.round(pedido.total * 100),   // Pagar.me trabalha em centavos
        description: pedido.descricao,
        quantity: 1,
      }],
      customer: {
        name: cliente.nome,
        email: cliente.email,
        document: cliente.cpf,
        type: 'individual',
      },
      payments: [{ payment_method: pedido.metodo === 'pix' ? 'pix' : 'checkout' }],
    }),
  })

  const o = await r.json()
  if (!r.ok) throw new ErroDeGateway(`Pagar.me ${r.status}`)

  return {
    id: o.id,
    metodo: pedido.metodo,
    total: pedido.total,
    redirectUrl: o.checkouts?.[0]?.payment_url ?? null,
    pix: o.charges?.[0]?.last_transaction?.qr_code
      ? { payload: o.charges[0].last_transaction.qr_code, qrBase64: null }
      : null,
  }
  */
}
