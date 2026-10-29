/**
 * Quem já pagou. É a trava que impede a loja de cobrar quem acabou de
 * pagar.
 *
 * O problema apareceu na primeira venda de verdade. A cliente clicou em
 * pagar mais de uma vez antes de concluir — e cada clique cria uma
 * cobrança nova no gateway. Ela pagou UMA; as outras ficaram penduradas
 * como PENDING. O lembrete de Pix varre o que está pendente, achou as
 * órfãs e mandou "seu Pix ainda não caiu" com o código errado pra quem
 * já tinha pagado.
 *
 * O registro é por PESSOA (e-mail e telefone), não por cobrança, porque
 * é a pessoa que recebe a mensagem — e a cobrança que sobrou nem sabe
 * que existe outra.
 *
 * E guarda QUANDO pagou, não só que pagou. A trava vale apenas pra
 * cobrança que nasceu ANTES do pagamento: quem comprou em março e
 * abandona um carrinho em junho continua sendo lembrado, senão o cliente
 * que volta nunca mais ouviria da loja.
 *
 * Nunca lança. Falha aqui é silenciosa — quem chama tem a consulta ao
 * gateway como segunda rede.
 */

let getStore = null
async function loja() {
  if (!getStore) ({ getStore } = await import('@netlify/blobs'))
  return getStore('pagantes')
}

/** E-mail serve de chave sozinho, desde que seja sempre na mesma caixa. */
function chaveEmail(v) {
  const s = String(v ?? '').trim().toLowerCase()
  return /^[^@\s]+@[^@\s]+\.[a-z]{2,24}$/.test(s) ? 'e:' + s : ''
}

/**
 * O mesmo número chega escrito de três jeitos: 49999887766 do checkout,
 * 5549999887766 do gateway, e 4999887766 de cadastro antigo sem o nono
 * dígito. A chave é DDD + os 8 últimos, que é igual nos três.
 */
function chaveTelefone(v) {
  let d = String(v ?? '').replace(/\D/g, '')
  if (d.length > 11 && d.startsWith('55')) d = d.slice(2)
  if (d.length < 10) return ''
  return 't:' + d.slice(0, 2) + d.slice(-8)
}

function chavesDe({ email, telefone }) {
  return [chaveEmail(email), chaveTelefone(telefone)].filter(Boolean)
}

/**
 * Chamado pelo webhook no primeiro sinal de pagamento. Grava nas duas
 * chaves porque o lembrete de Pix conhece a pessoa pelo telefone e o do
 * carrinho a conhece pelo e-mail.
 */
export async function marcarPagante({ email, telefone, referencia, quando } = {}) {
  try {
    const chaves = chavesDe({ email, telefone })
    if (!chaves.length) return
    const store = await loja()
    const dados = { em: Number(quando) || Date.now(), referencia: String(referencia || '') }
    await Promise.all(chaves.map((k) => store.setJSON(k, dados).catch(() => {})))
  } catch (e) {
    console.log('[pagantes] não consegui registrar:', e.message)
  }
}

/**
 * Esta pessoa pagou algo depois de `desde`?
 *
 * `desde` é o instante em que nasceu a cobrança (ou o carrinho) que está
 * na fila pra ser lembrado. Pagamento posterior a isso liquida a dívida;
 * pagamento anterior é de outra compra e não serve de trava.
 *
 * Devolve o registro, que serve pro log dizer qual pedido travou o
 * lembrete, ou null.
 */
export async function jaPagou({ email, telefone, desde = 0 } = {}) {
  try {
    const chaves = chavesDe({ email, telefone })
    if (!chaves.length) return null
    const store = await loja()
    for (const k of chaves) {
      const d = await store.get(k, { type: 'json' }).catch(() => null)
      if (d && Number(d.em) >= Number(desde)) return { ...d, chave: k }
    }
  } catch { /* não saber não pode derrubar o lembrete */ }
  return null
}
