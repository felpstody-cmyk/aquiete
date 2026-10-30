/**
 * GET /api/admin-envio   (cabeçalho x-admin-token: ADMIN_TOKEN)
 *
 * Quem é a conta do Melhor Envio, e o remetente que a gente manda bate
 * com ela?
 *
 * A pergunta não é acadêmica. A conta pode estar no CPF dele e o envio
 * sair declarado no CNPJ do MEI — e aí a DC-e, que desde 06/04/2026 é
 * obrigatória nas encomendas sem nota, sai no nome de quem não é o
 * titular de quem postou. O `from` da API aceita qualquer coisa: ela não
 * confere, só imprime. Quem descobre a divergência é a transportadora,
 * no balcão, com o pacote na mão.
 *
 * Também devolve o saldo da carteira, que é o que trava na hora de pagar
 * a etiqueta, e o que ainda falta preencher no remetente.
 *
 * Documento vai MASCARADO. Isto aqui existe pra conferir se bate, não
 * pra transportar CPF e CNPJ por aí.
 */

import { chamar, base, configurado, soDigitos } from './_lib/melhorenvio.mjs'
import { faltaNoRemetente } from './_lib/envio.mjs'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type, x-admin-token',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
}

const json = (dados, status = 200) =>
  new Response(JSON.stringify(dados, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...CORS },
  })

/** 12345678909 -> "•••••••8909". O bastante pra ele reconhecer qual é. */
const mascarar = (v) => {
  const d = soDigitos(v)
  if (!d) return null
  return '•'.repeat(Math.max(0, d.length - 4)) + d.slice(-4)
}

const tipo = (d) => {
  const n = soDigitos(d).length
  return n === 11 ? 'CPF' : n === 14 ? 'CNPJ' : n ? `${n} dígitos` : null
}

export default async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS })

  const esperado = process.env.ADMIN_TOKEN
  if (!esperado) return json({ erro: 'ADMIN_TOKEN não configurado no Netlify' }, 500)
  if (req.headers.get('x-admin-token') !== esperado) return json({ erro: 'Token inválido' }, 401)

  const e = process.env
  const saida = {
    ambiente: (e.MELHORENVIO_AMBIENTE || 'producao').toLowerCase(),
    endereco: base(),
    modo: (e.MELHORENVIO_DESPACHO || 'carrinho').toLowerCase(),
    tokenConfigurado: configurado(),
    faltaNoRemetente: faltaNoRemetente(),
  }

  // O que a gente declara como remetente, do jeito que vai pro `from`.
  saida.remetenteQueMandamos = {
    nome: e.REMETENTE_NOME || null,
    cpf: mascarar(e.REMETENTE_CPF),
    cnpj: mascarar(e.REMETENTE_CNPJ),
    comoVai: e.REMETENTE_CPF && !e.REMETENTE_CNPJ ? 'pessoa física' : 'pessoa jurídica',
    cidade: e.REMETENTE_CIDADE || null,
    uf: e.REMETENTE_UF || null,
    cep: mascarar(e.CEP_ORIGEM),
  }

  if (!saida.tokenConfigurado) {
    saida.erro = 'MELHORENVIO_TOKEN ou CEP_ORIGEM ausente'
    return json(saida)
  }

  // Quem é o titular, segundo eles.
  try {
    const eu = await chamar('/me', { metodo: 'GET' })
    saida.conta = {
      nome: [eu?.firstname, eu?.lastname].filter(Boolean).join(' ') || eu?.name || null,
      email: eu?.email || null,
      cpf: mascarar(eu?.document),
      cnpj: mascarar(eu?.company_document),
      titular: tipo(eu?.company_document) ? 'CNPJ' : tipo(eu?.document) ? 'CPF' : 'sem documento',
    }
  } catch (err) {
    saida.conta = { erro: err.message }
  }

  // Saldo da carteira: é o que trava na hora de pagar a etiqueta.
  try {
    const b = await chamar('/me/balance', { metodo: 'GET' })
    saida.saldo = b?.balance ?? b?.saldo ?? b
  } catch (err) {
    saida.saldo = { erro: err.message }
  }

  // O veredito, que é o motivo deste endpoint existir.
  const doc = saida.conta?.cnpj || saida.conta?.cpf
  const nosso = saida.remetenteQueMandamos.cnpj || saida.remetenteQueMandamos.cpf
  if (doc && nosso) {
    saida.bate = doc === nosso
    if (!saida.bate) {
      saida.aviso =
        `A conta do Melhor Envio é ${saida.conta.titular} e o remetente que a gente declara ` +
        `é ${saida.remetenteQueMandamos.comoVai}, com documento diferente. A API aceita, ` +
        `mas a declaração de conteúdo sai no nome de quem não é o titular da postagem.`
    }
  } else if (!nosso) {
    saida.aviso = 'Nenhum documento de remetente configurado (REMETENTE_CNPJ ou REMETENTE_CPF).'
  }

  return json(saida)
}

export const config = { path: '/api/admin-envio' }
