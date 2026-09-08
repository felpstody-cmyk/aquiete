/**
 * Roda de hora em hora, agendada pelo Netlify (não tem URL pública).
 *
 * Manda o e-mail de recuperação pra quem abandonou o carrinho há pelo
 * menos 2 horas e ainda não recebeu esse e-mail. Um por carrinho —
 * marcado no Blobs (carrinhosPendentesDeEmail / marcarEmailCarrinho em
 * _lib/metricas.mjs), sem isso reenviaria a cada hora.
 */

import { carrinhosPendentesDeEmail, marcarEmailCarrinho } from './_lib/metricas.mjs'
import { enviar, htmlRecuperarCarrinho } from './_lib/email.mjs'

export default async () => {
  let enviados = 0

  try {
    const pendentes = await carrinhosPendentesDeEmail()

    for (const c of pendentes) {
      try {
        await enviar({
          para: c.email,
          assunto: 'Ainda dá tempo — seu pedido te espera',
          html: htmlRecuperarCarrinho({ nome: c.nome, kit: c.kit }),
        })
        await marcarEmailCarrinho(c.email)
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
