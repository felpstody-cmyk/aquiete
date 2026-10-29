/**
 * Envio de vendas pra Utmify.
 *
 * Existe porque a atribuição de campanha morava num arquivo nosso que se
 * apagava sozinho em 15 dias. Quando foi preciso saber de qual anúncio
 * veio cada Pix gerado, o dado já não existia. Aqui a venda é empurrada
 * pra Utmify no momento em que acontece, e lá ela fica.
 *
 * Funciona com qualquer gateway: é o nosso servidor que manda, não o
 * gateway. Trocar de Asaas pra Appmax não mexe neste arquivo.
 *
 * Regra de ouro, igual à do metricas.mjs: isto NUNCA pode derrubar um
 * pedido. Toda falha é engolida e registrada. Se a Utmify estiver fora
 * do ar, o cliente compra do mesmo jeito.
 *
 * ---------------------------------------------------------------
 * Dois detalhes da API deles que quebram tudo se passarem errado:
 *
 *   1. TODO valor vai em CENTAVOS. R$ 129,90 é 12990.
 *   2. Data no formato 'AAAA-MM-DD HH:MM:SS' e em UTC, não em Brasília.
 *      E o `createdAt` precisa ser EXATAMENTE o mesmo em toda
 *      atualização do mesmo pedido — por isso o payload inteiro fica
 *      guardado quando o Pix é gerado, e o pagamento só reaproveita.
 * ---------------------------------------------------------------
 */

const URL_API = 'https://api.utmify.com.br/api-credentials/orders'

/* Só aceita pedido criado nos últimos 7 dias, e estorno/chargeback em
   até 45. Mandar fora disso pode dar bloqueio, então nem tentamos. */
const DIAS_PEDIDO = 7
const DIAS_ESTORNO = 45

let getStore = null

async function loja(nome = 'utmify') {
  if (!getStore) ({ getStore } = await import('@netlify/blobs'))
  return getStore(nome)
}

const centavos = (v) => Math.round(Number(v || 0) * 100)

/** 'AAAA-MM-DD HH:MM:SS' em UTC, que é o que eles pedem. */
function dataUtc(ms) {
  const d = new Date(Number(ms) || Date.now())
  return d.toISOString().slice(0, 19).replace('T', ' ')
}

/* Nosso 'card' é o 'credit_card' deles. Qualquer outra coisa cai em pix,
   que é a forma dominante da loja. */
const METODO = { pix: 'pix', card: 'credit_card', boleto: 'boleto' }

/* A origem é gravada pelo navegador na página de chegada. Campo ausente
   tem que ir como null explícito, não como string vazia nem omitido. */
function rastreio(origem) {
  const o = origem || {}
  const texto = (v) => {
    const s = String(v ?? '').trim()
    return s ? s.slice(0, 200) : null
  }
  return {
    src: texto(o.src_param),
    sck: texto(o.sck),
    utm_source: texto(o.src),
    utm_campaign: texto(o.camp),
    utm_medium: texto(o.med),
    utm_content: texto(o.anuncio),
    utm_term: texto(o.termo),
  }
}

async function postar(payload) {
  const token = process.env.UTMIFY_API_TOKEN
  if (!token) return { ok: false, motivo: 'UTMIFY_API_TOKEN não configurado' }

  /*
   * Prazo curto de propósito. Esta chamada acontece no meio da criação
   * do pedido, então uma API lenta do outro lado seguraria o cliente na
   * tela de pagamento esperando. Medição nunca pode fazer isso: se não
   * responder em 4 segundos, desiste e o pedido segue. O payload já está
   * guardado, então o webhook reenvia os dois estados mais tarde.
   */
  const corta = AbortSignal.timeout ? AbortSignal.timeout(4000) : undefined

  /*
   * A API deles fica atrás de Cloudflare, que recusa cliente sem
   * identificação (erro 1010). O User-Agent abaixo diz honestamente quem
   * somos, com o endereço da loja, que é o que se espera de uma
   * integração servidor-a-servidor.
   */
  let resposta
  try {
    resposta = await fetch(URL_API, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'User-Agent': 'Aquiete-Loja/1.0 (+https://aquieteagora.com.br)',
        'x-api-token': token,
      },
      body: JSON.stringify(payload),
      ...(corta ? { signal: corta } : {}),
    })
  } catch (e) {
    return { ok: false, motivo: e.name === 'TimeoutError' ? 'demorou demais (4s)' : e.message }
  }

  if (!resposta.ok) {
    const detalhe = await resposta.text().catch(() => '')
    return { ok: false, motivo: `${resposta.status} ${detalhe.slice(0, 300)}` }
  }
  return { ok: true }
}

/**
 * Chamado quando a cobrança é criada (Pix gerado, boleto gerado, cartão
 * enviado). Monta o payload, manda como "aguardando pagamento" e guarda
 * uma cópia pro momento em que o pagamento confirmar.
 */
