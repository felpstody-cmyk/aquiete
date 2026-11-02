/**
 * Os Pix de 30 minutos, guardados por nós.
 *
 * Por que isto existe: o QR Code estático do Asaas **não cria cobrança**.
 * A cobrança só nasce no instante em que alguém paga. Enquanto o código
 * está vivo não há nada pra varrer do lado deles — nem pra lembrar a
 * pessoa, nem pra saber que o código venceu.
 *
 * O lembrete antigo varria `/payments?status=PENDING`, e por isso vai
 * passar a ler daqui.
 *
 * E tem um ganho de brinde: o relógio passa a ser nosso. O lembrete lia
 * `dateCreated` do Asaas, que vem só com a data e sem hora, e em
 * 02/11/2026 isso fez uma cliente levar quatro mensagens em treze
 * minutos. Aqui o horário é gravado por nós, em milissegundos.
 *
 * Um documento por QR. Some sozinho depois de GUARDAR_DIAS — o volume é
 * baixo e cada entrada vive poucas horas de vida útil.
 */

const GUARDAR_DIAS = 3

let getStore = null
async function loja() {
  if (!getStore) ({ getStore } = await import('@netlify/blobs'))
  return getStore('pix-qr')
}

/**
 * Anota um Pix gerado. NUNCA lança: registro que quebra não pode derrubar
 * um pedido que o cliente já está vendo na tela.
 *
 * Guarda o que o lembrete vai precisar (nome, telefone, kit, total) pra
 * não ter que ir buscar em três lugares depois.
 */
export async function guardarPixQr({
  id, referencia, nome, telefone, email, kit, total, expiraEm, payload,
}) {
  try {
    if (!id) return
    const store = await loja()
    await store.setJSON(String(id), {
      referencia: String(referencia || ''),
      nome: String(nome || ''),
      telefone: String(telefone || ''),
      email: String(email || ''),
      kit: String(kit || ''),
      total: Number(total) || 0,
      // O copia-e-cola, pro toque de 5 minutos poder mandar de novo. Não
      // é segredo: é o mesmo código que a pessoa já tem na tela e no
      // WhatsApp dela.
      payload: String(payload || ''),
      criadoEm: Date.now(),
      // Vem do Asaas como "2026-11-02 15:57:53", hora de Brasília. Fica
      // guardado em ms pra não precisar interpretar fuso na hora de usar.
      expiraEm: emMs(expiraEm),
      toque: 0,
      pago: false,
    })
  } catch { /* nunca derruba quem chamou */ }
}

/**
 * "2026-11-02 15:57:53" (Brasília) -> ms.
 *
 * O `-03:00` entra na mão porque a string do Asaas não traz fuso, e
 * `new Date('2026-11-02 15:57:53')` seria interpretada como hora LOCAL do
 * servidor — que no Netlify é UTC. Três horas de diferença bastariam pra
 * o código parecer vencido assim que nasce.
 */
function emMs(quando) {
  if (!quando) return 0
  const t = Date.parse(String(quando).trim().replace(' ', 'T') + '-03:00')
  return Number.isFinite(t) ? t : 0
}

/** Um QR pelo id que o Asaas deu. */
export async function lerPixQr(id) {
  try {
    if (!id) return null
    const store = await loja()
    return await store.get(String(id), { type: 'json' })
  } catch {
    return null
  }
}

/**
 * Os Pix que ainda não foram pagos, com o id junto.
 *
 * Aproveita a leitura pra limpar o que já passou do prazo de guardar, que
 * é como esta loja não cresce pra sempre.
 */
export async function pixPendentes() {
  const saida = []
  try {
    const store = await loja()
    const { blobs } = await store.list()
    const agora = Date.now()
    await Promise.all((blobs || []).map(async (b) => {
      const d = await store.get(b.key, { type: 'json' }).catch(() => null)
      if (!d) return
      if (agora - Number(d.criadoEm || 0) > GUARDAR_DIAS * 86_400_000) {
        store.delete(b.key).catch(() => {})
        return
      }
      if (d.pago) return
      saida.push({ id: b.key, ...d })
    }))
  } catch { /* sem lista é melhor que erro 500 */ }
  return saida
}

/** Avança o toque, pra mesma mensagem não sair duas vezes. */
export async function avancarToquePix(id, toque) {
  try {
    const store = await loja()
    const d = await store.get(String(id), { type: 'json' }).catch(() => null)
    if (!d) return
    await store.setJSON(String(id), { ...d, toque: Number(toque) + 1, tocadoEm: Date.now() })
  } catch { /* silêncio proposital */ }
}

/**
 * Pagou: para tudo.
 *
 * Chamado pelo webhook. Marca em vez de apagar porque o registro ainda
 * serve pra explicar o pedido se alguém reclamar depois.
 */
export async function marcarPixPago(id) {
  try {
    if (!id) return
    const store = await loja()
    const d = await store.get(String(id), { type: 'json' }).catch(() => null)
    if (!d) return
    await store.setJSON(String(id), { ...d, pago: Date.now() })
  } catch { /* silêncio proposital */ }
}

/**
 * Acha o pedido a partir do id do QR.
 *
 * É esta função que impede o pior cenário desta mudança. A cobrança que o
 * Asaas cria sozinha quando alguém paga um QR estático pode não carregar
 * o `externalReference` do QR — a doc deles não promete isso. Sem este
 * caminho, o webhook cairia no `payment.id` como referência, e aí o
 * pedido chegaria órfão: sem etiqueta, sem atribuição no Meta e sem
 * baixa no carrinho.
 */
export async function referenciaDoQr(id) {
  const d = await lerPixQr(id)
  return d?.referencia || null
}
