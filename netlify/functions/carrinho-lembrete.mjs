/**
 * Roda de 5 em 5 minutos, agendada pelo Netlify (não tem URL pública).
 *
 * Sequência de 3 toques (5 min / 3 horas / no dia seguinte) — cada
 * carrinho avança uma etapa por vez e a sequência para sozinha depois do
 * terceiro. Nunca fica mandando pra sempre.
 *
 * Os três mandam zap, e cada um com texto PRÓPRIO. Antes só o primeiro
 * mandava, justamente pra não repetir; agora são três mensagens
 * diferentes, que é o que torna três aceitável. Mensagem repetida é o que
 * faz a pessoa ler "robô" e bloquear o número.
 *
 * Os 5 minutos do primeiro toque dependem desta função acordar junto: com
 * o `@hourly` de antes, a etapa podia vencer às 10h01 e a mensagem sair
 * às 11h. O preço é que a mensagem cai entre 5 e 10 minutos, não em 5
 * cravados — pra apertar mais é só baixar o intervalo aqui embaixo.
 */

import {
  carrinhosPendentesDeEmail, marcarEmailCarrinho, marcarCarrinhoPago, ETAPAS_CARRINHO,
} from './_lib/metricas.mjs'
import { enviar, htmlRecuperarCarrinho } from './_lib/email.mjs'
import {
  enviarZap, textoCarrinhoParado, textoCarrinhoTresHoras, textoCarrinhoCupom,
} from './_lib/zap.mjs'
import { registrarZap } from './_lib/zaplog.mjs'
import { jaPagou } from './_lib/pagantes.mjs'

const ASSUNTOS = [
  'Ainda dá tempo — seu pedido te espera',
  'Seu carrinho ainda está aberto',
  'Seus 10% de desconto na primeira compra',
]

/* Um texto por toque. O primeiro é ditado por ele e fica como está; os
   outros dois são rascunho meu, pra trocar quando ele escrever os dele. */
const TEXTO_ZAP = [textoCarrinhoParado, textoCarrinhoTresHoras, textoCarrinhoCupom]

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

      // A etapa avança ANTES de qualquer envio, e de propósito. Antes ela
      // só avançava depois do e-mail dar certo, dentro do try: e-mail que
      // falha deixava o carrinho preso na etapa 0 — justo a que manda
      // WhatsApp — e o zap saía de novo a cada hora, pra sempre.
      await marcarEmailCarrinho(c.email, c.etapa)

      const montarTexto = TEXTO_ZAP[Math.min(c.etapa, TEXTO_ZAP.length - 1)]
      if (c.telefone && montarTexto) {
        // Registra igual ao criar-pedido. Sem isto o envio era invisivel:
        // o carrinho avancava de etapa e nao havia como saber se a
        // mensagem saiu, falhou, ou sequer foi tentada.
        const r = await enviarZap({
          telefone: c.telefone,
          texto: montarTexto({ nome: c.nome, kit: c.kit }),
        }).catch((e) => ({ enviado: false, erro: String(e?.message || e) }))
        await registrarZap({
          referencia: '', nome: c.nome, telefone: c.telefone,
          // Qual dos tres foi. Sem isso as tres linhas do log ficam
          // iguais e nao da pra ver qual toque traz venda.
          etapa: ['carrinho 5min', 'carrinho 3h', 'carrinho cupom'][c.etapa] || 'carrinho parado',
          resultado: r,
        })
      }

      try {
        await enviar({
          para: c.email,
          assunto: ASSUNTOS[Math.min(c.etapa, ASSUNTOS.length - 1)],
          html: htmlRecuperarCarrinho({
            nome: c.nome, kit: c.kit, etapa: c.etapa,
            // O desconto so no ultimo. Ate aqui o e-mail prometia 10% nos
            // tres e mandava ?cupom=PRIMEIRA10 junto, com o cupom
            // desligado desde 05/10: a oferta era recusada no checkout.
            cupom: c.etapa >= ETAPAS_CARRINHO.length - 1,
          }),
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

export const config = { schedule: '*/5 * * * *' }
