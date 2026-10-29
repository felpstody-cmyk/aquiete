/**
 * Roda de hora em hora, agendada pelo Netlify (não tem URL pública).
 *
 * Venda paga cujo envio não chegou no Melhor Envio. Quem cria o envio é
 * o webhook, no instante em que o dinheiro cai, e é lá que quase sempre
 * resolve. Mas o webhook tem tempo contado: um Melhor Envio lento, um
 * 500 do lado deles ou a função congelada no meio deixavam a encomenda
 * sem existir, com o cliente já pago e esperando.
 *
 * Esta ronda repesca. É a mesma ideia do zap-vigia: a loja degrada, não
 * emudece.
 */

import { despacharPendentes, despachoConfigurado, faltaNoRemetente } from './_lib/envio.mjs'
import { push, podeNotificar } from './_lib/notificar.mjs'

export default async () => {
  if (!despachoConfigurado()) {
    const falta = faltaNoRemetente()
    // Um aviso por dia, não um por hora: se o remetente está incompleto,
    // toda venda vai deixar de ser despachada e isso tem que doer — mas
    // sem virar enxurrada de push.
    if (falta.length && await podeNotificar('despacho-incompleto', 24 * 60)) {
      await push(
        `⚙️ O despacho automático está parado: falta preencher ${falta.join(', ')} nas variáveis do Netlify.\n\nEnquanto isso, cada venda tem que ser cadastrada na mão no Melhor Envio.`,
        'Aquiete — despacho desligado',
        { tags: 'warning' },
      )
    }
    return new Response(JSON.stringify({ ok: true, desligado: true, falta }), {
      headers: { 'Content-Type': 'application/json' },
    })
  }

  const r = await despacharPendentes().catch((e) => ({ ok: false, motivo: e.message }))

  const criados = (r.feitos || []).filter((f) => f.ok && !f.repetido)
  if (criados.length) {
    await push(
      `📦 ${criados.length} envio(s) que tinham falhado foram criados agora:\n\n` +
        criados.map((f) => `${f.referencia} — ${f.servico || ''}`).join('\n'),
      'Aquiete — envios recuperados',
    ).catch(() => {})
  }

  const travados = (r.feitos || []).filter((f) => !f.ok)
  if (travados.length) console.error('[despachar-pendentes] continuam travados:', JSON.stringify(travados))

  return new Response(JSON.stringify(r), { headers: { 'Content-Type': 'application/json' } })
}

export const config = { schedule: '@hourly' }
