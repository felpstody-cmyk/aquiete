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
 * NUNCA lança. Registro que quebra não pode impedir o cliente de receber
 * o código dele — o aviso vale mais que a anotação.
 */

/*
 * UM DOCUMENTO POR PEDIDO, nao um mapa com todos.
 *
 * A primeira versao guardava tudo num documento so e fazia ler-alterar-
 * gravar a cada envio. Isso PERDE registro: o Blobs tem consistencia
 * eventual, entao o envio seguinte le um mapa que ainda nao tem o
 * anterior e grava por cima dele.
 *
 * Visto acontecendo em 14/11/2026, mandando cinco codigos de uma vez: a
 * primeira leitura mostrou quatro nomes com a Debora e a Vivian faltando,
 * e vinte segundos depois mostrou as duas e faltava a Marisul. Os clientes
 * receberam tudo; quem se perdia era so a anotacao — justamente a parte
 * que existe pra responder "quem ja recebeu".
 *
 * Com um documento por pedido nao existe mapa compartilhado, e dois
 * envios nunca escrevem no mesmo lugar.
 */
const CHAVE_ANTIGA = 'enviados'

let getStore = null
async function loja() {
  if (!getStore) ({ getStore } = await import('@netlify/blobs'))
  return getStore('rastreio-enviado')
}

/** O nome do documento de um pedido. Prefixo pra nao colidir com a chave
 *  antiga, que continua sendo lida pra nao perder o que ja foi gravado. */
const docDe = (referencia) => 'ped_' + String(referencia).replace(/[^A-Za-z0-9_-]/g, '')

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
    const chave = docDe(referencia)
    const anterior = await store.get(chave, { type: 'json' }).catch(() => null)

    const registro = {
      // A referência vai DENTRO do documento: é por ela que a leitura
      // remonta o mapa, sem depender de decifrar o nome do arquivo.
      referencia: String(referencia),
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

    await store.setJSON(chave, registro)
  } catch (e) {
    console.error('[rastreio] nao deu pra anotar:', e?.message || e)
  }
}

/**
 * O mapa inteiro: referência -> dados do rastreio. Lido pelo painel.
 *
 * Monta a partir dos documentos por pedido, e começa pelo mapa antigo pra
 * não perder o que já tinha sido gravado antes desta mudança. O que está
 * no documento próprio vence, porque é o registro mais recente.
 */
export async function lerRastreios() {
  const saida = {}
  try {
    const store = await loja()

    const antigo = await store.get(CHAVE_ANTIGA, { type: 'json' }).catch(() => null)
    if (antigo && typeof antigo === 'object') Object.assign(saida, antigo)

    const { blobs } = await store.list({ prefix: 'ped_' })
    await Promise.all((blobs || []).map(async (b) => {
      const d = await store.get(b.key, { type: 'json' }).catch(() => null)
      if (d?.referencia) saida[d.referencia] = d
    }))
  } catch (e) {
    // Lista incompleta é melhor que painel quebrado: o que não vier aparece
    // como "falta rastreio", que é o estado mais seguro pra ele ver.
    console.error('[rastreio] leitura parcial:', e?.message || e)
  }
  return saida
}
