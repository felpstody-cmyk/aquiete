/**
 * Roda de hora em hora, agendada pelo Netlify (não tem URL pública).
 *
 * Varre os Pix pendentes no Asaas e manda um lembrete pra quem gerou o
 * código e ainda não pagou. Só um lembrete por cobrança — guardado no
 * Blobs, sem isso reenviaria a cada hora até o Pix expirar.
 *
 * "Ainda não pagou" é a parte difícil, e foi o que deu errado na primeira
 * venda. Quem clica em pagar duas vezes gera DUAS cobranças, paga uma e
 * deixa a outra PENDING pra sempre. Olhar só o status da cobrança faz a
 * loja cobrar quem já pagou — e pior, mandando o código do Pix errado.
 * Por isso aqui tem três travas, nesta ordem:
 *
 *   1. já lembramos desta cobrança  (Blobs)
 *   2. esta pessoa pagou algo depois que esta cobrança nasceu?  (Blobs,
 *      escrito pelo webhook no instante do pagamento)
 *   3. o Asaas tem alguma cobrança paga deste cliente?  (a verdade está
 *      lá, e isto cobre webhook perdido e pagamento anterior ao conserto)
 */

import { enviar, htmlLembretePix } from './_lib/email.mjs'
import { enviarZap, textoLembretePix, textoPixCodigo, pausa } from './_lib/zap.mjs'
import { jaPagou } from './_lib/pagantes.mjs'

const BASES = {
  sandbox: 'https://api-sandbox.asaas.com/v3',
  producao: 'https://api.asaas.com/v3',
}

function credenciais() {
  const chave = process.env.ASAAS_API_KEY
  if (!chave) throw new Error('ASAAS_API_KEY não configurada')
  const base = BASES[(process.env.ASAAS_AMBIENTE || 'producao').toLowerCase()] || BASES.producao
  return { chave, base }
}

async function asaas(caminho) {
  const { chave, base } = credenciais()
  const r = await fetch(base + caminho, {
    headers: { 'Content-Type': 'application/json', access_token: chave },
  })
  const corpo = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(`Asaas ${r.status}: ${corpo?.errors?.[0]?.description || r.statusText}`)
  return corpo
}

async function loja() {
  const { getStore } = await import('@netlify/blobs')
  return getStore('lembretes-pix')
}

// Cedo demais incomoda quem acabou de gerar o Pix; tarde demais e o Pix
// já expirou (vence em 1 dia, ver vencimento() no adaptador do Asaas).
const JANELA_MIN_HORAS = 3
const JANELA_MAX_HORAS = 20

/** Os status do Asaas em que o dinheiro entrou de verdade. */
const STATUS_PAGO = new Set(['RECEIVED', 'CONFIRMED', 'RECEIVED_IN_CASH'])

/**
 * Este cliente pagou alguma cobrança depois desta ser gerada?
 *
 * A segunda rede, e a que não depende de nada nosso: a verdade do
 * pagamento está no Asaas. Uma chamada por lembrete, e são poucos por
 * hora.
 *
 * Devolve `sabe: false` quando a consulta falha. Nesse caso o lembrete
 * não sai E a cobrança não é marcada, pra tentar de novo na próxima hora:
 * mandar no escuro é o erro que esta função existe pra evitar, e marcar
 * no escuro perderia o lembrete pra sempre.
 */
async function pagouOutraCobranca(customerId, desdeMs) {
  try {
    const r = await asaas(`/payments?customer=${encodeURIComponent(customerId)}&limit=100`)
    const pagou = (r.data || []).some((c) => {
      if (!STATUS_PAGO.has(String(c.status || '').toUpperCase())) return false
      const quando = c.paymentDate || c.confirmedDate || c.clientPaymentDate || c.dateCreated
      return new Date(quando).getTime() >= desdeMs
    })
    return { sabe: true, pagou }
  } catch (e) {
    console.error('[lembrete-pix] não deu pra checar os pagamentos do cliente:', e.message)
    return { sabe: false, pagou: false }
  }
}

