/**
 * Contadores do site (visitas, checkouts), guardados no Netlify Blobs.
 *
 * Regra de ouro deste arquivo: métrica NUNCA pode derrubar a loja.
 * Toda falha é engolida de propósito — se o Blobs estiver fora, a página
 * continua carregando e o pedido continua sendo criado.
 */

let getStore = null

async function loja() {
  if (!getStore) ({ getStore } = await import('@netlify/blobs'))
  return getStore('metricas')
}

/** Soma 1 na chave do dia. Ex.: "visita:2026-09-06". */
export async function contar(chave) {
  try {
    const store = await loja()
    const atual = Number(await store.get(chave)) || 0
    await store.set(chave, String(atual + 1))
  } catch { /* silêncio proposital */ }
}

/** Devolve { "visita:2026-09-06": 12, "checkout:2026-09-06": 3, ... } */
export async function lerContadores() {
  const saida = {}
  try {
    const store = await loja()
    const { blobs } = await store.list()
    await Promise.all(
      blobs.map(async (b) => {
        saida[b.key] = Number(await store.get(b.key)) || 0
      })
    )
  } catch { /* sem métricas é melhor que erro 500 */ }
  return saida
}
