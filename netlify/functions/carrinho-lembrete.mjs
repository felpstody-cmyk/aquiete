/**
 * Roda de hora em hora, agendada pelo Netlify (não tem URL pública).
 *
 * Sequência de 3 toques (2h / 1 dia / 3 dias) — cada carrinho avança uma
 * etapa por vez e a sequência para sozinha depois do terceiro e-mail.
 * Nunca fica mandando pra sempre.
 */

import {
  carrinhosPendentesDeEmail, marcarEmailCarrinho, marcarCarrinhoPago,
} from './_lib/metricas.mjs'
import { enviar, htmlRecuperarCarrinho } from './_lib/email.mjs'
import { enviarZap, textoCarrinhoParado } from './_lib/zap.mjs'
import { registrarZap } from './_lib/zaplog.mjs'
import { jaPagou } from './_lib/pagantes.mjs'

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
      // Pagou depois deste carrinho começar: a sequência morre aqui.
      // A lista já exclui quem tem `pago` no carrinho, mas essa marca
      // depende de o webhook ter achado o carrinho pelo e-mail — e o
      // e-mail do Asaas pode não ser o mesmo que a pessoa digitou. Aqui a
      // pergunta é pela PESSOA, pelo e-mail e pelo telefone.
      const pagante = await jaPagou({ email: c.email, telefone: c.telefone, desde: c.desde })
      if (pagante) {
        console.log('[carrinho-lembrete] %s não cobrado: pagou no pedido %s', c.email, pagante.referencia)
        await marcarCarrinhoPago({ email: c.email }).catch(() => {})
        continue
      }

      // Zap só no primeiro toque. O e-mail insiste três vezes porque
      // e-mail se ignora sem custo; WhatsApp insistente irrita a pessoa
      // e ainda aumenta a chance de alguém denunciar o número.
      // A etapa avança ANTES de qualquer envio, e de propósito. Antes ela
      // só avançava depois do e-mail dar certo, dentro do try: e-mail que
      // falha deixava o carrinho preso na etapa 0 — justo a que manda
      // WhatsApp — e o zap saía de novo a cada hora, pra sempre.
      await marcarEmailCarrinho(c.email, c.etapa)

      if (c.etapa === 0 && c.telefone) {
        // Registra igual ao criar-pedido. Sem isto o envio era invisivel:
        // o carrinho avancava de etapa e nao havia como saber se a
        // mensagem saiu, falhou, ou sequer foi tentada.
        const r = await enviarZap({
          telefone: c.telefone,
          texto: textoCarrinhoParado({ nome: c.nome }),
        }).catch((e) => ({ enviado: false, erro: String(e?.message || e) }))
        await registrarZap({
          referencia: '', nome: c.nome, telefone: c.telefone,
          etapa: 'carrinho parado', resultado: r,
        })
      }

      try {
        await enviar({
          para: c.email,
          assunto: ASSUNTOS[Math.min(c.etapa, ASSUNTOS.length - 1)],
          html: htmlRecuperarCarrinho({ nome: c.nome, kit: c.kit, etapa: c.etapa }),
        })
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
