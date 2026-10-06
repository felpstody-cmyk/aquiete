/**
 * GET /api/frete?kit=2&cep=01010000
 *
 * Devolve as opções de envio para o checkout montar a lista. Público de
 * propósito: não expõe nada além do que o cliente já vai ver na tela, e
 * exigir token aqui só atrapalharia quem está comprando.
 *
 * Se o Melhor Envio não estiver configurado ou cair, devolve
 * `{ opcoes: [] }` e o checkout volta sozinho pro frete fixo da tabela.
 * Frete é parte do caminho do dinheiro: ele degrada, nunca quebra.
 */
import { cotar, configurado } from './_lib/melhorenvio.mjs'
import { KITS } from './_lib/catalogo.mjs'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
}

const json = (dados, status = 200) =>
  new Response(JSON.stringify(dados), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...CORS },
  })

export default async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS })

  const url = new URL(req.url)
  const kit = url.searchParams.get('kit') || ''
  const cep = url.searchParams.get('cep') || ''

  if (!KITS[String(kit)]) return json({ opcoes: [], erro: 'kit' })
  if (!configurado()) return json({ opcoes: [], motivo: 'nao-configurado' })

  try {
    return json({ opcoes: await cotar(kit, cep) })
  } catch (e) {
    // O cliente não tem nada a ver com erro de integração: devolve vazio
    // e deixa o checkout usar a tabela fixa.
    return json({ opcoes: [], motivo: String(e.message || e) })
  }
}

export const config = { path: '/api/frete' }
