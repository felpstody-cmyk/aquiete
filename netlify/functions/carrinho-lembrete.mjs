/**
 * Roda de hora em hora, agendada pelo Netlify (não tem URL pública).
 *
 * Sequência de 3 toques (2h / 1 dia / 3 dias) — cada carrinho avança uma
 * etapa por vez e a sequência para sozinha depois do terceiro e-mail.
 * Nunca fica mandando pra sempre.
 */

import { carrinhosPendentesDeEmail, marcarEmailCarrinho } from './_lib/metricas.mjs'
import { enviar, htmlRecuperarCarrinho } from './_lib/email.mjs'

const ASSUNTOS = [
  'Ainda dá tempo — seu pedido te espera',
  'Seu carrinho ainda está aberto',
  'Última vez que avisamos sobre esse pedido',
]

export default async () => {
  let enviados = 0

  try {
    const pendentes = await carrinhosPendentesDeEmail()

    for (const c of pendentes) {
      try {
        await enviar({
          para: c.email,
          assunto: ASSUNTOS[Math.min(c.etapa, ASSUNTOS.length - 1)],
          html: htmlRecuperarCarrinho({ nome: c.nome, kit: c.kit, etapa: c.etapa }),
        })
        await marcarEmailCarrinho(c.email, c.etapa)
        enviados++
      } catch (e) {
        console.error('[carrinho-lembrete] falhou para', c.email, e.message)
      }
    }
  } catch (e) {
    console.error('[carrinho-lembrete]', e.message)
  }

  return new Response(JSON.stringify({ ok: true, enviados }), {
    headers: { 'Content-Type': 'application/json' },
  })
}

export const config = { schedule: '@hourly' }
