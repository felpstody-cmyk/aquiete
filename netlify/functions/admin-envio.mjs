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
import { listaDeVetos, vetar } from './_lib/dce.mjs'

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

/**
 * Cota um pacote de dimensões arbitrárias, pra comparar caixas antes de
 * trocar a do catálogo.
 *
 * A cotação do site só sabe cotar os kits que existem. Aqui a pergunta é
 * outra: "quanto mudaria se a caixa fosse assim?". Sem isso a resposta
 * seria teoria — e teoria de cubagem erra, porque cada transportadora
 * tem mínimo e faixa própria.
 */
async function cotarCaixa(cep, cx) {
  const corpo = {
    from: { postal_code: soDigitos(process.env.CEP_ORIGEM) },
    to: { postal_code: soDigitos(cep) },
    package: { height: cx.a, width: cx.l, length: cx.c, weight: cx.p },
    options: { receipt: false, own_hand: false, insurance_value: 0 },
  }
  const lista = await chamar('/me/shipment/calculate', { corpo })
  const fora = {}
  for (const s of Array.isArray(lista) ? lista : []) {
    const nome = `${s.company?.name || ''} ${s.name}`.trim()
    fora[nome] = s.error ? `— ${s.error}` : Number(Number(s.price).toFixed(2))
  }
  return fora
}

/** O que a transportadora cobra: o maior entre o peso real e o cúbico. */
const cubado = (cx) => Number(((cx.c * cx.l * cx.a) / 6000).toFixed(3))

/**
 * O cadastro comercial do gateway, pra montar o REMETENTE_* sem digitar.
 *
 * É a melhor fonte que existe pra isso: são os dados que ele já declarou
 * pra receber dinheiro, conferidos contra a Receita na abertura da conta.
 * Digitar de novo à mão é onde entra o erro de um dígito que só aparece
 * quando a transportadora recusa o pacote.
 *
 * Isto devolve os valores INTEIROS, de propósito — eles são pra copiar e
 * colar no Netlify, e nenhum deles é segredo: razão social, CNPJ e
 * endereço do remetente vão impressos na etiqueta que o cliente recebe.
 */
async function cadastroDoGateway() {
  const chave = process.env.ASAAS_API_KEY
  if (!chave) return { erro: 'ASAAS_API_KEY não configurada' }

  const base =
    (process.env.ASAAS_AMBIENTE || 'producao').toLowerCase() === 'sandbox'
      ? 'https://api-sandbox.asaas.com/v3'
      : 'https://api.asaas.com/v3'

  const r = await fetch(`${base}/myAccount/commercialInfo`, {
    headers: { access_token: chave, 'Content-Type': 'application/json' },
  })
  const d = await r.json().catch(() => ({}))
  if (!r.ok) return { erro: d?.errors?.[0]?.description || `HTTP ${r.status}` }

  const doc = soDigitos(d.cpfCnpj)
  return {
    comoEstaNoAsaas: {
      razaoSocial: d.name || null,
      nomeFantasia: d.tradingName || null,
      documento: doc,
      tipo: doc.length === 14 ? 'CNPJ' : doc.length === 11 ? 'CPF' : '?',
      telefone: soDigitos(d.mobilePhone || d.phone) || null,
      endereco: [d.address, d.addressNumber, d.complement].filter(Boolean).join(', '),
      bairro: d.province || null,
      cidade: d.cityName || null,
      uf: d.state || null,
      cep: soDigitos(d.postalCode) || null,
    },
    // Pronto pra colar no Netlify.
    paraColar: [
      `REMETENTE_NOME=${d.name || ''}`,
      doc.length === 14 ? `REMETENTE_CNPJ=${doc}` : `REMETENTE_CPF=${doc}`,
      `REMETENTE_RUA=${d.address || ''}`,
      `REMETENTE_NUMERO=${d.addressNumber || ''}`,
      ...(d.complement ? [`REMETENTE_COMPLEMENTO=${d.complement}`] : []),
      `REMETENTE_BAIRRO=${d.province || ''}`,
      `REMETENTE_CIDADE=${d.cityName || ''}`,
      `REMETENTE_UF=${d.state || ''}`,
      `REMETENTE_TELEFONE=${soDigitos(d.mobilePhone || d.phone)}`,
    ].join('\n'),
  }
}

export default async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS })

  const esperado = process.env.ADMIN_TOKEN
  if (!esperado) return json({ erro: 'ADMIN_TOKEN não configurado no Netlify' }, 500)
  if (req.headers.get('x-admin-token') !== esperado) return json({ erro: 'Token inválido' }, 401)

  const e = process.env

  // Modo comparador de caixa: ?cep=01310100&c=11&l=11&a=7&p=0.1
  // Cota a caixa atual e a proposta lado a lado, no mesmo CEP.
  const q = new URL(req.url).searchParams

  /*
   * ?vetar=<id do serviço>&uf=<UF>&nome=<rótulo>
   *
   * A lista do DC-e se preenche sozinha com as recusas, mas só a partir
   * do momento em que ela passou a existir. Isto é pra plantar o que já
   * se sabe de antes — e pra quando o suporte da transportadora disser
   * que não atende um estado, antes de custar uma venda pra descobrir.
   */
  if (q.get('vetar')) {
    await vetar(q.get('vetar'), String(q.get('uf') || '').toUpperCase(), q.get('nome') || '', 'anotado na mão')
    return json({ ok: true, lista: await listaDeVetos() })
  }

  // ?gateway=1 — monta o REMETENTE_* a partir do cadastro do Asaas.
  if (q.get('gateway')) {
    return json(await cadastroDoGateway().catch((err) => ({ erro: err.message })))
  }

  if (q.get('cep')) {
    const nova = {
      c: Number(q.get('c')), l: Number(q.get('l')),
      a: Number(q.get('a')), p: Number(q.get('p') || 0.1),
    }
    const atual = { c: 19, l: 12, a: 7, p: Number(q.get('p') || 0.1) }
    const [precoAtual, precoNovo] = await Promise.all([
      cotarCaixa(q.get('cep'), atual).catch((err) => ({ erro: err.message })),
      cotarCaixa(q.get('cep'), nova).catch((err) => ({ erro: err.message })),
    ])
    return json({
      cep: q.get('cep'),
      atual: { medidas: `${atual.c}x${atual.l}x${atual.a}`, cubado: cubado(atual), real: atual.p, precos: precoAtual },
      nova: { medidas: `${nova.c}x${nova.l}x${nova.a}`, cubado: cubado(nova), real: nova.p, precos: precoNovo },
    })
  }

  // Quem já recusou Declaração de Conteúdo, e em que estado. Vem junto
  // porque "por que o frete subiu nesse estado?" é a pergunta que essa
  // lista responde, e ela some do log em poucos dias.
  const vetos = await listaDeVetos().catch(() => ({}))

  const saida = {
    ambiente: (e.MELHORENVIO_AMBIENTE || 'producao').toLowerCase(),
    semDeclaracaoDeConteudo: Object.entries(vetos).map(([k, v]) => `${v.nome || k} em ${k.split(':')[1]}`),
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
