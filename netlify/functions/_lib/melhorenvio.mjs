/**
 * Conversa com o Melhor Envio: cotação de frete, e o transporte que o
 * despacho usa pra criar o envio (ver _lib/envio.mjs).
 *
 * A cotação roda NO SERVIDOR, pelo mesmo motivo do preço: o valor do
 * frete que o navegador manda é ignorado. Quem cota é aqui, e
 * `criar-pedido` cota de novo antes de cobrar — senão qualquer um
 * escolhe SEDEX e paga PAC.
 *
 * Precisa de três variáveis no Netlify:
 *   MELHORENVIO_TOKEN     token de Integrações > Tokens, na conta dele
 *   MELHORENVIO_AMBIENTE  "sandbox" para testar, "producao" para valer
 *   CEP_ORIGEM            de onde sai a encomenda (Chapecó)
 *
 * Sem o token a cotação devolve lista vazia em vez de estourar: a loja
 * continua vendendo com o frete fixo de antes, que é melhor que um
 * checkout quebrado.
 */
import { KITS } from './catalogo.mjs'
import { ufDoCep, vetados } from './dce.mjs'

const BASES = {
  sandbox: 'https://sandbox.melhorenvio.com.br/api/v2',
  producao: 'https://melhorenvio.com.br/api/v2',
}

/** O Melhor Envio recusa chamada sem User-Agent com contato. */
const AGENTE = 'Aquiete (contato@aquieteagora.com.br)'

export const soDigitos = (v) => String(v ?? '').replace(/\D/g, '')

export function configurado() {
  return Boolean(process.env.MELHORENVIO_TOKEN && process.env.CEP_ORIGEM)
}

export function base() {
  const amb = (process.env.MELHORENVIO_AMBIENTE || 'producao').toLowerCase()
  return BASES[amb] || BASES.producao
}

/**
 * Uma chamada à API deles. Lança com o corpo do erro no texto, porque o
 * 422 do Melhor Envio diz campo a campo o que faltou — e sem isso a
 * investigação morre num "422" seco.
 */
export async function chamar(caminho, { metodo = 'POST', corpo } = {}) {
  if (!process.env.MELHORENVIO_TOKEN) throw new Error('MELHORENVIO_TOKEN não configurado')

  const r = await fetch(base() + caminho, {
    method: metodo,
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.MELHORENVIO_TOKEN}`,
      'User-Agent': AGENTE,
    },
    ...(corpo === undefined ? {} : { body: JSON.stringify(corpo) }),
  })

  const texto = await r.text()
  let dados = null
  try { dados = texto ? JSON.parse(texto) : null } catch { /* vem HTML quando cai */ }

  if (!r.ok) {
    const detalhe =
      dados?.message ||
      (dados?.errors && JSON.stringify(dados.errors)) ||
      texto.slice(0, 300) ||
      r.statusText
    throw new Error(`Melhor Envio ${r.status}: ${detalhe}`)
  }
  return dados
}

/**
 * Devolve as opções de envio para um kit e um CEP.
 * Cada item: { id, nome, empresa, preco, prazo }
 */
export async function cotar(kitId, cepDestino) {
  if (!configurado()) return []

  const kit = KITS[String(kitId)]
  if (!kit?.caixa) return []

  const destino = soDigitos(cepDestino)
  if (destino.length !== 8) return []

  const corpo = {
    from: { postal_code: soDigitos(process.env.CEP_ORIGEM) },
    to: { postal_code: destino },
    package: {
      height: kit.caixa.altura,
      width: kit.caixa.largura,
      length: kit.caixa.comprimento,
      weight: kit.caixa.peso,
    },
    // Sem valor declarado: seguro encarece o frete e a reposição de um
    // frasco custa menos que o seguro de um ano de pedidos.
    options: { receipt: false, own_hand: false, insurance_value: 0 },
  }

  const lista = await chamar('/me/shipment/calculate', { corpo })
  if (!Array.isArray(lista)) return []

  /*
   * Fora quem já recusou Declaração de Conteúdo neste estado.
   *
   * MEI não emite nota: se a transportadora não aceita DC-e no destino,
   * aquele preço não serve pra nada — ela vai recusar na hora de postar.
   * Mostrar mesmo assim é cobrar um frete que não dá pra usar e pagar a
   * diferença do calado. Ver dce.mjs.
   */
  const uf = ufDoCep(destino)
  const fora = uf ? await vetados().catch(() => new Set()) : new Set()

  return lista
    // Serviço indisponível para o CEP vem com `error` preenchido.
    .filter((s) => !s.error && Number(s.price) > 0)
    .filter((s) => !fora.has(`${s.id}:${uf}`))
    .map((s) => ({
      id: String(s.id),
      nome: s.name,
      empresa: s.company?.name || '',
      preco: Number(Number(s.price).toFixed(2)),
      prazo: Number(s.delivery_time) || null,
    }))
    .sort((a, b) => a.preco - b.preco)
}

/**
 * Confere, na hora de cobrar, se o serviço que o navegador escolheu
 * existe mesmo e por quanto. Devolve a opção ou null.
 */
export async function conferir(kitId, cep, servicoId) {
  const opcoes = await cotar(kitId, cep).catch(() => [])
  return opcoes.find((o) => o.id === String(servicoId)) || null
}
