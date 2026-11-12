/**
 * Quem já recebeu código de rastreio, e qual.
 *
 * ---------------------------------------------------------------
 *  POR QUE ISTO EXISTE
 * ---------------------------------------------------------------
 * O envio de rastreio mandava o zap e o e-mail e não deixava rastro
 * nenhum: o código era digitado num `prompt()` do painel, viajava pro
 * cliente e desaparecia. Resultado prático, com 23 pedidos pagos e um
 * lote sendo postado: não havia como responder "quem ainda falta?".
 *
 * Nem o log do zap servia, porque `enviar-rastreio` era o único envio da
 * loja que não chamava `registrarZap`.
 *
 * Um documento só com o mapa inteiro, igual ao zap-log: são dezenas de
 * pedidos, não milhares, e assim abrir o painel custa UMA leitura em vez
 * de uma por pedido.
 *
 * NUNCA lança. Registro que quebra não pode impedir o cliente de receber
 * o código dele — o aviso vale mais que a anotação.
 */

const CHAVE = 'enviados'

let getStore = null
async function loja() {
  if (!getStore) ({ getStore } = await import('@netlify/blobs'))
  return getStore('rastreio-enviado')
}

/**
 * Anota que a referência tal recebeu o código tal.
 *
 * `em` é gravado por nós, em milissegundos. O "quando" tem que ser nosso:
 * é ele que responde "mandei isso ontem ou semana passada?".
 *
 * Regravar a mesma referência sobrescreve de propósito. Código corrigido
 * depois de digitado errado é caso real, e o certo é o último valer —
 * mas o primeiro fica em `antes`, pra não perder o histórico de que houve
 * troca.
 */
export async function guardarRastreio({
  referencia, codigo, transportadora, nome, zap, email, so,
}) {
  try {
    if (!referencia || !codigo) return
    const store = await loja()
    const mapa = (await store.get(CHAVE, { type: 'json' })) || {}
    const anterior = mapa[referencia] || null

    mapa[referencia] = {
      codigo: String(codigo).trim(),
      transportadora: String(transportadora || '').trim(),
      nome: String(nome || '').trim(),
      em: Date.now(),
      // Como o cliente foi avisado. `so` marca o registro feito SEM avisar
      // ninguém — serve pra acertar pedido que já saiu antes disto existir,
      // sem reenviar mensagem pra quem já recebeu.
      zap: Boolean(zap),
      email: Boolean(email),
      soRegistro: Boolean(so),
      ...(anterior && anterior.codigo !== String(codigo).trim()
        ? { antes: { codigo: anterior.codigo, em: anterior.em } }
        : {}),
    }

    await store.setJSON(CHAVE, mapa)
  } catch (e) {
    console.error('[rastreio] nao deu pra anotar:', e?.message || e)
  }
}

/** O mapa inteiro: referência -> dados do rastreio. Lido pelo painel. */
export async function lerRastreios() {
  try {
    const store = await loja()
    return (await store.get(CHAVE, { type: 'json' })) || {}
  } catch {
    // Sem mapa é melhor que painel quebrado: o painel trata tudo como
    // "falta rastreio", que é o estado mais seguro pra ele ver.
    return {}
  }
}
