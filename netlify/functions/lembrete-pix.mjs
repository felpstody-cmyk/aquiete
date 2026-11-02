/**
 * Roda de 5 em 5 minutos, agendada pelo Netlify (não tem URL pública).
 *
 * Varre os Pix pendentes no Asaas e chama de volta quem gerou o código e
 * ainda não pagou. São quatro toques, cada um com texto próprio,
 * espalhados por dois dias:
 *
 *   5 min   o copia-e-cola de novo, sozinho numa mensagem
 *   6 h     entra o cupom de 10% da primeira compra
 *   12 h    o código vence à meia-noite, e isso agora é verdade
 *   24 h    só "estou por aqui" — este NÃO oferece compra
 *
 * Quem cuida dessa pessoa é esta função, e só ela: a sequência do
 * carrinho abandonado para de perseguir quem gerou Pix, justamente pra
 * não mandar duas mensagens na mesma hora sobre o mesmo pedido. Aqui tem
 * o valor, a referência e o copia-e-cola; lá não tem nenhum dos três.
 *
 * O estado de cada cobrança fica no Blobs. Sem isso cada varredura
 * reenviaria tudo de novo até o Pix expirar.
 *
 * "Ainda não pagou" é a parte difícil, e foi o que deu errado na primeira
 * venda. Quem clica em pagar duas vezes gera DUAS cobranças, paga uma e
 * deixa a outra PENDING pra sempre. Olhar só o status da cobrança faz a
 * loja cobrar quem já pagou — e pior, mandando o código do Pix errado.
 * Por isso aqui tem três travas, nesta ordem:
 *
 *   1. já lembramos desta cobrança  (Blobs)
 *   2. esta pessoa pagou algo depois que esta cobrança nasceu?  (Blobs,
 *      escrito pelo webhook no instante do pagamento)
 *   3. o Asaas tem alguma cobrança paga deste cliente?  (a verdade está
 *      lá, e isto cobre webhook perdido e pagamento anterior ao conserto)
 */

import { enviar, htmlLembretePix } from './_lib/email.mjs'
import {
  enviarZap, textoPixCincoMin, textoPixComCupom, textoPixVenceHoje,
  textoPixEstamosAqui, textoPixCodigo, pausa,
} from './_lib/zap.mjs'
import { jaPagou } from './_lib/pagantes.mjs'
import { registrarZap } from './_lib/zaplog.mjs'
import { diaBR } from './_lib/metricas.mjs'

const BASES = {
  sandbox: 'https://api-sandbox.asaas.com/v3',
  producao: 'https://api.asaas.com/v3',
}

