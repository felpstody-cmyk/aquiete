/**
 * Roda de 4 em 4 horas, agendada pelo Netlify (não tem URL pública).
 *
 * Manda um resumo de "como tá o dia" pro celular, puxando os mesmos
 * dados que o sistema usa (reaproveita o /api/admin-dados em vez de
 * duplicar a lógica de falar com o Asaas).
 */

import { notificarResumo, push } from './_lib/notificar.mjs'
import { diaBR } from './_lib/metricas.mjs'

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

    const hoje = diaBR()
    const pedidosHoje = (dados.pedidos || []).filter((p) => p.pagoEm === hoje && p.status === 'Pago')
    const total = pedidosHoje.reduce((s, p) => s + (Number(p.valor) || 0), 0)
    const metricas = dados.metricas || {}

    await notificarResumo({
      vendas: pedidosHoje.length,
      total,
      visitas: Number(metricas['visita:' + hoje]) || 0,
      checkouts: Number(metricas['checkout:' + hoje]) || 0,
      carrinhos: Number(metricas['carrinho:' + hoje]) || 0,
      abandonados: (dados.abandonados || []).length,
      online: (dados.ativos || []).filter((a) => !a.pais || a.pais === 'BR').length,
    })
  } catch (e) {
    console.error('[resumo-dia]', e.message)
    // Antes: dava erro e não mandava nada — parecia "notificação sumida"
    // sem nenhuma pista de por quê. Agora sempre chega alguma coisa.
    await push('⚠️ Não consegui puxar os dados agora (' + e.message + '). Sem resumo desse horário.', 'Aquiete — deu ruim no resumo')
  }

  return new Response('ok')
}

// Netlify roda o cron em UTC. De 2 em 2h, das 8h à 22h de Brasília
// (UTC-3): 8/10/12/14/16/18/20/22h vira 11/13/15/17/19/21/23/1h em UTC —
// mais notificação ao longo do dia, sem pingar de madrugada à toa.
export const config = { schedule: '0 11,13,15,17,19,21,23,1 * * *' }
