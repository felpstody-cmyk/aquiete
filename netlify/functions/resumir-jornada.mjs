/**
 * Roda de madrugada, agendada pelo Netlify (não tem URL pública).
 *
 * Fecha o dia anterior: lê as sessões de comportamento daquele dia e
 * guarda UM registro pequeno com os números. O bruto continua lá pra
 * sempre — o resumo existe porque ler milhares de sessões a cada
 * sincronização é o que derrubava a função (504 em 24/09/2026).
 *
 * É com esses resumos que o painel mostra o histórico desde a abertura
 * da loja sem custo de leitura.
 *
 * Refaz também os dois dias anteriores: sessão que atravessa a meia-noite
 * e aviso que chega atrasado podem mexer no número depois que o dia
 * fechou, e reescrever é barato.
 */

import { resumirDia } from './_lib/jornada.mjs'
import { diaBR } from './_lib/metricas.mjs'

export default async () => {
  const feitos = []
  for (let i = 1; i <= 3; i++) {
    const dia = diaBR(new Date(Date.now() - i * 24 * 3600 * 1000))
    const r = await resumirDia(dia).catch(() => null)
    if (r) feitos.push({ dia: r.dia, sessoes: r.sessoes, checkouts: r.checkouts })
  }
  return new Response(JSON.stringify({ ok: true, feitos }), {
    headers: { 'Content-Type': 'application/json' },
  })
}

// 04:10 de Brasília (07:10 UTC) — depois que o dia virou e antes de
// qualquer movimento, então não disputa recurso com visita de cliente.
export const config = { schedule: '10 7 * * *' }
