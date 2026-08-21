/**
 * POST /api/webhook-asaas
 *
 * O Asaas chama esta função quando o status de uma cobrança muda. É aqui
 * que a venda vira real: até o pagamento confirmar, um Pix gerado é só
 * uma intenção.
 *
 * Cadastre a URL em: Asaas > Integrações > Webhooks
 *   URL    https://aquieteagora.com.br/api/webhook-asaas
 *   Token  o mesmo valor de ASAAS_WEBHOOK_TOKEN
 *
 * Responde 200 mesmo quando o e-mail ou o Meta falham. Devolver erro faz
 * o Asaas reenviar o evento em fila, e aí o cliente recebe a confirmação
 * várias vezes por causa de um problema que não é dele.
 */

import { timingSafeEqual } from 'node:crypto'

import { buscarCliente } from './_lib/gateways/asaas.mjs'
import { enviar, htmlConfirmacao, htmlVenda } from './_lib/email.mjs'
import { enviarCompra } from './_lib/meta-capi.mjs'

const json = (dados, status = 200) =>
  new Response(JSON.stringify(dados), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  })

/**
 * CONFIRMED e RECEIVED sao dois estagios do MESMO pagamento: confirmado
 * e "o cliente pagou", recebido e "o dinheiro esta disponivel". Tratar
 * os dois como pago mandaria dois e-mails do mesmo pedido.
 *
 * A regra abaixo garante exatamente um por pedido, sem precisar guardar
 * estado em lugar nenhum:
 *   cartao  -> vale o CONFIRMED, que chega na hora da compra
 *              (o RECEIVED do cartao so vem no repasse, semanas depois)
 *   demais  -> vale o RECEIVED, que no Pix e imediato
 */
function ehAVezDesteEvento(evento, tipoCobranca) {
  const cartao = String(tipoCobranca ?? '').toUpperCase().includes('CREDIT_CARD')
  return cartao ? evento === 'PAYMENT_CONFIRMED' : evento === 'PAYMENT_RECEIVED'
}

/** Comparação em tempo constante: `===` vaza o tamanho do prefixo certo. */
function mesmoToken(recebido, esperado) {
  const a = Buffer.from(String(recebido ?? ''))
  const b = Buffer.from(esperado)
  return a.length === b.length && timingSafeEqual(a, b)
}

/** "Aquiete — 2 unidades" -> 2 */
function unidadesDe(descricao) {
  const n = /(\d+)\s*unidade/i.exec(String(descricao ?? ''))
  return n ? Number(n[1]) : 1
}

export default async (req) => {
  if (req.method !== 'POST') return json({ erro: 'Use POST' }, 405)

  // Autenticidade. Sem isso qualquer um posta um "pagamento aprovado" e
  // dispara e-mail de confirmação e conversão falsa no Meta.
  //
  // Falha FECHADA de propósito: se o token não estiver configurado, o
  // webhook recusa tudo. Processar evento não autenticado é pior do que
  // não processar — melhor o pagamento esperar do que a loja acreditar
  // numa venda que não existiu.
  const esperado = process.env.ASAAS_WEBHOOK_TOKEN
  if (!esperado) {
    console.error('[webhook] ASAAS_WEBHOOK_TOKEN não configurado — recusando')
    return json({ erro: 'webhook não configurado' }, 503)
  }
  if (!mesmoToken(req.headers.get('asaas-access-token'), esperado)) {
    console.warn('[webhook] token inválido')
    return json({ erro: 'não autorizado' }, 401)
  }

  let corpo
  try { corpo = await req.json() } catch { return json({ erro: 'json inválido' }, 400) }

  const evento = corpo?.event
  const pgto = corpo?.payment
  if (!evento || !pgto) return json({ ok: true, ignorado: 'sem evento' })

  if (!ehAVezDesteEvento(evento, pgto.billingType)) {
    console.log('[webhook] ignorado:', evento, pgto.billingType, pgto.id)
    return json({ ok: true, ignorado: evento })
  }

  const referencia = pgto.externalReference || pgto.id
  const total = Number(pgto.value)
  const descricao = pgto.description || 'Aquiete'
  const unidades = unidadesDe(descricao)

  console.log('[webhook] pagamento confirmado', referencia, total)

  // Cada etapa é isolada: falha em uma não impede as outras nem o 200.
  let cliente = null
  try {
    const c = await buscarCliente(pgto.customer)
    cliente = {
      nome: c.name,
      email: c.email,
      telefone: c.mobilePhone || c.phone || '',
      cidade: c.city || c.cityName || '',
      cep: c.postalCode || '',
      endereco: [c.address, c.addressNumber, c.complement, c.province, c.postalCode]
        .filter(Boolean).join(', '),
    }
  } catch (e) {
    console.error('[webhook] não consegui buscar o cliente:', e.message)
  }

  const resultados = {}

  if (cliente?.email) {
    try {
      resultados.emailCliente = await enviar({
        para: cliente.email,
        assunto: `Pagamento confirmado — pedido ${referencia}`,
        html: htmlConfirmacao({ nome: cliente.nome, referencia, descricao, total }),
      })
    } catch (e) {
      console.error('[webhook] e-mail do cliente falhou:', e.message)
      resultados.emailCliente = { enviado: false, erro: e.message }
    }
  }

  const lojista = process.env.EMAIL_LOJISTA
  if (lojista && cliente) {
    try {
      resultados.emailLojista = await enviar({
        para: lojista,
        assunto: `Venda ${referencia} — R$ ${total.toFixed(2).replace('.', ',')}`,
        html: htmlVenda({ referencia, descricao, total, cliente }),
      })
    } catch (e) {
      console.error('[webhook] aviso de venda falhou:', e.message)
    }
  }

  if (cliente) {
    try {
      resultados.meta = await enviarCompra({
        referencia, total, cliente,
        kitId: unidades, unidades,
      })
    } catch (e) {
      console.error('[webhook] CAPI do Meta falhou:', e.message)
      resultados.meta = { enviado: false, erro: e.message }
    }
  }

  return json({ ok: true, referencia, ...resultados })
}

export const config = { path: '/api/webhook-asaas' }
