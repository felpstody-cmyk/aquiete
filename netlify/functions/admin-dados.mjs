/**
 * GET /api/admin-dados   (cabeçalho x-admin-token: ADMIN_TOKEN)
 *
 * Devolve, num JSON só, tudo que o sistema da loja precisa:
 *   - pedidos vindos direto do Asaas (cliente, cidade, valor, forma, situação)
 *   - contadores de visita e de checkout
 *
 * Aqui NÃO existe cadastro manual: a fonte da verdade é o gateway, que é
 * quem de fato recebeu o dinheiro. O sistema local só espelha.
 */

import { lerContadores, lerAtivos, lerTodosCarrinhos, lerCarrinhosAbandonados, lerConversoesGoogle, lerCompraMeta } from './_lib/metricas.mjs'
import { lerComportamento, lerResumos } from './_lib/jornada.mjs'
import { KITS, FRETE_NORTE } from './_lib/catalogo.mjs'
import { lerEstadoZap } from './_lib/zapvigia.mjs'
import { lerZapLog } from './_lib/zaplog.mjs'
import { lerDespachos, despachoConfigurado, faltaNoRemetente } from './_lib/envio.mjs'
import { lerRastreios } from './_lib/utmify.mjs'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type, x-admin-token',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
}

const json = (dados, status = 200) =>
  new Response(JSON.stringify(dados), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...CORS },
  })

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

/** O Asaas pagina de 100 em 100. Buscamos tudo, com teto pra não travar. */
async function tudo(caminho) {
  const itens = []
  for (let offset = 0; offset < 5000; offset += 100) {
    const sep = caminho.includes('?') ? '&' : '?'
    const pagina = await asaas(`${caminho}${sep}limit=100&offset=${offset}`)
    itens.push(...(pagina.data || []))
    if (!pagina.hasMore) break
  }
  return itens
}

const SITUACAO = {
  PENDING: 'Pendente', AWAITING_RISK_ANALYSIS: 'Pendente',
  CONFIRMED: 'Pago', RECEIVED: 'Pago', RECEIVED_IN_CASH: 'Pago', DUNNING_RECEIVED: 'Pago',
  OVERDUE: 'Vencido',
  REFUNDED: 'Estornado', REFUND_REQUESTED: 'Estornado',
  CHARGEBACK_REQUESTED: 'Chargeback', CHARGEBACK_DISPUTE: 'Chargeback',
  AWAITING_CHARGEBACK_REVERSAL: 'Chargeback',
  DELETED: 'Cancelado',
}

const PAGAMENTO = { PIX: 'Pix', CREDIT_CARD: 'Cartão', BOLETO: 'Boleto', UNDEFINED: 'A escolher' }

/** "Aquiete — 2 unidades" vira 2. Sem descrição, deduz pelo valor. */
function unidades(descricao, valor) {
  const m = /(\d+)\s*unidade/i.exec(descricao || '')
  if (m) return Number(m[1])
  const v = Number(valor) || 0
  if (v >= 290) return 4
  if (v >= 165) return 2
  return 1
}

