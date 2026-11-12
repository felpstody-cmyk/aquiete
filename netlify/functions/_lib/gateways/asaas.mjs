/**
 * Adaptador Asaas — https://docs.asaas.com
 *
 * Variáveis de ambiente (painel do Netlify > Site settings > Environment):
 *   ASAAS_API_KEY   chave da API (começa com "$aact_")
 *   ASAAS_AMBIENTE  "producao" (padrão) ou "sandbox"
 *
 * O padrão é produção de propósito: a loja está vendendo. Se a variável
 * sumir ou vier escrita errada, o certo é continuar cobrando de verdade,
 * e não gerar em silêncio um Pix de mentira que ninguém consegue pagar.
 * Para testar, coloque "sandbox" na mão — e lembre de tirar depois.
 */

import { ErroDeGateway } from './index.mjs'
// diaBR porque o vencimento tem que ser o dia de BRASILIA, nao o de UTC.
// metricas.mjs nao importa nada no topo, entao isto nao faz ciclo.
import { diaBR } from '../metricas.mjs'

export const nome = 'asaas'

const BASES = {
  sandbox: 'https://api-sandbox.asaas.com/v3',
  producao: 'https://api.asaas.com/v3',
}

/** Asaas usa nomes próprios para as formas de pagamento. */
const BILLING = { pix: 'PIX', card: 'CREDIT_CARD', boleto: 'BOLETO' }

function config() {
  const chave = process.env.ASAAS_API_KEY
  if (!chave) throw new ErroDeGateway('ASAAS_API_KEY não configurada no Netlify', 500)
  const base = BASES[(process.env.ASAAS_AMBIENTE || 'producao').toLowerCase()] || BASES.producao
  return { chave, base }
}

/**
 * `segundos` desiste da chamada no nosso relogio em vez de no do Netlify.
 *
 * Isso existe por causa do cartao. A doc do Asaas manda usar "timeout
 * minimo de 60 segundos" na requisicao que processa cartao, e a funcao do
 * Netlify e morta em 26. Sem um limite nosso, uma autorizacao lenta
 * levaria a funcao junto: o processo morre no meio, ninguem sabe se a
 * cobranca passou, e o cliente aperta de novo. A doc avisa onde isso vai
 * dar — "uma nova tentativa sem verificacao pode gerar uma cobranca
 * duplicada".
 *
 * Desistindo ANTES disso ainda sobra tempo, dentro da mesma invocacao,
 * pra perguntar ao Asaas o que aconteceu com aquela referencia e
 * responder uma coisa certa pra tela.
 *
 * O erro leva `asaas` junto: o codigo de recusa decide a frase que o
 * cliente le, e cartao recusado nao e a mesma coisa que integracao
 * quebrada.
 */
async function chamar(caminho, opcoes = {}) {
  const { chave, base } = config()
  const { segundos, ...resto } = opcoes

  const resposta = await fetch(base + caminho, {
    ...resto,
    ...(segundos && typeof AbortSignal?.timeout === 'function'
      ? { signal: AbortSignal.timeout(segundos * 1000) }
      : {}),
    headers: {
      'Content-Type': 'application/json',
      access_token: chave,
      ...opcoes.headers,
    },
  })

  const corpo = await resposta.json().catch(() => ({}))
  if (!resposta.ok) {
    const primeiro = corpo?.errors?.[0]
    const detalhe = primeiro?.description || resposta.statusText
    const erro = new ErroDeGateway(`Asaas ${resposta.status}: ${detalhe}`)
    erro.asaas = {
      status: resposta.status,
      codigo: String(primeiro?.code || ''),
      descricao: String(primeiro?.description || ''),
    }
    throw erro
  }
  return corpo
}

