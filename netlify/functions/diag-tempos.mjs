/**
 * TEMPORARIO — mede quanto tempo cada leitura do admin-dados consome.
 * Usar ?peca=<nome> pra isolar uma so, ou sem parametro pra tentar todas
 * com teto de tempo individual. Apagar depois do diagnostico.
 */
import { lerContadores, lerAtivos, lerTodosCarrinhos, lerCarrinhosAbandonados, lerConversoesGoogle } from './_lib/metricas.mjs'
import { lerComportamento, lerResumos } from './_lib/jornada.mjs'

const json = (d, s = 200) =>
  new Response(JSON.stringify(d, null, 2), { status: s, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } })

async function cronometrar(nome, fn) {
  const t0 = Date.now()
  try {
    const r = await fn()
    const tam = Array.isArray(r) ? r.length : (r && typeof r === 'object' ? Object.keys(r).length : 1)
    return { peca: nome, ms: Date.now() - t0, itens: tam }
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
}

export default async (req) => {
  if (req.headers.get('x-admin-token') !== process.env.ADMIN_TOKEN) return json({ erro: 'Token invalido' }, 401)
  const url = new URL(req.url)
  const alvo = url.searchParams.get('peca')
  const t0 = Date.now()

  if (alvo) {
    if (!PECAS[alvo]) return json({ erro: 'peca desconhecida', validas: Object.keys(PECAS) }, 400)
    return json(await cronometrar(alvo, PECAS[alvo]))
  }

  const saida = []
  for (const [nome, fn] of Object.entries(PECAS)) {
    saida.push(await cronometrar(nome, fn))
    if (Date.now() - t0 > 20000) { saida.push({ peca: '(parou)', motivo: 'passou de 20s' }); break }
  }
  return json({ totalMs: Date.now() - t0, pecas: saida })
}

export const config = { path: '/api/diag-tempos' }
