/**
 * POST /api/carrinho
 *
 * Guarda quem começou a digitar no checkout e ainda não finalizou — o
 * "carrinho abandonado". Chave é o e-mail: escrever de novo só atualiza.
 * criar-pedido.mjs remove a entrada quando o pedido sai de verdade.
 */

import { salvarCarrinho } from './_lib/metricas.mjs'
import { geoDe } from './_lib/geo.mjs'

// Só o NOME do campo que a pessoa preencheu, nunca o valor — dá pra saber
// até onde ela chegou no formulário sem guardar CPF nem endereço à toa.
const CAMPOS_CONHECIDOS = new Set(['nome', 'cpf', 'email', 'tel', 'cep', 'rua', 'numero', 'compl', 'bairro', 'cidade'])

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

export default async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS })
  if (req.method !== 'POST') return new Response(null, { status: 405, headers: CORS })

  let corpo
  try { corpo = await req.json() } catch { return new Response(null, { status: 204, headers: CORS }) }

  const email = String(corpo.email ?? '').trim().toLowerCase()
  if (email && /^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/.test(email)) {
    try {
      const geo = geoDe(req)
      const campos = Array.isArray(corpo.campos)
        ? [...new Set(corpo.campos.map(String).filter((c) => CAMPOS_CONHECIDOS.has(c)))]
        : undefined
      const cidadeForm = String(corpo.cidade ?? '').trim().slice(0, 60)
      await salvarCarrinho(email, {
        nome: String(corpo.nome ?? '').trim(),
        telefone: String(corpo.telefone ?? '').trim(),
        kit: String(corpo.kit ?? '').trim(),
        em: Date.now(),
        ...(campos ? { campos } : {}),
        ...(cidadeForm ? { cidadeForm } : {}),
        ...(geo?.cidade ? { cidadeIp: geo.cidade, uf: geo.uf } : {}),
      })
    } catch { /* nunca derruba o checkout */ }
  }

  return new Response(null, { status: 204, headers: CORS })
}

export const config = { path: '/api/carrinho' }
