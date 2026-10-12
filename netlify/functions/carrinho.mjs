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
  // O fim precisa ser só letras. A regra antiga aceitava "fulano@gmail.com25",
  // que é o que sobra quando a pessoa começa a digitar o CEP antes de o foco
  // sair do campo de e-mail. Cada variação dessas virava um carrinho separado
  // no painel, marcado como abandonado, para a mesma pessoa.
  if (email && /^[^@\s]+@[^@\s]+\.[a-z]{2,24}$/.test(email)) {
    try {
      const geo = geoDe(req)
      const campos = Array.isArray(corpo.campos)
        ? [...new Set(corpo.campos.map(String).filter((c) => CAMPOS_CONHECIDOS.has(c)))]
        : undefined
      const cidadeForm = String(corpo.cidade ?? '').trim().slice(0, 60)
      // De qual anuncio essa pessoa veio. Vem do navegador porque so ele
      // sabe a PRIMEIRA visita: aqui no servidor chega so o ultimo clique.
      const o = corpo.origem && typeof corpo.origem === 'object' ? corpo.origem : null
      const origem = o
        ? {
            camp: String(o.camp ?? '').slice(0, 60),
            src: String(o.src ?? '').slice(0, 40),
            med: String(o.med ?? '').slice(0, 40),
            anuncio: String(o.anuncio ?? '').slice(0, 60),
            pagina: String(o.pagina ?? '').slice(0, 40),
          }
        : null

      await salvarCarrinho(email, {
        ...(origem ? { origem } : {}),
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
