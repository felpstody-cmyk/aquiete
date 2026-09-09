/**
 * Roda de 4 em 4 horas, agendada pelo Netlify (não tem URL pública).
 *
 * Manda um resumo de "como tá o dia" pro celular, puxando os mesmos
 * dados que o sistema usa (reaproveita o /api/admin-dados em vez de
 * duplicar a lógica de falar com o Asaas).
 */

import { notificarResumo } from './_lib/notificar.mjs'

function hojeISO() {
  return new Date().toISOString().slice(0, 10)
}

export default async () => {
  try {
    const token = process.env.ADMIN_TOKEN
    if (!token) {
      console.error('[resumo-dia] ADMIN_TOKEN não configurado')
      return new Response('sem token', { status: 200 })
    }

    const r = await fetch('https://aquieteagora.com.br/api/admin-dados', {
      headers: { 'x-admin-token': token },
    })
    const dados = await r.json()
    if (!r.ok) throw new Error(dados?.erro || `admin-dados ${r.status}`)

    const hoje = hojeISO()
    const pedidosHoje = (dados.pedidos || []).filter((p) => p.pagoEm === hoje && p.status === 'Pago')
    const total = pedidosHoje.reduce((s, p) => s + (Number(p.valor) || 0), 0)
    const metricas = dados.metricas || {}

    await notificarResumo({
      vendas: pedidosHoje.length,
      total,
      visitas: Number(metricas['visita:' + hoje]) || 0,
      checkouts: Number(metricas['checkout:' + hoje]) || 0,
      abandonados: (dados.abandonados || []).length,
    })
  } catch (e) {
    console.error('[resumo-dia]', e.message)
  }

  return new Response('ok')
}

// Netlify roda o cron em UTC. 9h/13h/17h/21h no horário de Brasília
// (UTC-3) vira 12h/16h/20h/00h em UTC — sem pingar de madrugada à toa.
export const config = { schedule: '0 12,16,20,0 * * *' }
