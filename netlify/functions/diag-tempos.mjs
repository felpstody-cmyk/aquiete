/**
 * TEMPORARIO — mede quanto tempo cada leitura do admin-dados consome.
 * ?peca=<nome> isola uma. Apagar depois do diagnostico.
 */
import { lerContadores, lerAtivos, lerTodosCarrinhos, lerConversoesGoogle } from './_lib/metricas.mjs'
import { lerComportamento, lerResumos } from './_lib/jornada.mjs'

const json = (d, s = 200) =>
  new Response(JSON.stringify(d, null, 2), { status: s, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } })

async function asaas(caminho) {
  const chave = process.env.ASAAS_API_KEY
  const base = (process.env.ASAAS_AMBIENTE || 'producao').toLowerCase() === 'sandbox'
    ? 'https://api-sandbox.asaas.com/v3'
    : 'https://api.asaas.com/v3'
  let total = 0
  let paginas = 0
  for (let offset = 0; offset < 5000; offset += 100) {
    const sep = caminho.includes('?') ? '&' : '?'
    const alvo = base + caminho + sep + 'limit=100&offset=' + offset
    const r = await fetch(alvo, { headers: { 'Content-Type': 'application/json', access_token: chave } })
    const pagina = await r.json()
    paginas++
    total += (pagina.data || []).length
    if (!pagina.hasMore) break
  }
  return { registros: total, paginas }
}

async function cronometrar(nome, fn) {
  const t0 = Date.now()
  try {
    const r = await fn()
    const itens = Array.isArray(r) ? r.length : (r && typeof r === 'object' ? (r.registros ?? Object.keys(r).length) : 1)
    const extra = r && r.paginas ? { paginas: r.paginas } : {}
    return { peca: nome, ms: Date.now() - t0, itens, ...extra }
  } catch (e) {
    return { peca: nome, ms: Date.now() - t0, erro: String(e.message || e) }
  }
}

const PECAS = {
  contadores: () => lerContadores(),
  ativos: () => lerAtivos(),
  carrinhos: () => lerTodosCarrinhos(),
  conversoesGoogle: () => lerConversoesGoogle(),
  resumos: () => lerResumos(),
  comportamento: () => lerComportamento(),
  pagamentos: () => asaas('/payments'),
  clientes: () => asaas('/customers'),
}

export default async (req) => {
  if (req.headers.get('x-admin-token') !== process.env.ADMIN_TOKEN) return json({ erro: 'Token invalido' }, 401)
  const alvo = new URL(req.url).searchParams.get('peca')
  if (!alvo) return json({ pecas: Object.keys(PECAS) })
  if (!PECAS[alvo]) return json({ erro: 'peca desconhecida', validas: Object.keys(PECAS) }, 400)
  return json(await cronometrar(alvo, PECAS[alvo]))
}

export const config = { path: '/api/diag-tempos' }