export default async () => {
  const store = await loja()
  let enviados = 0

  try {
    const pagina = await asaas('/payments?status=PENDING&billingType=PIX&limit=100')
    const agora = Date.now()

    for (const p of pagina.data || []) {
      const criado = new Date(p.dateCreated).getTime()
      const horas = (agora - criado) / 3_600_000
      if (!(horas >= JANELA_MIN_HORAS && horas <= JANELA_MAX_HORAS)) continue

      const jaLembrado = await store.get(p.id)
      if (jaLembrado) continue

      // Trava 3, antes de gastar a busca do cliente: o próprio Asaas diz
      // se esta pessoa já pagou outra cobrança depois desta ser gerada.
      const outra = await pagouOutraCobranca(p.customer, criado)
      if (!outra.sabe) continue
      if (outra.pagou) {
        console.log('[lembrete-pix] %s não cobrado: o cliente já pagou outra cobrança', p.id)
        await store.set(p.id, 'pago')
        continue
      }

      let cliente
      try {
        cliente = await asaas(`/customers/${p.customer}`)
      } catch (e) {
        console.error('[lembrete-pix] cliente não encontrado', p.id, e.message)
        continue
      }
      if (!cliente?.email) continue

      // Trava 2: o registro que o webhook escreve no instante do
      // pagamento. Pega o caso em que a pessoa pagou por outro e-mail ou
      // outro cadastro no Asaas e o cliente desta cobrança não é o mesmo.
      const pagante = await jaPagou({
        email: cliente.email,
        telefone: cliente.mobilePhone || cliente.phone,
        desde: criado,
      })
      if (pagante) {
        console.log('[lembrete-pix] %s não cobrado: pagou no pedido %s', p.id, pagante.referencia)
        await store.set(p.id, 'pago')
        continue
      }

      // A marca vai ANTES dos envios, de propósito. Quando ela ficava
      // depois do e-mail, e-mail que falhava deixava a cobrança sem marca
      // nenhuma e o zap saía de novo a cada hora, pra sempre — foi o que
      // aconteceu com a sequência do carrinho (ver carrinho-lembrete).
      await store.set(p.id, String(Date.now()))
      enviados++

      let payload = null
      try {
        const qr = await asaas(`/payments/${p.id}/pixQrCode`)
        payload = qr?.payload || null
      } catch { /* manda sem o copia-e-cola se o QR não vier */ }

      // Zap antes do e-mail: é onde a pessoa olha. Se falhar, o e-mail
      // ainda sai — os dois juntos, porque não dá pra saber qual ela vê.
      if (cliente.mobilePhone || cliente.phone) {
        const paraZap = cliente.mobilePhone || cliente.phone
        await enviarZap({
          telefone: paraZap,
          texto: textoLembretePix({ nome: cliente.name, total: p.value, payload }),
        }).catch(() => {})
        // Igual ao primeiro toque: o copia-e-cola vai sozinho na mensagem
        // seguinte, senao copiar a mensagem leva a conversa junto.
        // Aqui dá pra esperar de verdade antes de mandar: isto roda de hora
        // em hora, sem ninguem olhando a tela, e duas mensagens coladas sao
        // o que faz o WhatsApp derrubar a sessao.
        if (payload) {
          await pausa(2500)
          await enviarZap({ telefone: paraZap, texto: textoPixCodigo(payload) }).catch(() => {})
        }
      }

      try {
        await enviar({
          para: cliente.email,
          assunto: `Seu Pix do pedido ${p.externalReference || ''} ainda não caiu`,
          html: htmlLembretePix({
            nome: cliente.name,
            referencia: p.externalReference || p.id,
            descricao: p.description || 'Aquiete',
            total: p.value,
            payload,
            link: p.invoiceUrl || null,
          }),
        })
      } catch (e) {
        console.error('[lembrete-pix] envio falhou para', p.id, e.message)
      }
    }
  } catch (e) {
    console.error('[lembrete-pix]', e.message)
  }

  return new Response(JSON.stringify({ ok: true, enviados }), {
    headers: { 'Content-Type': 'application/json' },
  })
}

export const config = { schedule: '@hourly' }