/** Reaproveita o cliente pelo CPF em vez de duplicar cadastro a cada compra. */
async function acharOuCriarCliente(cliente) {
  const busca = await chamar(`/customers?cpfCnpj=${cliente.cpf}&limit=1`)
  if (busca?.data?.length) return busca.data[0].id

  const novo = await chamar('/customers', {
    method: 'POST',
    body: JSON.stringify({
      name: cliente.nome,
      cpfCnpj: cliente.cpf,
      email: cliente.email,
      mobilePhone: cliente.telefone,
      postalCode: cliente.cep,
      address: cliente.rua,
      addressNumber: cliente.numero,
      complement: cliente.complemento || null,
      province: cliente.bairro,
      // O Asaas manda e-mail e SMS proprios ("Cobranca criada", lembrete de
      // vencimento, convite de agenda) com a marca dele. Quem fala com o
      // cliente e a Aquiete, pelo e-mail que a gente controla.
      notificationDisabled: true,
    }),
  })
  return novo.id
}

/** Usada pelo webhook: o evento traz só o id do cliente, não os dados. */
export async function buscarCliente(id) {
  return chamar(`/customers/${encodeURIComponent(id)}`)
}

/**
 * Situação de um pedido, pela referência que a gente mesmo gerou.
 *
 * Existe para a tela do Pix saber, sozinha, a hora exata em que o
 * pagamento cai — é nesse instante que a conversão de venda paga é
 * disparada. Sem isso, só o webhook sabe, e o webhook não tem como
 * avisar o navegador de quem está com o QR aberto.
 */
export async function situacaoDoPedido(referencia) {
  const r = await chamar(`/payments?externalReference=${encodeURIComponent(referencia)}&limit=1`)
  const p = r?.data?.[0]
  if (!p) return { encontrado: false, pago: false }
  const PAGO = new Set(['RECEIVED', 'CONFIRMED', 'RECEIVED_IN_CASH'])
  return {
    encontrado: true,
    pago: PAGO.has(String(p.status || '').toUpperCase()),
    status: p.status || '',
    valor: Number(p.value) || 0,
  }
}

/**
 * Simulacao de parcelamento, feita NA CONTA DELE.
 *
 * Existe por um motivo so: a tabela de parcelas do checkout transparente
 * nao pode ser calculada por nos. Quem diz quanto o cliente paga em 3x e
 * o Asaas, com as taxas e a configuracao de repasse de juros desta conta
 * — exatamente o que a pagina hospedada diria. Juros inventado aqui
 * dentro viraria diferenca no extrato dele.
 *
 * `POST /v3/payments/simulate` NAO cria nada. A doc e explicita: "A
 * resposta representa apenas o resultado da simulacao para os parametros
 * enviados e nao substitui a criacao da cobranca."
 *
 * Uma chamada por quantidade de parcelas, em paralelo. A que falhar sai
 * da lista em vez de derrubar as outras: menos opcoes de parcela e ruim,
 * checkout fora do ar e pior.
 */
export async function simularParcelas(valor, ate = 12) {
  const alvo = Number(valor)
  if (!Number.isFinite(alvo) || alvo <= 0) return []

  const vezes = Array.from({ length: Math.max(1, Math.min(21, ate)) }, (_, i) => i + 1)
  const saida = await Promise.all(vezes.map(async (n) => {
    try {
      const r = await chamar('/payments/simulate', {
        method: 'POST',
        body: JSON.stringify({
          value: alvo,
          billingTypes: ['CREDIT_CARD'],
          // Sem installmentCount a doc trata como cobranca simples; a
          // vista e exatamente isso.
          ...(n > 1 ? { installmentCount: n } : {}),
        }),
      })
      return { parcelas: n, resposta: r }
    } catch (e) {
      console.error(`[asaas] simulate ${n}x falhou:`, e.message)
      return null
    }
  }))

  return saida.filter(Boolean)
}

/**
 * Data de vencimento no formato do Asaas (AAAA-MM-DD), em Brasília.
 *
 * NÃO usa toISOString(). Aquilo devolve a data em UTC, e entre 21h e
 * meia-noite de Brasília o "hoje" de lá já é amanhã: pedido feito às 22h
 * saía com vencimento dois dias à frente. Com o Pix vencendo no mesmo
 * dia, isso deixaria de ser um detalhe e viraria o bug inteiro.
 *
 * `diaBR` é a mesma função que decide o dia de toda métrica do sistema.
 */
