/**
 * GET /api/sonda-parcelamento   (cabeçalho x-admin-token: ADMIN_TOKEN)
 *
 * ARQUIVO TEMPORÁRIO. Nasceu pra responder UMA pergunta e deve ser
 * apagado depois dela respondida.
 *
 * ---------------------------------------------------------------
 *  A PERGUNTA
 * ---------------------------------------------------------------
 * A doc do Asaas não diz se, em `POST /v3/payments` com
 * `installmentCount`, o campo `value` passa a ser o valor DA PARCELA ou
 * continua sendo o TOTAL. Chutar isso significaria arriscar cobrar
 * R$ 389,70 numa compra de R$ 129,90.
 *
 * Se `value` puder ser OMITIDO, a ambiguidade desaparece: manda-se só
 * `totalValue`, que a doc descreve sem margem de dúvida, e não há segundo
 * campo pra disputar o sentido.
 *
 * ---------------------------------------------------------------
 *  POR QUE ISTO NÃO COBRA NADA DE NINGUÉM
 * ---------------------------------------------------------------
 * O cartão enviado está VENCIDO (01/2020). O Asaas valida validade antes
 * de falar com adquirente, então:
 *
 *   - se a resposta reclamar de `value`, aprendemos que ele é obrigatório
 *   - se reclamar do CARTÃO, aprendemos que `value` é dispensável
 *
 * Nos dois casos a resposta é 400 e, pela própria doc, "a cobrança não é
 * persistida". Não nasce cobrança, não há transação em adquirente, não há
 * o que estornar. `authorizeOnly: true` vai junto como segunda trava: se o
 * cartão milagrosamente passasse, o valor só ficaria reservado.
 *
 * Também não cria cliente: usa um que já existe na conta.
 */

const BASES = {
  sandbox: 'https://api-sandbox.asaas.com/v3',
  producao: 'https://api.asaas.com/v3',
}

const json = (dados, status = 200) =>
  new Response(JSON.stringify(dados, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  })

async function asaas(caminho, opcoes = {}) {
  const chave = process.env.ASAAS_API_KEY
  const base = BASES[(process.env.ASAAS_AMBIENTE || 'producao').toLowerCase()] || BASES.producao
  const r = await fetch(base + caminho, {
    ...opcoes,
    headers: { 'Content-Type': 'application/json', access_token: chave, ...opcoes.headers },
  })
  const corpo = await r.json().catch(() => ({}))
  return { status: r.status, corpo }
}

/* Vencido de propósito. É isto que impede qualquer transação de verdade. */
const CARTAO_MORTO = {
  holderName: 'SONDA TESTE',
  number: '4111111111111111',
  expiryMonth: '01',
  expiryYear: '2020',
  ccv: '123',
}

export default async (req) => {
  const esperado = process.env.ADMIN_TOKEN
  if (!esperado) return json({ erro: 'ADMIN_TOKEN não configurado' }, 500)
  if (req.headers.get('x-admin-token') !== esperado) return json({ erro: 'Token inválido' }, 401)

  if (!process.env.ASAAS_API_KEY) return json({ erro: 'ASAAS_API_KEY não configurada' }, 500)

  // Cliente que JÁ existe: a sonda não cadastra ninguém.
  const lista = await asaas('/customers?limit=1')
  const customer = lista.corpo?.data?.[0]?.id
  if (!customer) return json({ erro: 'nenhum cliente na conta pra usar na sonda', lista }, 500)

  const amanha = new Date(Date.now() + 86400000).toISOString().slice(0, 10)
  const titular = {
    name: 'Sonda Teste',
    email: 'sonda@aquieteagora.com.br',
    cpfCnpj: '52998224725',
    postalCode: '89801000',
    addressNumber: '10',
    phone: '47999999999',
  }

  const base = {
    customer,
    billingType: 'CREDIT_CARD',
    dueDate: amanha,
    description: 'SONDA - nao cobrar',
    externalReference: 'SONDA-PARCELAMENTO',
    creditCard: CARTAO_MORTO,
    creditCardHolderInfo: titular,
    remoteIp: '200.1.2.3',
    authorizeOnly: true,
  }

  const provas = {}

  // 1. SEM `value`. É a pergunta principal.
  provas.sem_value = await asaas('/payments', {
    method: 'POST',
    body: JSON.stringify({ ...base, installmentCount: 3, totalValue: 129.90 }),
  })

  // 2. Com `value`, pra ter a resposta de controle: qual erro aparece
  //    quando o corpo está completo. Serve pra saber se o erro da prova 1
  //    foi do `value` ou era do cartão desde o começo.
  provas.com_value = await asaas('/payments', {
    method: 'POST',
    body: JSON.stringify({ ...base, value: 129.90, installmentCount: 3, totalValue: 129.90 }),
  })

  // 3. Cobrança simples, sem parcelamento nenhum: a terceira referência.
  provas.sem_parcelamento = await asaas('/payments', {
    method: 'POST',
    body: JSON.stringify({ ...base, value: 129.90 }),
  })

  /*
   * Confere que a sonda não deixou nada atrás de si. Busca pela referência
   * que ela mesma usou: se a doc estiver certa, vem lista vazia.
   */
  const sobrou = await asaas('/payments?externalReference=SONDA-PARCELAMENTO&limit=10')

  return json({
    leia:
      'Se sem_value reclamar do CARTAO (invalid_creditCard / expirado), `value` e '
      + 'dispensavel e a ambiguidade acaba. Se reclamar de `value`, ele e obrigatorio.',
    customerUsado: customer,
    provas,
    nadaFicouAtras: {
      quantas: sobrou.corpo?.totalCount,
      ids: (sobrou.corpo?.data || []).map((p) => ({
        id: p.id, value: p.value, status: p.status, installment: p.installment,
      })),
    },
  })
}

export const config = { path: '/api/sonda-parcelamento' }