export default async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS })

  const esperado = process.env.ADMIN_TOKEN
  if (!esperado) return json({ erro: 'ADMIN_TOKEN não configurado no Netlify' }, 500)
  if (req.headers.get('x-admin-token') !== esperado) return json({ erro: 'Token inválido' }, 401)

  try {
    const [cobrancas, clientes, metricas, ativos, carrinhos, comportamento, conversoesGoogle, resumos, zap, zapLog, despachos, metaPedido, rastreios] = await Promise.all([
      tudo('/payments'),
      tudo('/customers'),
      lerContadores(),
      lerAtivos(),
      lerTodosCarrinhos(),
      lerComportamento(),
      lerConversoesGoogle(),
      // Um registro por dia, desde a abertura da loja. É de onde sai o
      // histórico longo sem precisar ler o bruto de meses.
      lerResumos(),
      // Leitura de blob, nao chamada na WAME: quem pergunta pra WAME e o
      // vigia, de 10 em 10 minutos. Abrir o painel nao pode custar uma
      // chamada externa — foi assim que ele comecou a dar 504 antes.
      lerEstadoZap(),
      lerZapLog(),
      // Leitura de blob, nao chamada no Melhor Envio: quem fala com eles e
      // o webhook, uma vez por venda. Abrir o painel nao pode custar
      // chamada externa.
      lerDespachos(),
      // Recibo do envio da compra pro Meta, e de qual anuncio veio cada
      // pedido. Leitura de blob nos dois casos: o painel nao fala com o
      // Meta nem com a Utmify.
      lerCompraMeta(),
      lerRastreios(),
    ])

    // Uma leitura só do Blobs: a lista de abandonados sai da lista completa.
    const abandonados = await lerCarrinhosAbandonados(carrinhos)

    const porId = new Map(clientes.map((c) => [c.id, c]))
    const porRef = new Map(despachos.map((d) => [d.referencia, d]))

    const pedidos = cobrancas.map((p) => {
      const c = porId.get(p.customer) || {}
      const un = unidades(p.description, p.value)
      return {
        id: p.id,
        referencia: p.externalReference || '',
        data: (p.dateCreated || p.dueDate || '').slice(0, 10),
        pagoEm: (p.paymentDate || p.clientPaymentDate || '').slice(0, 10) || '',
        nome: c.name || '—',
        contato: c.email || c.mobilePhone || c.phone || '',
        // Separado do contato porque o zap precisa do celular, e `contato`
        // cai pro telefone só quando não existe e-mail.
        telefone: c.mobilePhone || c.phone || '',
        cpf: c.cpfCnpj || '',
        cidade: c.cityName || c.city || '',
        uf: c.state || '',
        bairro: c.province || '',
        cep: c.postalCode || '',
        endereco: [c.address, c.addressNumber].filter(Boolean).join(', '),
        // Separados tambem: e o que o despacho manual precisa mandar de
        // volta, porque `validarCliente` cobra rua e numero em campos
        // proprios e o `endereco` colado acima nao da pra desmontar com
        // seguranca (tem rua com virgula no nome).
        rua: c.address || '',
        numero: String(c.addressNumber || ''),
        complemento: c.complement || '',
        un,
        valor: Number(p.value) || 0,
        liquido: Number(p.netValue) || 0,
        pag: PAGAMENTO[p.billingType] || p.billingType || '',
        status: SITUACAO[p.status] || p.status || '',
        descricao: p.description || '',
        link: p.invoiceUrl || '',
        // Como esta a encomenda no Melhor Envio. `envio` fica null nos
        // pedidos antigos, de antes do despacho automatico existir.
        envio: (() => {
          const d = porRef.get(p.externalReference || '')
          if (!d) return null
          return {
            servico: d.me?.servico || d.servicoNome || '',
            estado: d.me?.estado || (d.erro ? 'falhou' : 'nao enviado'),
            protocolo: d.me?.protocolo || '',
            etiqueta: d.me?.etiqueta || '',
            dace: d.me?.dace || '',
            erro: d.erro || '',
          }
        })(),
        // De qual anuncio veio a venda. Antes isto so existia no site da
        // Utmify, e aqui a venda aparecia sem origem.
        campanha: (() => {
          const t = rastreios[p.externalReference || ''] || null
          if (!t) return null
          return {
            origem: t.utm_source || '',
            campanha: t.utm_campaign || '',
            anuncio: t.utm_content || '',
            midia: t.utm_medium || '',
          }
        })(),
        // Se a compra chegou no Meta, e se foi com o _fbc.
        meta: metaPedido[p.externalReference || ''] || null,
      }
    })

    pedidos.sort((a, b) => (b.data || '').localeCompare(a.data || ''))

    return json({
      geradoEm: new Date().toISOString(),
      ambiente: (process.env.ASAAS_AMBIENTE || 'producao').toLowerCase(),
      pedidos,
      metricas,
      ativos,
      abandonados,
      carrinhos,
      comportamento,
      conversoesGoogle,
      resumos,
      zap,
      zapLog,
      // Preço vem daqui, do mesmo lugar que o checkout cobra. O painel
      // tinha a própria cópia em Ajustes e ela ficou pra trás: carrinho
      // de 2 unidades aparecia como R$ 169,00 quando a loja cobrava
      // R$ 149,90. Uma fonte só, e não desencontra mais.
      // Pro painel poder dizer "falta preencher X" em vez de so mostrar
      // pedido sem envio e deixar ele adivinhando o motivo.
      despacho: {
        ligado: despachoConfigurado(),
        falta: faltaNoRemetente(),
        modo: (process.env.MELHORENVIO_DESPACHO || 'carrinho').toLowerCase(),
      },
      precos: {
        kits: Object.fromEntries(
          Object.entries(KITS).map(([id, k]) => [id, { preco: k.preco, frete: k.frete, unidades: k.unidades }])
        ),
        freteNorte: FRETE_NORTE,
      },
    })
  } catch (e) {
    return json({ erro: String(e.message || e) }, 502)
  }
}

export const config = { path: '/api/admin-dados' }