function vencimento(diasAFrente) {
  return diaBR(new Date(Date.now() + diasAFrente * 86400000))
}

/** Quanto tempo o codigo do Pix vive. Decidido por ele em 02/11/2026. */
export const PIX_SEGUNDOS = 30 * 60

/** A chave Pix da conta. A primeira ativa serve: e sempre a mesma loja. */
async function chavePixDaConta() {
  const r = await chamar('/pix/addressKeys')
  const viva = (r?.data || []).find((k) => String(k.status).toUpperCase() === 'ACTIVE')
  return viva?.key || null
}

/**
 * Pix como QR Code ESTÁTICO, com 30 minutos de validade.
 *
 * O caminho da cobrança gera um BR Code `cobv` — "cobrança com
 * vencimento". O banco trata cobv como conta a pagar e oferece agendar, e
 * com chave Pix cadastrada a validade é de 12 meses depois do vencimento:
 * em 02/11/2026 uma cliente agendou o pagamento pro dia seguinte porque
 * foi a única opção que o app dela deu, e depois o app passou a mostrar
 * 2027. Mexer no `dueDate` não resolve isso.
 *
 * O QR estático é um BR Code puro, com a chave embutida e sem URL de PSP.
 * Não tem vencimento pro banco pendurar agendamento em cima, e aceita
 * expiração em segundos.
 *
 * Três campos são obrigatórios por motivo de dinheiro, não de estilo:
 *   value                   sem ele, a doc diz que o PAGADOR escolhe
 *                           quanto pagar
 *   allowsMultiplePayments  vem `true` por padrão; sem `false` o mesmo
 *                           código pode ser pago várias vezes
 *   externalReference       primeira tentativa de amarrar no pedido (a
 *                           segunda é o id do QR, guardado por nós)
 *
 * Conferido no sandbox em 02/11/2026: devolve `payload` (o copia-e-cola),
 * `encodedImage` (a imagem) e `expirationDate` 30 minutos à frente, e o
 * payload carrega a tag 54 com o valor travado.
 */
async function criarPixEstatico({ pedido, referencia }) {
  const addressKey = await chavePixDaConta()
  if (!addressKey) throw new ErroDeGateway('conta sem chave Pix cadastrada')

  const qr = await chamar('/pix/qrCodes/static', {
    method: 'POST',
    body: JSON.stringify({
      addressKey,
      // Hífen, não travessão: o Asaas COME o travessão e devolve "Aquiete
      // 2 unidades". Isto importa porque o webhook lê a quantidade de
      // frascos desta frase quando a cobrança nasce sozinha.
      description: String(pedido.descricao || 'Aquiete').replace(/—/g, '-'),
      value: pedido.total,
      format: 'ALL',
      expirationSeconds: PIX_SEGUNDOS,
      allowsMultiplePayments: false,
      externalReference: referencia,
    }),
  })

  if (!qr?.payload || !qr?.encodedImage) {
    throw new ErroDeGateway('QR estático veio sem payload ou sem imagem')
  }

  return {
    // É o id do QR, não de uma cobrança: ela só vai existir quando alguém
    // pagar. É por ele que o webhook vai achar este pedido.
    id: qr.id,
    metodo: 'pix',
    total: pedido.total,
    redirectUrl: null,
    // Não existe fatura: sem cobrança, não há página do Asaas pra abrir.
    invoiceUrl: null,
    expiraEm: qr.expirationDate || null,
    estatico: true,
    pix: { payload: qr.payload, qrBase64: qr.encodedImage },
  }
}

/**
 * O cartao digitado no NOSSO site, em vez da pagina do Asaas.
 *
 * Desligado por padrao de proposito. Enquanto `CARTAO_TRANSPARENTE` nao
 * for "1" no Netlify, cartao continua indo pra pagina hospedada exatamente
 * como sempre foi — entao subir este codigo nao muda nada pra quem esta
 * comprando agora. Ligar e desligar e uma variavel, sem deploy.
 */
const TRANSPARENTE = () => process.env.CARTAO_TRANSPARENTE === '1'