function credenciais() {
  const chave = process.env.ASAAS_API_KEY
  if (!chave) throw new Error('ASAAS_API_KEY não configurada')
  const base = BASES[(process.env.ASAAS_AMBIENTE || 'producao').toLowerCase()] || BASES.producao
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

/*
 * Os quatro toques, em minutos desde a cobrança aparecer na varredura.
 *
 * Saiu o de 3h: era repetição do de 5 minutos, e quatro mensagens numa
 * manhã é o que fez uma cliente pedir pra parar em 02/11/2026.
 *
 * `codigo` diz se o copia-e-cola vai junto, numa segunda mensagem.
 * `soHoje` marca o toque que só manda o código enquanto ele vale — depois
 * da meia-noite ele morreu, e mandar seria pedir pra pessoa tentar pagar
 * uma coisa que o banco recusa.
 */
const TOQUES = [
  { minutos: 5,       zap: textoPixCincoMin,    email: false, cupom: false, codigo: true },
  { minutos: 6 * 60,  zap: textoPixComCupom,    email: true,  cupom: true,  codigo: false },
  { minutos: 12 * 60, zap: textoPixVenceHoje,   email: true,  cupom: false, codigo: true, soHoje: true },
  // O último não oferece compra: sem link, sem cupom, sem código.
  { minutos: 24 * 60, zap: textoPixEstamosAqui, email: false, cupom: false, codigo: false },
]

const ASSUNTOS_PIX = [
  '',
  'Seus 10% de desconto na primeira compra',
  'Seu Pix vence hoje à meia-noite',
  '',
]

// Folga em cima do último toque de 24h. Depois disto não se fala mais.
const LIMITE_MINUTOS = 30 * 60

/**
 * Em que toque esta cobrança está, e desde quando conta o relógio.
 *
 * `{ toque: -1 }` quer dizer "já pagou, não mexe mais".
 *
 * O relógio é `visto`, a primeira vez que esta varredura enxergou a
 * cobrança — e NÃO o `dateCreated` do Asaas.
 *
 * Isso não é preciosismo. `dateCreated` vem só com a data, sem hora:
 * `new Date('2026-11-02')` é meia-noite UTC, que em Brasília é 21h do dia
 * anterior. Às 6h30 da manhã a conta dava 570 minutos de vida, e cada
 * rodada do agendador queimava um toque — em 02/11/2026 uma cliente levou
 * os quatro em treze minutos e pediu pra parar. Como isto roda de 5 em 5
 * minutos, `visto` fica a no máximo 5 minutos do nascimento de verdade e
 * não depende do formato de data de ninguém.
 *
 * Cobrança de um dia anterior nasce já marcada como terminada: ela perdeu
 * a janela, e abrir quatro toques em cima de quem gerou Pix ontem é o
 * mesmo erro de novo.
 *
 * Valor antigo é string solta, de quando existia um lembrete só. Também
 * conta como terminada.
 */
async function estadoDe(store, id, dataCriacao) {
  const bruto = await store.get(id)

  if (bruto === 'pago') return { toque: -1, visto: 0 }

  if (!bruto) {
    const deHoje = String(dataCriacao || '').slice(0, 10) === diaBR()
    const novo = { toque: deHoje ? 0 : TOQUES.length, visto: Date.now() }
    await store.setJSON(id, novo)
    return novo
  }

  try {
    const d = JSON.parse(bruto)
    const toque = Number.isFinite(Number(d?.toque)) ? Number(d.toque) : TOQUES.length
    return { toque, visto: Number(d?.visto) || 0 }
  } catch {
    return { toque: TOQUES.length, visto: 0 }
  }
}

/**
 * Qual kit, lido da descrição ("Aquiete — 2 unidades").
 *
 * Serve pro link do cupom já vir com o kit escolhido. Três frascos é
 * pedido com bump e não tem kit próprio, então nesse caso vai sem — o
 * checkout cai no de 1 e ela escolhe de novo, que é melhor que um link
 * pra um kit que ela não pediu.
 */
function kitDaDescricao(descricao) {
  const m = /(\d+)\s*unidade/i.exec(String(descricao ?? ''))
  const n = m ? Number(m[1]) : 0
  return [1, 2, 4].includes(n) ? String(n) : ''
}

/** Os status do Asaas em que o dinheiro entrou de verdade. */
const STATUS_PAGO = new Set(['RECEIVED', 'CONFIRMED', 'RECEIVED_IN_CASH'])

/**
 * Este cliente pagou alguma cobrança depois desta ser gerada?
 *
 * A segunda rede, e a que não depende de nada nosso: a verdade do
 * pagamento está no Asaas. Uma chamada por lembrete, e são poucos por
 * hora.
 *
 * Devolve `sabe: false` quando a consulta falha. Nesse caso o lembrete
 * não sai E a cobrança não é marcada, pra tentar de novo na próxima hora:
 * mandar no escuro é o erro que esta função existe pra evitar, e marcar
 * no escuro perderia o lembrete pra sempre.
 */
async function pagouOutraCobranca(customerId, desdeMs) {
  try {
    const r = await asaas(`/payments?customer=${encodeURIComponent(customerId)}&limit=100`)
    const pagou = (r.data || []).some((c) => {
      if (!STATUS_PAGO.has(String(c.status || '').toUpperCase())) return false
      const quando = c.paymentDate || c.confirmedDate || c.clientPaymentDate || c.dateCreated
      return new Date(quando).getTime() >= desdeMs
    })
    return { sabe: true, pagou }
  } catch (e) {
    console.error('[lembrete-pix] não deu pra checar os pagamentos do cliente:', e.message)
    return { sabe: false, pagou: false }
  }
}

export default async () => {
  const store = await loja()
  let enviados = 0

  try {
    const pagina = await asaas('/payments?status=PENDING&billingType=PIX&limit=100')
    const agora = Date.now()

    for (const p of pagina.data || []) {
      // A conta barata primeiro: sem isso cada varredura (288 por dia)
      // gastaria duas chamadas de API por cobrança pendente.
      const { toque, visto } = await estadoDe(store, p.id, p.dateCreated)
      if (toque < 0 || toque >= TOQUES.length) continue

      const minutos = (agora - visto) / 60_000
      if (minutos > LIMITE_MINUTOS) continue
      if (minutos < TOQUES[toque].minutos) continue
      const agenda = TOQUES[toque]

      // O código do Pix morre à meia-noite do dia em que foi gerado.
      // Saber se ainda é esse dia muda o texto do toque de 12h e decide
      // se o copia-e-cola vai junto.
      const mesmoDia = diaBR(new Date(visto)) === diaBR()

      // `criado` é só pra perguntar ao Asaas o que esta pessoa pagou
      // DEPOIS desta cobrança nascer. Aqui a data sem hora serve: ela
      // erra pra trás (meia-noite UTC do dia), e errar pra trás só torna
      // a pergunta mais abrangente, o que é o lado seguro.
      const criado = new Date(p.dateCreated).getTime()

      // Trava 3, antes de gastar a busca do cliente: o próprio Asaas diz
      // se esta pessoa já pagou outra cobrança depois desta ser gerada.
      const outra = await pagouOutraCobranca(p.customer, criado)
      if (!outra.sabe) continue
      if (outra.pagou) {
        console.log('[lembrete-pix] %s não cobrado: o cliente já pagou outra cobrança', p.id)
        await store.set(p.id, 'pago')
        continue
      }

      let cliente
      try {
        cliente = await asaas(`/customers/${p.customer}`)
      } catch (e) {
        console.error('[lembrete-pix] cliente não encontrado', p.id, e.message)
        continue
      }
      if (!cliente?.email) continue

      // Trava 2: o registro que o webhook escreve no instante do
      // pagamento. Pega o caso em que a pessoa pagou por outro e-mail ou
      // outro cadastro no Asaas e o cliente desta cobrança não é o mesmo.
      const pagante = await jaPagou({
        email: cliente.email,
        telefone: cliente.mobilePhone || cliente.phone,
        desde: criado,
      })
      if (pagante) {
        console.log('[lembrete-pix] %s não cobrado: pagou no pedido %s', p.id, pagante.referencia)
        await store.set(p.id, 'pago')
        continue
      }

      // A marca vai ANTES dos envios, de propósito. Quando ela ficava
      // depois do e-mail, e-mail que falhava deixava a cobrança sem marca
      // nenhuma e o zap saía de novo a cada hora, pra sempre — foi o que
      // aconteceu com a sequência do carrinho (ver carrinho-lembrete).
      await store.setJSON(p.id, { toque: toque + 1, visto, em: Date.now() })
      enviados++

      let payload = null
      try {
        const qr = await asaas(`/payments/${p.id}/pixQrCode`)
        payload = qr?.payload || null
      } catch { /* manda sem o copia-e-cola se o QR não vier */ }

      // Zap antes do e-mail: é onde a pessoa olha. Se falhar, o e-mail
      // ainda sai — os dois juntos, porque não dá pra saber qual ela vê.
      if (cliente.mobilePhone || cliente.phone) {
        const paraZap = cliente.mobilePhone || cliente.phone
        const r = await enviarZap({
          telefone: paraZap,
          texto: agenda.zap({
            nome: cliente.name, total: p.value, payload, mesmoDia,
            kit: kitDaDescricao(p.description),
          }),
        }).catch((e) => ({ enviado: false, erro: String(e?.message || e) }))
        // Esta funcao mandava sem registrar nada, e foi por isso que a
        // enxurrada de 02/11 ficou invisivel: o painel mostrava "pix
        // gerado" as 6h27 e mais nada, enquanto quatro mensagens saiam.
        // Envio que nao aparece no log e envio que ninguem audita.
        await registrarZap({
          referencia: p.externalReference || '',
          nome: cliente.name,
          telefone: paraZap,
          etapa: ['pix 5min', 'pix cupom', 'pix vence hoje', 'pix estou aqui'][toque] || 'pix lembrete',
          resultado: r,
        })
        /*
         * O copia-e-cola vai sozinho na mensagem seguinte, senao copiar a
         * mensagem leva a conversa junto.
         *
         * Nao vai em todo toque. No do cupom a pessoa foi convidada a
         * refazer o pedido, e mandar o codigo velho logo embaixo e
         * convidar ela a pagar o valor cheio. No ultimo nao se oferece
         * nada. E no de 12h so vai enquanto o codigo vale: depois da
         * meia-noite o banco recusa.
         *
         * Aqui dá pra esperar de verdade antes de mandar: isto roda sem
         * ninguem olhando a tela, e duas mensagens coladas sao o que faz o
         * WhatsApp derrubar a sessao.
         */
        if (payload && agenda.codigo && (!agenda.soHoje || mesmoDia)) {
          await pausa(2500)
          await enviarZap({ telefone: paraZap, texto: textoPixCodigo(payload) }).catch(() => {})
        }
      }

      // E-mail só em dois dos quatro toques. Aos 5 minutos a pessoa
      // acabou de sair do checkout e e-mail ali é ruído; às 12h o que ela
      // lê é o zap. Os dois do meio são os que valem a caixa de entrada.
      if (agenda.email) {
        try {
          const kit = kitDaDescricao(p.description)
          await enviar({
            para: cliente.email,
            assunto: ASSUNTOS_PIX[toque] || `Seu Pix do pedido ${p.externalReference || ''} ainda não caiu`,
            html: htmlLembretePix({
              nome: cliente.name,
              referencia: p.externalReference || p.id,
              descricao: p.description || 'Aquiete',
              total: p.value,
              payload,
              link: p.invoiceUrl || null,
              cupomLink: agenda.cupom
                ? `https://aquieteagora.com.br/checkout.html?${kit ? `kit=${kit}&` : ''}`
                  + 'cupom=PRIMEIRA10&utm_source=email&utm_medium=pix6h'
                : null,
            }),
          })
        } catch (e) {
          console.error('[lembrete-pix] envio falhou para', p.id, e.message)
        }
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
