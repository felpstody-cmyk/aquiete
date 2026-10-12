/**
 * Registro do que aconteceu com cada zap que a loja tentou mandar.
 *
 * Existe porque o envio falhava em silêncio. Quando alguém dizia "não
 * recebi", não havia onde olhar: só dava pra adivinhar entre telefone
 * inválido, sessão caída, trava de repetição ou erro da API. Agora dá
 * pra abrir o painel e ler.
 *
 * Guarda os últimos envios num documento só, não um por envio: o volume
 * é baixo e assim a leitura do painel é uma chamada, não trezentas.
 */

const CHAVE = 'ultimos'
const LIMITE = 60

let getStore = null
async function loja() {
  if (!getStore) ({ getStore } = await import('@netlify/blobs'))
  return getStore('zap-log')
}

/**
 * Anota uma tentativa. NUNCA lança: registro que quebra é pior que
 * registro que falta, porque derrubaria o pedido junto.
 */
export async function registrarZap({ referencia, nome, telefone, etapa, resultado }) {
  try {
    const store = await loja()
    const antes = (await store.get(CHAVE, { type: 'json' })) || []
    const linha = {
      em: Date.now(),
      referencia: referencia || '',
      nome: nome || '',
      // Só os últimos dígitos: o telefone inteiro já está no carrinho, e
      // aqui o que importa é conseguir reconhecer de quem é a linha.
      telefone: String(telefone || '').replace(/\D/g, '').slice(-4),
      etapa: etapa || '',
      enviado: Boolean(resultado?.enviado),
      erro: resultado?.erro || '',
      // O id liga esta linha ao aviso de entrega que chega depois, pelo
      // webhook. Sem ele, "enviado" so quer dizer "a API aceitou".
      id: String(resultado?.id || ''),
      situacao: resultado?.enviado ? 'aceita' : '',
    }
    await store.setJSON(CHAVE, [linha, ...antes].slice(0, LIMITE))
  } catch { /* nunca derruba quem chamou */ }
}

/** O que o painel mostra. Nunca lança. */
export async function lerZapLog() {
  try {
    const store = await loja()
    return (await store.get(CHAVE, { type: 'json' })) || []
  } catch {
    return []
  }
}

/**
 * O WhatsApp avisa depois o que aconteceu com cada mensagem: entregue,
 * lida, ou falhou. Isso vem pelo webhook e cai aqui.
 *
 * Nunca lança: webhook que quebra faz o provedor parar de mandar aviso.
 */
export async function marcarEntrega(id, situacao, motivo = '') {
  if (!id) return false
  try {
    const store = await loja()
    const linhas = (await store.get(CHAVE, { type: 'json' })) || []
    const i = linhas.findIndex((l) => l.id === id)
    if (i < 0) return false
    // A ordem importa: 'lida' nao pode voltar pra 'entregue' se um aviso
    // antigo chegar atrasado, o que acontece.
    const peso = { aceita: 1, enviada: 2, entregue: 3, lida: 4, falhou: 9 }
    if ((peso[situacao] || 0) < (peso[linhas[i].situacao] || 0)) return false
    linhas[i].situacao = situacao
    linhas[i].situacaoEm = Date.now()
    if (motivo) linhas[i].erro = String(motivo).slice(0, 140)
    await store.setJSON(CHAVE, linhas)
    return true
  } catch {
    return false
  }
}