/** So digito. O Asaas recusa numero com espaco ou ponto. */
const so = (v) => String(v ?? '').replace(/\D/g, '')

/**
 * Os dois objetos de cartao, montados do jeito que a doc pede.
 *
 * `creditCardHolderInfo` nao e burocracia: e o que o antifraude do Asaas
 * usa. Todos os campos obrigatorios dele (name, email, cpfCnpj,
 * postalCode, addressNumber, phone) ja eram coletados pelo checkout, entao
 * o cliente nao digita nada a mais fora o cartao.
 *
 * `remoteIp` e o IP de QUEM COMPRA. A doc e explicita: "Informe em
 * remoteIp o IP do dispositivo do pagador, nao o IP do servidor da sua
 * aplicacao." Mandar o nosso faria todo pedido parecer vir do mesmo lugar.
 */
function dadosDoCartao({ cartao, cliente, ip }) {
  const validade = String(cartao.validade || '')
  const [mes, ano] = validade.includes('/')
    ? validade.split('/').map((x) => x.trim())
    : [validade.slice(0, 2), validade.slice(2)]

  return {
    creditCard: {
      holderName: String(cartao.nome || '').trim(),
      number: so(cartao.numero),
      expiryMonth: so(mes).padStart(2, '0').slice(0, 2),
      // Ano com 4 digitos, como a doc pede. "30" vira "2030".
      expiryYear: so(ano).length === 2 ? `20${so(ano)}` : so(ano).slice(0, 4),
      ccv: so(cartao.cvv),
    },
    creditCardHolderInfo: {
      name: cliente.nome,
      email: cliente.email,
      cpfCnpj: so(cliente.cpf),
      postalCode: so(cliente.cep),
      addressNumber: String(cliente.numero || '').trim() || 'S/N',
      phone: so(cliente.telefone),
      ...(cliente.complemento ? { addressComplement: cliente.complemento } : {}),
    },
    ...(ip ? { remoteIp: String(ip) } : {}),
  }
}

/**
 * Frase pro cliente quando o cartao nao passa, e o resgate do timeout.
 *
 * Duas coisas acontecem aqui. A primeira e traduzir: "Asaas 400:
 * invalid_creditCard" nao e texto de tela de pagamento.
 *
 * A segunda e o caso que da medo. Se a nossa chamada estourou o relogio
 * (AbortError), nao sabemos se a cobranca passou ou nao — e a doc avisa
 * que "uma nova tentativa sem verificacao pode gerar uma cobranca
 * duplicada". Entao, antes de responder qualquer coisa, pergunta pela
 * referencia: se o pagamento ja esta la, a venda ACONTECEU e nao pode ser
 * tratada como falha.
 */
async function erroDeCartao(e, referencia) {
  const abortou = e?.name === 'AbortError' || e?.name === 'TimeoutError'

  if (abortou) {
    const s = await situacaoDoPedido(referencia).catch(() => null)
    if (s?.encontrado) {
      const pronto = new Error('demorou mas entrou')
      pronto.pagamentoJaExiste = true
      return pronto
    }
    return new ErroDeGateway(
      'O banco do seu cartao demorou demais pra responder e a compra NAO foi '
      + 'cobrada. Tente de novo ou pague no Pix, que cai na hora.',
      504,
    )
  }

  const codigo = e?.asaas?.codigo || ''
  const descricao = e?.asaas?.descricao || ''

  // Recusa: a doc diz que "a cobranca nao e persistida" e volta HTTP 400.
  // Nao existe pedido fantasma pra limpar depois.
  if (e?.asaas?.status === 400) {
    const erro = new ErroDeGateway(
      descricao || 'Nao conseguimos aprovar esse cartao. Confira os dados, '
        + 'tente outro cartao ou pague no Pix.',
      400,
    )
    erro.recusado = true
    erro.codigoGateway = codigo
    return erro
  }

  return e
}

