/**
 * Roda de hora em hora, agendada pelo Netlify (não tem URL pública).
 *
 * Varre os Pix pendentes no Asaas e manda um lembrete pra quem gerou o
 * código e ainda não pagou. Só um lembrete por cobrança — guardado no
 * Blobs, sem isso reenviaria a cada hora até o Pix expirar.
 */

import { enviar, htmlLembretePix } from './_lib/email.mjs'

const BASES = {
  sandbox: 'https://api-sandbox.asaas.com/v3',
  producao: 'https://api.asaas.com/v3',
}

function credenciais() {
  const chave = process.env.ASAAS_API_KEY
  if (!chave) throw new Error('ASAAS_API_KEY não configurada')
  const base = BASES[(process.env.ASAAS_AMBIENTE || 'sandbox').toLowerCase()] || BASES.sandbox
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

      let cliente
      try {
        cliente = await asaas(`/customers/${p.customer}`)
      } catch (e) {
        console.error('[lembrete-pix] cliente não encontrado', p.id, e.message)
        continue
      }
      if (!cliente?.email) continue

      let payload = null
      try {
        const qr = await asaas(`/payments/${p.id}/pixQrCode`)
        payload = qr?.payload || null
      } catch { /* manda sem o copia-e-cola se o QR não vier */ }

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
        await store.set(p.id, String(Date.now()))
        enviados++
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
