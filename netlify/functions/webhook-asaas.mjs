/**
 * POST /api/webhook-asaas
 *
 * O Asaas chama esta função quando o status de uma cobrança muda. É aqui
 * que a venda vira real: até o pagamento confirmar, um Pix gerado é só
 * uma intenção.
 *
 * Cadastre a URL em: Asaas > Integrações > Webhooks
 *   URL    https://aquieteagora.com.br/api/webhook-asaas
 *   Token  o mesmo valor de ASAAS_WEBHOOK_TOKEN
 *
 * Responde 200 mesmo quando o e-mail ou o Meta falham. Devolver erro faz
 * o Asaas reenviar o evento em fila, e aí o cliente recebe a confirmação
 * várias vezes por causa de um problema que não é dele.
 */

import { timingSafeEqual } from 'node:crypto'

import { buscarCliente } from './_lib/gateways/asaas.mjs'
import { enviar, htmlConfirmacao, htmlVenda } from './_lib/email.mjs'
import { enviarCompra } from './_lib/meta-capi.mjs'
import { notificarVenda, podeNotificar, push } from './_lib/notificar.mjs'
import {
  marcarCarrinhoPago, registrarVendaPaga, lerIdentidadeDoPedido, anotarCompraMeta,
} from './_lib/metricas.mjs'
import { marcarPagante } from './_lib/pagantes.mjs'
import { despachar } from './_lib/envio.mjs'
import { marcarPagoUtmify } from './_lib/utmify.mjs'
import { enviarZap, textoPago } from './_lib/zap.mjs'

const json = (dados, status = 200) =>
  new Response(JSON.stringify(dados), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  })

/**
 * CONFIRMED e RECEIVED sao dois estagios do MESMO pagamento: confirmado
 * e "o cliente pagou", recebido e "o dinheiro esta disponivel". Tratar
 * os dois como pago mandaria dois e-mails do mesmo pedido.
 *
 * A regra abaixo garante exatamente um por pedido, sem precisar guardar
 * estado em lugar nenhum:
 *   cartao  -> vale o CONFIRMED, que chega na hora da compra
 *              (o RECEIVED do cartao so vem no repasse, semanas depois)
 *   demais  -> vale o RECEIVED, que no Pix e imediato
 */
function ehAVezDesteEvento(evento, tipoCobranca) {
  const cartao = String(tipoCobranca ?? '').toUpperCase().includes('CREDIT_CARD')
  return cartao ? evento === 'PAYMENT_CONFIRMED' : evento === 'PAYMENT_RECEIVED'
}

/**
 * Todo evento que significa "o dinheiro entrou", sem escolher de quem e a
 * vez. A regra de cima existe pra nao mandar DOIS e-mails do mesmo
 * pedido; parar de cobrar e outra coisa, e tem que acontecer no primeiro
 * sinal. No Pix o CONFIRMED chega antes do RECEIVED, e esperar o segundo
 * deixava uma janela em que o lembrete de Pix ainda saia pra quem acabou
 * de pagar.
 */
const EVENTOS_PAGOS = new Set([
  'PAYMENT_CONFIRMED',
  'PAYMENT_RECEIVED',
  'PAYMENT_RECEIVED_IN_CASH',
])

/** Comparação em tempo constante: `===` vaza o tamanho do prefixo certo. */
function mesmoToken(recebido, esperado) {
  const a = Buffer.from(String(recebido ?? ''))
  const b = Buffer.from(esperado)
  return a.length === b.length && timingSafeEqual(a, b)
}

/** "Aquiete — 2 unidades" -> 2 */
function unidadesDe(descricao) {
  const n = /(\d+)\s*unidade/i.exec(String(descricao ?? ''))
  return n ? Number(n[1]) : 1
}

