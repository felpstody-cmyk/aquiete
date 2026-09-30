/**
 * TEMPORARIO — passa as chaves antigas "tipo:DIA:valor" pro formato
 * agrupado "g:tipo:DIA". Roda em lotes e se chama de novo enquanto
 * sobrar coisa; apagar o arquivo quando terminar.
 *
 * Seguro repetir: a chave velha e apagada depois de somada, entao uma
 * segunda passada nunca conta a mesma duas vezes.
 */
const json = (d, s = 200) =>
  new Response(JSON.stringify(d, null, 2), { status: s, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } })

const LOTE = 250

export default async (req) => {
  if (req.headers.get('x-admin-token') !== process.env.ADMIN_TOKEN) return json({ erro: 'Token invalido' }, 401)

  const { getStore } = await import('@netlify/blobs')
  const store = getStore('metricas')
  const t0 = Date.now()

  // O list() do Blobs e eventualmente consistente: chave apagada continua
  // aparecendo por um tempo. Sem cursor, cada chamada pegava as mesmas 250
  // do topo e a migracao nao saia do lugar. Por isso o avanco e por NOME:
  // a ordem da listagem e estavel, entao "tudo que vem depois da ultima que
  // eu tratei" funciona mesmo com a lista desatualizada.
  const depois = new URL(req.url).searchParams.get('depois') || ''
  const { blobs } = await store.list()
  const velhas = blobs
    .map((b) => b.key)
    .filter((k) => !k.startsWith('g:') && k.split(':').length >= 3)
    .sort()
    .filter((k) => k > depois)
  const lote = velhas.slice(0, LOTE)
  if (!lote.length) return json({ pronto: true, restam: 0, ms: Date.now() - t0 })

  // Agrupa o lote por destino pra ler e gravar cada grupo uma vez so,
  // em vez de uma vez por chave.
  const porGrupo = new Map()
  for (const k of lote) {
    const p = k.split(':')
    const destino = `g:${p[0]}:${p[1]}`
    if (!porGrupo.has(destino)) porGrupo.set(destino, [])
    porGrupo.get(destino).push({ chave: k, item: p.slice(2).join(':'), tipo: p[0] })
  }

  let movidas = 0
  for (const [destino, itens] of porGrupo) {
    const atual = (await store.get(destino, { type: 'json' }).catch(() => null)) || {}
    for (const it of itens) {
      const bruto = Number(await store.get(it.chave).catch(() => 0)) || 0
      // "ultimaCidade" guarda horario, nao quantidade: vale o mais recente.
      if (it.tipo.startsWith('ultima')) atual[it.item] = Math.max(Number(atual[it.item]) || 0, bruto)
      else atual[it.item] = (Number(atual[it.item]) || 0) + bruto
      movidas++
    }
    await store.setJSON(destino, atual)
    await Promise.all(itens.map((it) => store.delete(it.chave).catch(() => {})))
  }

  return json({ pronto: false, movidas, restam: velhas.length - lote.length, ultima: lote[lote.length - 1], grupos: porGrupo.size, ms: Date.now() - t0 })
}

export const config = { path: '/api/migrar-contadores' }