/**
 * Trava do parcelamento. Existe porque a doc do Asaas e AMBIGUA aqui.
 *
 * Em `POST /v3/payments`, `value` e descrito so como "Valor da cobranca",
 * e a doc nunca diz se, com `installmentCount`, ele passa a ser o valor da
 * PARCELA ou continua sendo o TOTAL. (Em `POST /v3/installments`, que e
 * outro endpoint, `value` e explicitamente "Valor de cada parcela".)
 *
 * Mandamos `totalValue`, que a doc descreve sem ambiguidade: "Informe o
 * valor total de uma cobranca que sera parcelada (...) o calculo por
 * parcela sera automatico". Mas "a doc parece dizer" nao e garantia boa o
 * suficiente pro caminho do dinheiro: se `value` vencesse, uma compra de
 * R$ 129,90 em 3x viraria R$ 389,70 no cartao do cliente.
 *
 * Entao a gente CONFERE o que voltou. O Asaas devolve a primeira parcela,
 * com o valor dela e a quantidade. Parcela x quantidade tem que dar o
 * total do pedido, com dois centavos de folga pro arredondamento que a doc
 * diz jogar na ultima parcela.
 *
 * Se nao der, a cobranca ja existe e esta errada: estorna e manda a pessoa
 * pro Pix. Cliente nenhum vai descobrir isso pela fatura.
 */
async function conferirParcelamento(cobranca, vezes, totalEsperado) {
  const quantas = Number(cobranca?.installmentCount) || vezes

  /*
   * Qual campo e a parcela depende da FORMA da resposta, e confundir as
   * duas e o pior engano possivel aqui:
   *
   *   objeto de cobranca -> `value` e o valor de UMA parcela
   *   objeto de plano    -> `paymentValue` e a parcela e `value` e o total
   *
   * Numa resposta de cobranca, aceitar `value == total` significaria dar
   * OK pra cada uma das 3 parcelas sair pelo valor cheio: R$ 389,70 numa
   * compra de R$ 129,90. Entao a regra e uma so, e vale nas duas formas:
   * parcela x quantidade tem que dar o total do pedido.
   */
  const parcela = Number.isFinite(Number(cobranca?.paymentValue))
    ? Number(cobranca.paymentValue)
    : Number(cobranca?.value)

  // Sem numero pra conferir nao se inventa veredito: deixa passar e o
  // console registra. Barrar aqui derrubaria venda boa por falta de campo.
  if (!Number.isFinite(parcela)) {
    console.error('[asaas] parcelamento sem valor pra conferir:', JSON.stringify({
      id: cobranca?.id, installmentCount: cobranca?.installmentCount,
    }))
    return
  }

  const somou = parcela * quantas

  /*
   * A folga e assimetrica, e tem que ser.
   *
   * A doc diz que a diferenca de arredondamento vai pra ULTIMA parcela.
   * O Asaas devolve a PRIMEIRA, entao `parcela x quantas` fica um pouco
   * ABAIXO do total: R$ 129,90 em 12x da 12 x 10,82 = R$ 129,84, seis
   * centavos a menos. Com folga simetrica de dois centavos, todo
   * parcelamento longo seria estornado por engano — venda boa recusada
   * pela trava que existe pra proteger a venda.
   *
   * Pra baixo: ate um centavo por parcela, que e o maximo que o
   * arredondamento pode empurrar pra ultima.
   * Pra cima: dois centavos, e nada mais. E aqui que mora o perigo real
   * (parcela cheia vezes 3 = R$ 389,70), e aquilo fica a trezentos
   * centavos de distancia de qualquer folga razoavel.
   */
  const folgaAbaixo = 0.02 + quantas * 0.01
  if (somou <= totalEsperado + 0.02 && somou >= totalEsperado - folgaAbaixo) return

  console.error(
    `[asaas] PARCELAMENTO FORA: ${vezes}x, esperado ${totalEsperado}, `
    + `voltou parcela=${parcela} installmentCount=${quantas} (soma ${somou})`,
  )

  // Estorna antes de contar pra alguem. Se o estorno falhar, o erro sobe
  // do mesmo jeito: melhor ele conferir uma cobranca na mao do que o
  // cliente levar um valor errado sem ninguem saber.
  await chamar(`/payments/${encodeURIComponent(cobranca.id)}/refund`, { method: 'POST' })
    .catch((e) => console.error('[asaas] estorno do parcelamento falhou:', e.message))

  throw new ErroDeGateway(
    'Nao conseguimos fechar o parcelamento com segurança e nada foi cobrado. '
    + 'Pague no Pix ou escolha cartao em 1x.',
    502,
  )
}

