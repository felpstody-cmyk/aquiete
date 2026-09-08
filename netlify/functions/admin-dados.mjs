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

import { lerContadores } from './_lib/metricas.mjs'

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
  const base = BASES[(process.env.ASAAS_AMBIENTE || 'sandbox').toLowerCase()] || BASES.sandbox
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
    const [cobrancas, clientes, metricas] = await Promise.all([
      tudo('/payments'),
      tudo('/customers'),
      lerContadores(),
    ])

    const porId = new Map(clientes.map((c) => [c.id, c]))

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
        cpf: c.cpfCnpj || '',
        cidade: c.cityName || c.city || '',
        uf: c.state || '',
        bairro: c.province || '',
        cep: c.postalCode || '',
        endereco: [c.address, c.addressNumber].filter(Boolean).join(', '),
        un,
        valor: Number(p.value) || 0,
        liquido: Number(p.netValue) || 0,
        pag: PAGAMENTO[p.billingType] || p.billingType || '',
        status: SITUACAO[p.status] || p.status || '',
        descricao: p.description || '',
        link: p.invoiceUrl || '',
      }
    })

    pedidos.sort((a, b) => (b.data || '').localeCompare(a.data || ''))

    return json({
      geradoEm: new Date().toISOString(),
      ambiente: (process.env.ASAAS_AMBIENTE || 'sandbox').toLowerCase(),
      pedidos,
      metricas,
    })
  } catch (e) {
    return json({ erro: String(e.message || e) }, 502)
  }
}

export const config = { path: '/api/admin-dados' }