export async function registrarPedidoUtmify({
  referencia, pedido, cliente, origem, ip, taxaGateway = 0, teste = false,
}) {
  try {
    if (!referencia) return

    const total = centavos(pedido.total)
    const taxa = centavos(taxaGateway)

    const payload = {
      orderId: String(referencia),
      platform: 'Aquiete',
      paymentMethod: METODO[pedido.metodo] || 'pix',
      status: 'waiting_payment',
      createdAt: dataUtc(Date.now()),
      approvedDate: null,
      refundedAt: null,
      customer: {
        name: cliente.nome || '',
        email: cliente.email || '',
        phone: cliente.telefone || null,
        document: cliente.cpf || null,
        country: 'BR',
        ...(ip ? { ip } : {}),
      },
      products: [
        {
          id: `kit-${pedido.kitId}`,
          name: pedido.descricao || `Aquiete ${pedido.kitId} un.`,
          planId: null,
          planName: null,
          quantity: 1,
          priceInCents: centavos(pedido.subtotal),
        },
      ],
      trackingParameters: rastreio(origem),
      commission: {
        totalPriceInCents: total,
        gatewayFeeInCents: taxa,
        // Eles avisam pra não mandar 0 aqui. Sem a taxa informada, o que
        // sobra pro vendedor é o total mesmo.
        userCommissionInCents: Math.max(0, total - taxa) || total,
        currency: 'BRL',
      },
      ...(teste ? { isTest: true } : {}),
    }

    // Guardado ANTES de mandar: se a Utmify estiver fora do ar agora, o
    // pagamento lá na frente ainda encontra o payload e reenvia os dois
    // estados. E é isto que garante o mesmo createdAt nas atualizações.
    const store = await loja()
    await store.setJSON(String(referencia), { payload, em: Date.now() })

    const r = await postar(payload)
    if (!r.ok) console.log('[utmify] pedido não entrou:', r.motivo)
  } catch (e) {
    console.log('[utmify] registrarPedido falhou:', e.message)
  }
}

/**
 * Pro painel: de qual anuncio veio cada pedido, pela referencia.
 *
 * O payload guardado ja tem isso desde que o Pix foi gerado. Sem esta
 * leitura a resposta de "qual campanha vendeu" so existia no site deles,
 * e no nosso painel a venda aparecia sem origem nenhuma.
 */
export async function lerRastreios() {
  const fora = {}
  try {
    const store = await loja()
    const { blobs } = await store.list()
    await Promise.all((blobs || []).map(async (b) => {
      const d = await store.get(b.key, { type: 'json' }).catch(() => null)
      const t = d?.payload?.trackingParameters
      if (t) fora[b.key] = t
    }))
  } catch { /* sem dado é melhor que erro 500 */ }
  return fora
}

/**
 * Chamado pelo webhook do gateway quando o dinheiro cai de verdade.
 * Reaproveita o payload guardado e só troca o estado, porque o
 * `createdAt` precisa ser idêntico ao do primeiro envio.
 */
export async function marcarPagoUtmify(referencia, quandoMs) {
  return atualizar(referencia, 'paid', quandoMs, DIAS_PEDIDO)
}

/** Estorno e chargeback, pra Utmify não contar como venda boa. */
export async function marcarEstornoUtmify(referencia, quandoMs, chargeback = false) {
  return atualizar(referencia, chargeback ? 'chargedback' : 'refunded', quandoMs, DIAS_ESTORNO)
}

async function atualizar(referencia, estado, quandoMs, limiteDias) {
  try {
    if (!referencia) return
    const store = await loja()
    const guardado = await store.get(String(referencia), { type: 'json' }).catch(() => null)
    if (!guardado?.payload) {
      console.log('[utmify] sem payload guardado para', referencia)
      return
    }

    // Fora da janela deles o envio é recusado e pode gerar bloqueio.
    const idade = (Date.now() - Number(guardado.em || 0)) / 86_400_000
    if (idade > limiteDias) {
      console.log('[utmify] %s fora da janela de %d dias', referencia, limiteDias)
      return
    }

    const quando = dataUtc(quandoMs || Date.now())
    const payload = { ...guardado.payload, status: estado }
    if (estado === 'paid') payload.approvedDate = quando
    if (estado === 'refunded' || estado === 'chargedback') {
      // Quem estorna pagou antes: sem a data de aprovação a Utmify não
      // consegue casar o estorno com a venda original.
      payload.approvedDate = payload.approvedDate || quando
      payload.refundedAt = quando
    }

    const r = await postar(payload)
    if (!r.ok) { console.log('[utmify] atualização não entrou:', r.motivo); return }

    await store.setJSON(String(referencia), { ...guardado, payload })
  } catch (e) {
    console.log('[utmify] atualizar falhou:', e.message)
  }
}
