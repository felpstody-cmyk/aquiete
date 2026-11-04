/**
 * POST /api/admin-avisar-pago   (cabeçalho x-admin-token: ADMIN_TOKEN)
 * corpo: { "referencia": "AQ-261104-BFOLA" }
 *
 * Reenvia a confirmação de pagamento de um pedido que já está pago.
 *
 * Existe porque o webhook só passa uma vez. Quando ele deixa de avisar
 * — como em 03 e 04/11/2026, em dois pagamentos por QR estático, onde o
 * Asaas não trouxe telefone nem e-mail — o cliente fica sem notícia e
 * não há como fazer o aviso sair de novo sem pedir pro Asaas reenviar o
 * evento na mão.
 *
 * Não busca nada no gateway. Lê o mesmo registro que a etiqueta usa, que
 * é o que o checkout guardou: ali está quem comprou de verdade, com
 * telefone e e-mail. O titular da conta que pagou o Pix pode ser outra
 * pessoa.
 *
 * Só manda pra pedido que tenha registro guardado. Se não achar, devolve
 * 404 em vez de inventar destinatário.
 */

import { lerDespacho } from './_lib/envio.mjs'
import { enviar, htmlConfirmacao } from './_lib/email.mjs'
import { enviarZap, textoPago } from './_lib/zap.mjs'
import { registrarZap } from './_lib/zaplog.mjs'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type, x-admin-token',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const json = (dados, status = 200) =>
  new Response(JSON.stringify(dados), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...CORS },
  })

export default async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS })
  if (req.method !== 'POST') return json({ erro: 'Use POST' }, 405)

  const esperado = process.env.ADMIN_TOKEN
  if (!esperado) return json({ erro: 'ADMIN_TOKEN não configurado no Netlify' }, 500)
  if (req.headers.get('x-admin-token') !== esperado) return json({ erro: 'Token inválido' }, 401)

  let corpo
  try { corpo = await req.json() } catch { return json({ erro: 'JSON inválido' }, 400) }

  const referencia = String(corpo.referencia ?? '').trim()
  if (!referencia) return json({ erro: 'Faltando a referência do pedido' }, 400)

  const guardado = await lerDespacho(referencia).catch(() => null)
  const c = guardado?.cliente
  if (!c) return json({ erro: `Não achei registro guardado de ${referencia}` }, 404)

  // O total sai do que foi guardado na hora da compra, não de parâmetro:
  // assim o e-mail nunca mostra um valor diferente do que a pessoa pagou.
  const total = Number((Number(guardado.subtotal || 0) + Number(guardado.frete || 0)).toFixed(2))
  const descricao = guardado.descricao || 'Aquiete'

  const zap = c.telefone
    ? await enviarZap({
        telefone: c.telefone,
        texto: textoPago({ nome: c.nome, referencia }),
      }).catch((e) => ({ enviado: false, erro: String(e.message || e) }))
    : { enviado: false, erro: 'sem telefone' }

  await registrarZap({
    referencia,
    nome: c.nome || '',
    telefone: c.telefone || '',
    etapa: 'pagamento confirmado',
    resultado: zap,
  }).catch(() => {})

  let email = { enviado: false, erro: 'sem e-mail' }
  if (c.email) {
    try {
      email = await enviar({
        para: c.email,
        assunto: `Pagamento confirmado — pedido ${referencia}`,
        html: htmlConfirmacao({ nome: c.nome, referencia, descricao, total }),
      })
    } catch (e) {
      email = { enviado: false, erro: String(e.message || e) }
    }
  }

  return json({
    ok: true,
    referencia,
    cliente: { nome: c.nome, telefone: c.telefone, email: c.email },
    unidades: guardado.unidades,
    total,
    zap,
    email,
  })
}

export const config = { path: '/api/admin-avisar-pago' }
