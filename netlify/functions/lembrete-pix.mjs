/**
 * Roda de 5 em 5 minutos, agendada pelo Netlify (não tem URL pública).
 *
 * Chama de volta quem gerou o Pix e não pagou. São DOIS toques, e só:
 *
 *   5 min    "ainda dá X minutos pra pagar" + o código de novo
 *   31 min   "o código venceu" + o link pra refazer o pedido
 *
 * Depois disso quem conversa é o carrinho abandonado: o código morreu de
 * verdade, a pessoa virou carrinho de novo, e é lá que mora o cupom.
 *
 * ---------------------------------------------------------------
 * Esta função NÃO varre mais o Asaas.
 *
 * O Pix agora é um QR Code estático, que não cria cobrança até alguém
 * pagar — então não existe `/payments?status=PENDING` pra varrer. A fonte
 * virou o nosso próprio registro, `_lib/pixqr.mjs`.
 *
 * O ganho não é só esse. O relógio passou a ser nosso. A versão anterior
 * lia `dateCreated` do Asaas, que vem só com a data e sem hora: em
 * 02/11/2026 isso fez uma cliente levar os quatro toques da sequência em
 * treze minutos, às 6h30 da manhã, depois de ela já ter respondido. Aqui
 * o horário é gravado em milissegundos na hora em que o Pix nasce.
 * ---------------------------------------------------------------
 *
 * Quem pagou não recebe nada. Duas redes: a marca que o webhook escreve
 * no registro do QR no instante do pagamento, e a consulta de pagantes
 * por e-mail E por telefone, que pega quem pagou por outro cadastro. A
 * janela inteira é de 31 minutos, então a exposição é curta — a versão
 * antiga perseguia a pessoa por 20 horas.
 */

import { pixPendentes, avancarToquePix } from './_lib/pixqr.mjs'
import { jaPagou } from './_lib/pagantes.mjs'
import { registrarZap } from './_lib/zaplog.mjs'
import {
  enviarZap, textoPixAindaDaTempo, textoPixVenceu, textoPixCodigo, pausa,
} from './_lib/zap.mjs'

/*
 * Os dois toques, em minutos desde o Pix nascer.
 *
 * O segundo é 31 e não 30 de propósito: o código expira aos 30, e um
 * minuto de folga garante que a mensagem "venceu" não chegue antes de ele
 * ter vencido mesmo. Com a varredura de 5 em 5 minutos, ela cai entre 31
 * e 36 minutos.
 */
const TOQUES = [
  { aos: 5,  zap: textoPixAindaDaTempo, codigo: true,  rotulo: 'pix 5min' },
  { aos: 31, zap: textoPixVenceu,       codigo: false, rotulo: 'pix venceu' },
]

/** Passado disto não se fala mais: o carrinho abandonado assume. */
const LIMITE_MINUTOS = 3 * 60

export default async () => {
  let enviados = 0

  try {
    const agora = Date.now()
    const pendentes = await pixPendentes()

    for (const p of pendentes) {
      const toque = Number(p.toque) || 0
      if (toque >= TOQUES.length) continue

      const minutos = (agora - Number(p.criadoEm || 0)) / 60_000
      if (minutos > LIMITE_MINUTOS) continue

      const agenda = TOQUES[toque]
      if (minutos < agenda.aos) continue

      // Pagou por outro cadastro, ou o webhook não achou este QR: a
      // pergunta aqui é pela PESSOA, por e-mail e por telefone.
      const pagante = await jaPagou({
        email: p.email,
        telefone: p.telefone,
        desde: Number(p.criadoEm) || 0,
      })
      if (pagante) {
        console.log('[lembrete-pix] %s nao cobrado: pagou no pedido %s', p.referencia, pagante.referencia)
        await avancarToquePix(p.id, TOQUES.length)
        continue
      }

      if (!p.telefone) {
        // Sem telefone não há o que mandar daqui. Avança assim mesmo pra
        // não ficar reavaliando este registro a cada cinco minutos.
        await avancarToquePix(p.id, toque)
        continue
      }

      // A marca vai ANTES do envio, de propósito. Quando ela ficava
      // depois, envio que falhava deixava o registro na mesma etapa e a
      // mensagem saía de novo a cada varredura, pra sempre.
      await avancarToquePix(p.id, toque)
      enviados++

      // Quanto ainda falta pro código morrer. Vai pra dentro do texto: é
      // a única urgência honesta que a loja tem, porque está escrita no
      // próprio QR.
      const faltam = Number(p.expiraEm) ? (Number(p.expiraEm) - agora) / 60_000 : 0

      const r = await enviarZap({
        telefone: p.telefone,
        texto: agenda.zap({
          nome: p.nome, total: p.total, kit: p.kit, minutos: faltam,
        }),
      }).catch((e) => ({ enviado: false, erro: String(e?.message || e) }))

      await registrarZap({
        referencia: p.referencia || '',
        nome: p.nome,
        telefone: p.telefone,
        etapa: agenda.rotulo,
        resultado: r,
      })

      /*
       * O copia-e-cola vai sozinho na mensagem seguinte: no WhatsApp,
       * copiar uma mensagem copia o texto inteiro dela, e o banco recusa
       * o código colado junto com a conversa.
       *
       * Só no primeiro toque. No segundo o código já venceu, e mandar
       * seria pedir pra pessoa tentar pagar uma coisa que vai ser
       * recusada.
       */
      if (agenda.codigo && p.payload) {
        await pausa(2500)
        await enviarZap({ telefone: p.telefone, texto: textoPixCodigo(p.payload) }).catch(() => {})
      }
    }
  } catch (e) {
    console.error('[lembrete-pix]', e.message)
  }

  return new Response(JSON.stringify({ ok: true, enviados }), {
    headers: { 'Content-Type': 'application/json' },
  })
}

export const config = { schedule: '*/5 * * * *' }