export async function criarCobranca({ pedido, cliente, referencia, ip, cartao, parcelas }) {
  /*
   * Pix tenta o QR estático primeiro, e CAI no caminho antigo se falhar.
   *
   * A queda não é zelo exagerado: isto é o checkout. Se o Asaas mudar o
   * endpoint, se a chave Pix sumir da conta, se der timeout — o pedido
   * continua saindo como cobrança, igual a antes. O pior caso vira
   * "funciona como ontem", nunca "a loja parou de vender".
   */
  if (pedido.metodo === 'pix') {
    try {
      return await criarPixEstatico({ pedido, referencia })
    } catch (e) {
      console.error('[asaas] QR estatico falhou, caindo na cobranca:', e.message)
    }
  }

  const customerId = await acharOuCriarCliente(cliente)

  /*
   * Cartao transparente: a pessoa digitou o cartao na NOSSA pagina.
   *
   * Isto so vale quando tem numero de cartao na mao E a variavel esta
   * ligada. Sem um dos dois, `corpo` sai identico ao de antes e a
   * cobranca volta com `invoiceUrl` — o caminho de sempre.
   *
   * O teto de 12 parcelas nao e capricho: a doc do Asaas permite 21 em
   * Visa e Mastercard mas so 12 nas outras bandeiras, e nos nao sabemos a
   * bandeira antes de tentar. 12 passa em todas.
   */
  const transparente = TRANSPARENTE() && pedido.metodo === 'card' && Boolean(cartao?.numero)
  const vezes = transparente
    ? Math.max(1, Math.min(12, Math.trunc(Number(parcelas)) || 1))
    : 1

  const corpo = {
      customer: customerId,
      billingType: BILLING[pedido.metodo],
      value: pedido.total,
      /*
       * O Pix vence HOJE. A pessoa tem até a meia-noite pra pagar.
       *
       * Com vencimento de amanhã, o payload saía como
       * `pix.asaas.com/qr/cobv/...` — cobrança COM VENCIMENTO. O banco
       * mostra cobv como conta a pagar e oferece agendar, e em
       * 02/11/2026 uma cliente agendou pro dia seguinte porque foi a
       * única opção que o app deu. Vencendo hoje não existe data futura
       * pra oferecer.
       *
       * Boleto continua com 3 dias (precisa de folga bancária) e cartão
       * com 1: o dueDate do cartão não agenda captura nenhuma, e mexer
       * nele não resolveria nada.
       */
      dueDate: vencimento(
        pedido.metodo === 'boleto' ? 3 : pedido.metodo === 'pix' ? 0 : 1,
      ),
      description: pedido.descricao,
      externalReference: referencia,
      // Cartao e boleto saem daqui pra pagina do Asaas. Sem isto, quem
      // paga no cartao nunca mais volta pro site: a venda acontece e nem
      // o cliente ve confirmacao, nem o Google registra a conversao.
      callback: {
        successUrl: `https://aquieteagora.com.br/obrigado.html?ref=${encodeURIComponent(referencia)}`,
        autoRedirect: true,
      },
      ...(transparente ? dadosDoCartao({ cartao, cliente, ip }) : {}),
      // `totalValue` e nao `value` pro parcelamento: ver conferirParcelamento,
      // que explica a ambiguidade da doc e confere o retorno por causa dela.
      ...(transparente && vezes > 1
        ? { installmentCount: vezes, totalValue: pedido.total }
        : {}),
  }

  let cobranca
  try {
    cobranca = await chamar('/payments', {
      method: 'POST',
      body: JSON.stringify(corpo),
      // 18s. A funcao do Netlify e morta em 26, e se der timeout ainda
      // precisa sobrar tempo, DENTRO da mesma invocacao, pra consultar a
      // referencia e saber se a cobranca entrou. Boleto e o caminho antigo
      // seguem sem relogio nosso, como sempre foi.
      ...(transparente ? { segundos: 18 } : {}),
    })
  } catch (e) {
    if (!transparente) throw e

    const tratado = await erroDeCartao(e, referencia)

    // Estourou o relogio mas a cobranca ESTA no Asaas. Isto e venda feita,
    // nao falha: tratar como erro aqui faria a pessoa pagar de novo.
    if (tratado?.pagamentoJaExiste) {
      return {
        id: null,
        metodo: 'card',
        total: pedido.total,
        redirectUrl: null,
        invoiceUrl: null,
        pix: null,
        transparente: true,
        parcelas: vezes,
        pago: true,
        status: 'CONFIRMED',
        desafio3ds: null,
      }
    }
    throw tratado
  }

  if (transparente && vezes > 1) {
    await conferirParcelamento(cobranca, vezes, pedido.total)
  }

  // Pix: buscamos o QR para exibir sem tirar o cliente da página.
  // Uma segunda tentativa cobre o caso de a chave Pix da conta ainda estar
  // sendo provisionada — sem QR o cliente vê erro e abandona a compra.
  let pix = null
  if (pedido.metodo === 'pix') {
    let qr = null
    for (let tentativa = 1; tentativa <= 3; tentativa++) {
      try {
        qr = await chamar(`/payments/${cobranca.id}/pixQrCode`)
        if (qr?.encodedImage) break
      } catch (e) {
        if (tentativa === 3) throw e
      }
      await new Promise((r) => setTimeout(r, 700 * tentativa))
    }
    if (!qr?.encodedImage) {
      throw new ErroDeGateway('Não foi possível gerar o QR do Pix. Tente outro método.')
    }
    pix = { payload: qr.payload, qrBase64: qr.encodedImage }
  }

  // Cartao aprovado no cartao transparente: so estes contam como dinheiro
  // dentro. AUTHORIZED de proposito NAO entra — ali o valor esta apenas
  // reservado no limite, e ninguem pagou nada ainda.
  const PAGO = new Set(['CONFIRMED', 'RECEIVED', 'RECEIVED_IN_CASH'])

  return {
    id: cobranca.id,
    metodo: pedido.metodo,
    total: pedido.total,
    // Cartão e boleto vão para a página do Asaas: os dados sensíveis
    // ficam lá, e você não entra no escopo pesado de PCI-DSS
    //
    // No transparente isto vira null: a venda ja aconteceu nesta resposta,
    // e mandar pro invoiceUrl jogaria a pessoa exatamente na pagina que a
    // gente esta tirando do caminho.
    redirectUrl: (pedido.metodo === 'pix' || transparente)
      ? null
      : (cobranca.bankSlipUrl || cobranca.invoiceUrl || null),
    // Sempre devolvido: o e-mail de "Pix gerado" usa isto como plano B
    // para quem fechou a pagina antes de pagar.
    invoiceUrl: cobranca.invoiceUrl || null,
    pix,
    ...(transparente ? {
      transparente: true,
      parcelas: vezes,
      pago: PAGO.has(String(cobranca.status || '').toUpperCase()),
      status: cobranca.status || '',
      /*
       * 3DS. Nao pedimos o desafio (nao mandamos `threeDSecure`), mas o
       * EMISSOR pode exigir de todo jeito — a doc diz que este campo e
       * "retornado apenas quando o desafio de autenticacao e exigido pelo
       * emissor do cartao". Quando vier, a pessoa TEM que passar por essa
       * URL ou a transacao nao se completa, e engolir isso aqui seria
       * perder a venda com o dinheiro preso.
       *
       * E uma URL do banco dela, nao a pagina de cobranca do Asaas: nao
       * tem nome nem CNPJ de ninguem nela.
       */
      desafio3ds: cobranca.threeDSecureChallengeUrl || null,
    } : {}),
  }
}