export default async (req) => {
  if (req.method !== 'POST') return json({ erro: 'Use POST' }, 405)

  // Autenticidade. Sem isso qualquer um posta um "pagamento aprovado" e
  // dispara e-mail de confirmação e conversão falsa no Meta.
  //
  // Falha FECHADA de propósito: se o token não estiver configurado, o
  // webhook recusa tudo. Processar evento não autenticado é pior do que
  // não processar — melhor o pagamento esperar do que a loja acreditar
  // numa venda que não existiu.
  const esperado = process.env.ASAAS_WEBHOOK_TOKEN
  if (!esperado) {
    console.error('[webhook] ASAAS_WEBHOOK_TOKEN não configurado — recusando')
    return json({ erro: 'webhook não configurado' }, 503)
  }
  if (!mesmoToken(req.headers.get('asaas-access-token'), esperado)) {
    console.warn('[webhook] token inválido')
    return json({ erro: 'não autorizado' }, 401)
  }

  let corpo
  try { corpo = await req.json() } catch { return json({ erro: 'json inválido' }, 400) }

  const evento = corpo?.event
  const pgto = corpo?.payment
  if (!evento || !pgto) return json({ ok: true, ignorado: 'sem evento' })

  const referencia = pgto.externalReference || pgto.id

  // Cada etapa é isolada: falha em uma não impede as outras nem o 200.
  let cliente = null

  // Este bloco roda ANTES de decidir de quem é a vez, e é o conserto da
  // primeira venda: a cliente gerou mais de um Pix, pagou um, e recebeu
  // depois "seu Pix ainda não caiu" com o código de uma das cobranças que
  // ficaram penduradas. Quem pagou para de ser cobrado no primeiro sinal
  // de pagamento, qualquer que seja a cobrança que sobrou no Asaas.
  if (EVENTOS_PAGOS.has(evento)) {
    try {
      const c = await buscarCliente(pgto.customer)
      cliente = {
        nome: c.name,
        email: c.email,
        telefone: c.mobilePhone || c.phone || '',
        cidade: c.city || c.cityName || '',
        cep: c.postalCode || '',
        endereco: [c.address, c.addressNumber, c.complement, c.province, c.postalCode]
          .filter(Boolean).join(', '),
      }
    } catch (e) {
      console.error('[webhook] não consegui buscar o cliente:', e.message)
    }

    // A trava das cobranças, pela PESSOA: e-mail e telefone. Ver
    // _lib/pagantes.mjs.
    await marcarPagante({
      email: cliente?.email,
      telefone: cliente?.telefone,
      referencia,
    }).catch(() => {})

    // Tira da lista de abandonados e da sequência de e-mail. Pela
    // referência também, pra funcionar mesmo se a busca do cliente falhou.
    await marcarCarrinhoPago({ email: cliente?.email, referencia }).catch(() => {})
  }

  if (!ehAVezDesteEvento(evento, pgto.billingType)) {
    console.log('[webhook] ignorado:', evento, pgto.billingType, pgto.id)
    return json({ ok: true, ignorado: evento })
  }

  const total = Number(pgto.value)
  const descricao = pgto.description || 'Aquiete'
  const unidades = unidadesDe(descricao)

  console.log('[webhook] pagamento confirmado', referencia, total)

  const resultados = {}

  // Venda paga de verdade: entra na fila de conversao do Google. Se o
  // pedido nao veio de anuncio, isso nao faz nada.
  await registrarVendaPaga({ referencia, valor: total, quando: Date.now() }).catch(() => {})

  // A mesma venda, agora como paga, pra Utmify fechar a conta da
  // campanha. Reaproveita o payload guardado quando o Pix foi gerado.
  await marcarPagoUtmify(referencia, Date.now()).catch(() => {})

  // Zap de "pagamento confirmado". Vai junto do e-mail, nao no lugar
  // dele: quem paga quer ver a confirmacao onde estiver olhando.
  if (cliente?.telefone) {
    resultados.zapCliente = await enviarZap({
      telefone: cliente.telefone,
      texto: textoPago({ nome: cliente.nome, referencia }),
    }).catch(() => ({ enviado: false }))
  }

  if (cliente?.email) {
    try {
      resultados.emailCliente = await enviar({
        para: cliente.email,
        assunto: `Pagamento confirmado — pedido ${referencia}`,
        html: htmlConfirmacao({ nome: cliente.nome, referencia, descricao, total }),
      })
    } catch (e) {
      console.error('[webhook] e-mail do cliente falhou:', e.message)
      resultados.emailCliente = { enviado: false, erro: e.message }
    }
  }

  const lojista = process.env.EMAIL_LOJISTA
  if (lojista && cliente) {
    try {
      resultados.emailLojista = await enviar({
        para: lojista,
        assunto: `Venda ${referencia} — R$ ${total.toFixed(2).replace('.', ',')}`,
        html: htmlVenda({ referencia, descricao, total, cliente }),
      })
    } catch (e) {
      console.error('[webhook] aviso de venda falhou:', e.message)
    }
  }

  if (cliente) {
    // Os cookies do clique no anuncio, guardados quando o Pix foi gerado.
    // Sem eles o Meta recebe a compra e nao sabe de onde ela veio: o
    // evento aparece no Gerenciador de Eventos e a coluna de compras da
    // campanha fica vazia. O _fbc e o que carrega o fbclid.
    const ident = (await lerIdentidadeDoPedido(referencia).catch(() => null)) || {}

    try {
      resultados.meta = await enviarCompra({
        referencia, total, cliente,
        kitId: unidades, unidades,
        ip: ident.ip, ua: ident.ua, fbp: ident.fbp, fbc: ident.fbc,
        // Gravado la na geracao do Pix, quando ainda havia navegador.
        parceiro: !!ident.parceiro,
      })
    } catch (e) {
      console.error('[webhook] CAPI do Meta falhou:', e.message)
      resultados.meta = { enviado: false, erro: e.message }
    }

    // Recibo no painel. A resposta do webhook vai pro Asaas e some, e
    // "a compra chegou no Meta?" nao pode depender do log de uma funcao
    // que ja rodou.
    await anotarCompraMeta(referencia, resultados.meta).catch(() => {})
  }

  // Cria o envio no Melhor Envio. Antes disto, toda venda era digitada
  // na mao no painel deles e o servico que o cliente pagou se perdia.
  // Idempotente: o Asaas reenvia o webhook quando nao recebe 200 na hora,
  // e etiqueta duplicada e dinheiro duplicado (ver _lib/envio.mjs).
  const envio = await despachar(referencia).catch((e) => ({ ok: false, motivo: e.message }))
  resultados.envio = envio

  if (envio.ok && !envio.repetido) {
    const linhas = envio.comprado
      ? [`📦 Etiqueta paga e gerada — ${envio.servico}`, '', `Pedido ${referencia}`,
         envio.etiqueta ? `\nEtiqueta: ${envio.etiqueta}` : '',
         envio.dace ? `DACE (declaracao de conteudo): ${envio.dace}` : '']
      : [`📦 Envio no carrinho do Melhor Envio — ${envio.servico}`, '',
         `Pedido ${referencia}`, '',
         'Entra la, confere e compra a etiqueta. A declaracao de conteudo',
         'sai junto, e vai colada no pacote com a etiqueta.']
    push(linhas.filter(Boolean).join('\n'), 'Aquiete — envio pronto').catch(() => {})
  } else if (!envio.ok && envio.motivo !== 'desligado' && !envio.repetido) {
    // Falhar calado aqui significa a encomenda nao sair e ninguem saber.
    push(
      `⚠️ O envio do pedido ${referencia} nao foi criado no Melhor Envio.\n\n${envio.motivo}\n\nTem que cadastrar na mao.`,
      'Aquiete — envio travou',
      { tags: 'warning' },
    ).catch(() => {})
  }

  // O "toc toc" no celular. Sem cliente ainda manda, só troca o nome por generico.
  // O Asaas reenvia o webhook quando nao recebe 200 na hora; sem trava,
  // a mesma venda tocava o celular varias vezes.
  if (await podeNotificar('venda:' + referencia, 24 * 60)) {
    notificarVenda({ nome: cliente?.nome, total, billingType: pgto.billingType }).catch(() => {})
  }

  return json({ ok: true, referencia, ...resultados })
}

export const config = { path: '/api/webhook-asaas' }
