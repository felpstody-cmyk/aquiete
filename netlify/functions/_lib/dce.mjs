/**
 * Quem não aceita Declaração de Conteúdo, por estado.
 *
 * O problema: MEI não emite nota, então toda encomenda daqui vai com
 * DC-e. Parte das transportadoras recusa DC-e dependendo do estado de
 * destino, e a cotação NÃO avisa — o campo não existe na resposta do
 * `/me/shipment/calculate`. A recusa só aparece na hora de criar o
 * envio, quando o cliente já pagou.
 *
 * Aconteceu em 30/10/2026: a Loggi Ponto era a mais barata pro Rio
 * Grande do Norte (R$ 17,62), o cliente pagou por ela, e na hora de
 * postar veio "esta transportadora não aceita envios com Declaração de
 * Conteúdo para o estado de destino". O envio saiu na Jadlog por
 * R$ 22,38 e a diferença de R$ 4,76 saiu da margem.
 *
 * Como isto resolve: cada recusa fica gravada como `servico:UF`, e a
 * cotação passa a esconder aquela opção naquele estado. O primeiro
 * cliente de cada combinação ainda custa a diferença; do segundo em
 * diante o preço cotado é um preço que dá pra usar.
 *
 * A lista é aprendida, não escrita à mão de propósito: as regras das
 * transportadoras mudam sem aviso, e tabela escrita à mão envelhece
 * calada. Esta se corrige sozinha.
 */

const soDigitos = (v) => String(v ?? '').replace(/\D/g, '')

/*
 * Faixa de CEP -> UF. Pares [último CEP da faixa, UF], em ordem
 * crescente. Mora aqui, e não em envio.mjs, porque a cotação precisa
 * dele e envio.mjs já importa melhorenvio.mjs — pôr lá fecharia um
 * ciclo entre os dois.
 */
const FAIXAS_UF = [
  [19999, 'SP'], [28999, 'RJ'], [29999, 'ES'], [39999, 'MG'], [48999, 'BA'],
  [49999, 'SE'], [56999, 'PE'], [57999, 'AL'], [58999, 'PB'], [59999, 'RN'],
  [63999, 'CE'], [64999, 'PI'], [65999, 'MA'], [68899, 'PA'], [68999, 'AP'],
  [69299, 'AM'], [69399, 'RR'], [69899, 'AM'], [69999, 'AC'], [72799, 'DF'],
  [72999, 'GO'], [73699, 'DF'], [76799, 'GO'], [76999, 'RO'], [77999, 'TO'],
  [78899, 'MT'], [78999, 'RO'], [79999, 'MS'], [87999, 'PR'], [89999, 'SC'],
  [99999, 'RS'],
]

export function ufDoCep(cep) {
  const n = Number(soDigitos(cep).slice(0, 5))
  if (!n) return ''
  const faixa = FAIXAS_UF.find(([ate]) => n <= ate)
  return faixa ? faixa[1] : ''
}

/** A mensagem de recusa por Declaração de Conteúdo, nas formas que ela chega. */
export const ehRecusaDeDce = (texto) => /aceita[\s\S]*Declara/i.test(String(texto || ''))

let getStore = null
async function loja() {
  if (!getStore) ({ getStore } = await import('@netlify/blobs'))
  return getStore('dce-vetos')
}

/*
 * Cache em memória. A cotação roda no caminho do checkout, com o cliente
 * olhando a tela: ler o blob a cada frete somaria latência onde ela
 * aparece. A função fica quente entre chamadas, e cinco minutos de
 * atraso pra aprender uma recusa nova não muda nada.
 */
let cache = null
let cacheEm = 0
const VALIDADE = 5 * 60 * 1000

export async function vetados() {
  if (cache && Date.now() - cacheEm < VALIDADE) return cache
  try {
    const store = await loja()
    const doc = (await store.get('lista', { type: 'json' })) || {}
    cache = new Set(Object.keys(doc))
    cacheEm = Date.now()
  } catch {
    // Sem a lista é melhor cotar tudo do que não cotar nada: o pior caso
    // volta a ser o de antes, uma recusa na hora de postar.
    cache = cache || new Set()
  }
  return cache
}

/** Grava a recusa. Chamado pelo despacho, quando a transportadora nega. */
export async function vetar(servicoId, uf, nome, motivo) {
  try {
    if (!servicoId || !uf) return
    const chave = `${servicoId}:${uf}`
    const store = await loja()
    const doc = (await store.get('lista', { type: 'json' }).catch(() => null)) || {}
    if (doc[chave]) return
    doc[chave] = { nome: nome || '', motivo: String(motivo || '').slice(0, 200), em: Date.now() }
    await store.setJSON('lista', doc)
    cache = null
    console.log('[dce] %s nao aceita Declaracao de Conteudo em %s — fora da cotacao daqui pra frente', nome || servicoId, uf)
  } catch (e) {
    console.log('[dce] nao consegui gravar o veto:', e.message)
  }
}

/** Pro painel e pro diagnóstico: a lista inteira, pra dar pra ver e pra apagar. */
export async function listaDeVetos() {
  try {
    const store = await loja()
    return (await store.get('lista', { type: 'json' })) || {}
  } catch {
    return {}
  }
}
