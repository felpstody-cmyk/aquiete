/**
 * GET /api/status-pedido?ref=AQ-260922-ABC12
 *
 * Diz se o pagamento daquele pedido já caiu. Quem pergunta é a própria
 * tela do Pix, de poucos em poucos segundos, enquanto o QR está aberto.
 *
 * Existe por um motivo só: disparar a conversão de VENDA PAGA no exato
 * momento em que o dinheiro entra. A conversão que já existia dispara
 * quando o Pix é gerado, e isso conta gente que nunca pagou.
 *
 * Devolve apenas "pago: true/false". Nada de dado de cliente: este
 * endereço é público e a referência do pedido viaja pela URL.
 */

import { situacaoDoPedido } from './_lib/gateways/asaas.mjs'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
}

const json = (dados, status = 200) =>
  new Response(JSON.stringify(dados), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...CORS },
  })

export default async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS })

  const ref = new URL(req.url).searchParams.get('ref') || ''
  // Formato da referência: AQ-AAMMDD-XXXXX. Recusar o resto evita virar
  // um consultador genérico da API do Asaas.
  if (!/^AQ-\d{6}-[A-Z0-9]{5}$/.test(ref)) return json({ pago: false, erro: 'referência inválida' }, 400)

  try {
    const s = await situacaoDoPedido(ref)
    return json({ pago: !!s.pago })
  } catch (e) {
    console.error('[status-pedido]', e.message)
    // Falha de consulta nunca pode quebrar a tela do Pix.
    return json({ pago: false })
  }
}

export const config = { path: '/api/status-pedido' }
