/**
 * Despacho no Melhor Envio: cria o envio lá no momento em que o
 * pagamento confirma.
 *
 * Até aqui a integração só COTAVA. O checkout perguntava o preço e
 * cobrava, mas nada chegava no painel do Melhor Envio: toda venda era
 * digitada na mão. E o serviço que o cliente pagou se perdia — na
 * primeira venda de verdade sobrou só o valor, R$ 17,62, sem dizer se
 * era PAC, SEDEX ou Jadlog.
 *
 * ---------------------------------------------------------------
 * Declaração de conteúdo, que é o que vale pra esta loja:
 *
 * MEI não precisa emitir NF-e pra consumidor pessoa física, então o
 * envio vai como NÃO comercial. A regra da API, nessa modalidade:
 *
 *   options.non_commercial = true
 *   options.invoice         NÃO enviar
 *   from.state_register     vazio ou "ISENTO"
 *
 * O documento do remetente é o CNPJ do MEI (REMETENTE_CNPJ) ou o CPF
 * dele (REMETENTE_CPF), nunca os dois. Tem que ser o mesmo titular da
 * conta do Melhor Envio: `/api/admin-envio` compara os dois e avisa.
 *
 * E desde 06/04/2026 a DC-e (declaração de conteúdo eletrônica) é
 * obrigatória nas encomendas sem nota, por determinação do Confaz. Quem
 * gera é o próprio Melhor Envio a partir do que vai em `products`, e por
 * isso esse array tem que estar correto e completo: nome de verdade,
 * quantidade e valor unitário. Declaração de papel preenchida à mão não
 * é mais aceita.
 * ---------------------------------------------------------------
 *
 * Nada aqui pode derrubar um pedido nem o webhook. O cliente pagou; se o
 * Melhor Envio estiver fora do ar, a venda continua válida e o envio é
 * criado na mão, como era antes.
 */

import { KITS } from './catalogo.mjs'
import { chamar, cotar, configurado, soDigitos } from './melhorenvio.mjs'

let getStore = null
async function loja() {
  if (!getStore) ({ getStore } = await import('@netlify/blobs'))
  return getStore('despachos')
}

/**
 * Até onde ir sozinho. Em `carrinho`, o envio aparece no painel e ele
 * confere e compra; em `completo`, a etiqueta é paga com o saldo da
 * carteira e sai o link pra imprimir.
 *
 * O padrão é `carrinho` de propósito: comprar etiqueta gasta dinheiro de
 * verdade, e uma venda estornada depois deixaria a etiqueta paga.
 */
const MODO = () => (process.env.MELHORENVIO_DESPACHO || 'carrinho').toLowerCase()

/**
 * Remetente. Mora em variável de ambiente porque a API exige o endereço
 * completo de quem posta e isso não existe em lugar nenhum do código —
 * `CEP_ORIGEM` sozinho não serve pra criar envio, só pra cotar.
 */
function remetente() {
  const e = process.env
  /*
   * Quem posta: o MEI (CNPJ) ou ele como pessoa física (CPF). Tem que
   * ser o MESMO titular da conta do Melhor Envio — a API aceita qualquer
   * documento aqui, ela não confere, só imprime. Quem descobre a
   * divergência é a transportadora, no balcão, com o pacote na mão.
   * `/api/admin-envio` diz em que nome a conta está.
   *
   * Mandar os dois preenchidos faz o Melhor Envio não saber quem está
   * postando, então é um ou o outro, e o CNPJ ganha quando existe.
   */
  const cnpj = soDigitos(e.REMETENTE_CNPJ)
  const cpf = soDigitos(e.REMETENTE_CPF)
  return {
    name: e.REMETENTE_NOME || '',
    email: e.REMETENTE_EMAIL || 'contato@aquieteagora.com.br',
    phone: soDigitos(e.REMETENTE_TELEFONE),
    document: cnpj ? '' : cpf,
    company_document: cnpj,
    // Inscrição estadual só existe em pessoa jurídica, e MEI é isento.
    // Como pessoa física o campo não se aplica e vai vazio.
    state_register: cnpj ? (e.REMETENTE_IE || 'ISENTO') : '',
    address: e.REMETENTE_RUA || '',
    complement: e.REMETENTE_COMPLEMENTO || '',
    number: String(e.REMETENTE_NUMERO || ''),
    district: e.REMETENTE_BAIRRO || '',
    city: e.REMETENTE_CIDADE || '',
    state_abbr: String(e.REMETENTE_UF || '').toUpperCase().slice(0, 2),
    country_id: 'BR',
    postal_code: soDigitos(e.CEP_ORIGEM),
    note: '',
    // Obrigatório só pra LATAM Cargo. Vai se existir; omitir é melhor que
    // mandar vazio, que a API trata como valor inválido.
    ...(e.REMETENTE_CNAE ? { economic_activity_code: soDigitos(e.REMETENTE_CNAE) } : {}),
  }
}

/*
 * Tudo que a API exige do remetente, sem exceção, senão nem tenta.
 *
 * Mapeado campo da API -> nome da variável no Netlify de propósito: quem
 * lê o aviso precisa saber o que preencher, e "district" não diz a
 * ninguém que o que falta é o bairro.
 */
const CAMPOS_REMETENTE = {
  name: 'REMETENTE_NOME',
  address: 'REMETENTE_RUA',
  number: 'REMETENTE_NUMERO',
  district: 'REMETENTE_BAIRRO',
  city: 'REMETENTE_CIDADE',
  state_abbr: 'REMETENTE_UF',
  postal_code: 'CEP_ORIGEM',
}

export function despachoConfigurado() {
  if (MODO() === 'off' || !configurado()) return false
  return faltaNoRemetente().length === 0
}

/** O que falta preencher, pro painel e pro log dizerem em vez de só falhar. */
export function faltaNoRemetente() {
  const de = remetente()
  const falta = Object.entries(CAMPOS_REMETENTE)
    .filter(([campo]) => !String(de[campo] || '').trim())
    .map(([, variavel]) => variavel)
  // Documento é um ou o outro, não os dois, e qual depende de em que
  // nome está a conta do Melhor Envio.
  if (!de.company_document && !de.document) falta.push('REMETENTE_CNPJ ou REMETENTE_CPF')
  return falta
}

/*
 * Faixa de CEP -> UF, pra quando a cidade vier sem o "/ UF".
 *
 * O campo "Cidade / UF" do checkout é preenchido pelo ViaCEP, mas segue
 * editável: quem apaga o sufixo deixava o envio sem estado, e a API
 * recusa. Pares [último CEP da faixa, UF], em ordem crescente.
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

function ufDoCep(cep) {
  const n = Number(soDigitos(cep).slice(0, 5))
  if (!n) return ''
  const faixa = FAIXAS_UF.find(([ate]) => n <= ate)
  return faixa ? faixa[1] : ''
}

/* "Mossoró / RN" -> { cidade: 'Mossoró', uf: 'RN' }, que é como o
   checkout grava (vem assim do ViaCEP). Sem o sufixo, a UF sai do CEP. */
function cidadeEstado(cidadeBruta, cep) {
  const partes = String(cidadeBruta || '').split('/')
  const cidade = (partes[0] || '').trim()
  const uf = String(partes[1] || '').trim().toUpperCase().slice(0, 2)
  return { cidade, uf: /^[A-Z]{2}$/.test(uf) ? uf : ufDoCep(cep) }
}

/**
 * Guardado no momento em que o pedido é criado, não no pagamento.
 *
 * Duas razões. O serviço de entrega que o cliente escolheu só existe
 * aqui — o gateway não guarda isso. E depender do cadastro do cliente no
 * gateway amarraria o despacho ao Asaas, quando o adaptador da Appmax já
 * está pronto esperando a troca.
 */
export async function guardarDespacho(referencia, { cliente, pedido }) {
  try {
    if (!referencia) return
    const store = await loja()
    await store.setJSON(String(referencia), {
      em: Date.now(),
      kitId: pedido.kitId,
      descricao: pedido.descricao,
      subtotal: pedido.subtotal,
      // `null` quando o frete saiu da tabela fixa (kit de 2 e 4 vão de
      // graça e nem passam pelo Melhor Envio). Nesse caso o despacho cota
      // na hora e pega a opção mais barata.
      servico: pedido.envio?.id ? String(pedido.envio.id) : null,
      servicoNome: pedido.envio ? `${pedido.envio.empresa} ${pedido.envio.nome}`.trim() : '',
      frete: pedido.frete,
      cliente: {
        nome: cliente.nome,
        email: cliente.email,
        telefone: cliente.telefone,
        cpf: cliente.cpf,
        cep: cliente.cep,
        rua: cliente.rua,
        numero: cliente.numero,
        complemento: cliente.complemento || '',
        bairro: cliente.bairro,
        cidade: cliente.cidade,
      },
    })
  } catch (e) {
    console.log('[envio] não consegui guardar o despacho:', e.message)
  }
}

export async function lerDespacho(referencia) {
  try {
    const store = await loja()
    return await store.get(String(referencia), { type: 'json' }).catch(() => null)
  } catch {
    return null
  }
}

/** Todos os despachos, pro painel mostrar o que já foi pra transportadora. */
export async function lerDespachos() {
  const saida = []
  try {
    const store = await loja()
    const { blobs } = await store.list()
    await Promise.all(blobs.map(async (b) => {
      const d = await store.get(b.key, { type: 'json' }).catch(() => null)
      if (d) saida.push({ referencia: b.key, ...d })
    }))
  } catch { /* sem dados é melhor que erro 500 */ }
  return saida.sort((a, b) => (b.em || 0) - (a.em || 0))
}

function montarPayload(d, servico) {
  const kit = KITS[String(d.kitId)] || KITS['1']
  const c = d.cliente || {}
  const { cidade, uf } = cidadeEstado(c.cidade, c.cep)
  const unidades = kit.unidades || 1

  return {
    service: Number(servico),
    from: remetente(),
    to: {
      name: c.nome || '',
      email: c.email || '',
      phone: soDigitos(c.telefone),
      // Cliente é pessoa física: CPF em `document`, company_document vazio.
      document: soDigitos(c.cpf),
      company_document: '',
      state_register: 'ISENTO',
      address: c.rua || '',
      complement: c.complemento || '',
      number: String(c.numero || ''),
      district: c.bairro || '',
      city: cidade,
      state_abbr: uf,
      country_id: 'BR',
      postal_code: soDigitos(c.cep),
      note: '',
    },
    // É daqui que a DC-e é gerada, então os três campos valem como
    // declaração fiscal: um frasco por unidade, ao preço que ele pagou
    // por frasco. Valor unitário é string na API deles, não número.
    products: [
      {
        name: 'Composto floral de Bach 30 ml',
        quantity: String(unidades),
        unitary_value: (Number(d.subtotal || 0) / unidades).toFixed(2),
      },
    ],
    // O que vai declarado na etiqueta é `caixaEnvio` quando o kit tem
    // uma caixa de postagem própria (o de 1 frasco vai numa menor), e a
    // mesma da cotação quando não tem. Ver catalogo.mjs.
    //
    // Correios não aceita múltiplos volumes na mesma requisição, então
    // um volume por chamada é também o que a API pede.
    volumes: [
      (() => {
        const cx = kit.caixaEnvio || kit.caixa
        return {
          height: cx.altura,
          width: cx.largura,
          length: cx.comprimento,
          weight: cx.peso,
        }
      })(),
    ],
    options: {
      /*
       * Zero NÃO passa: a API recusa com "o valor segurado deve ser
       * superior ou igual a R$ 1,00". Isso custou as três primeiras
       * tentativas de despacho em 30/10/2026.
       *
       * E segurar o valor de verdade custa quase nada. Medido no mesmo
       * dia, caixa de 1 frasco pra São Paulo, cobrindo R$ 69,99:
       *
       *   Jadlog .Package Centralizado   15,81 -> 15,81   (zero)
       *   Jadlog .Com                    16,40 -> 16,40   (zero)
       *   Correios PAC                   18,95 -> 19,39   (+0,44)
       *   Loggi Ponto                    15,10 -> 15,79   (+0,69)
       *
       * Setenta centavos pra cobrir setenta reais. Então o padrão passou
       * a ser segurar, e MELHORENVIO_SEGURAR=0 volta pro mínimo de R$ 1.
       *
       * E vai com FOLGA, a pedido dele: +30% arredondado pra cima no
       * múltiplo de 10. R$ 69,99 vira 100, R$ 129,90 vira 170, R$ 199,90
       * vira 260. Medido no mesmo trecho, a folga do kit de 1 custa 30
       * centavos na Loggi e nos Correios, e zero na Jadlog.
       *
       * O que a folga faz e o que não faz: transportadora indeniza o
       * prejuízo comprovado, e quem comprova é a declaração de conteúdo,
       * que leva o valor real do produto (ver `products` acima). Então a
       * folga protege de arredondamento e de divergência na vistoria —
       * ela não multiplica a indenização.
       */
      insurance_value:
        process.env.MELHORENVIO_SEGURAR === '0'
          ? 1
          : Math.max(1, Math.ceil((Number(d.subtotal) || 0) * 1.3 / 10) * 10),
      receipt: false,
      own_hand: false,
      reverse: false,
      // Declaração de conteúdo. `invoice` fica FORA do payload: mandar
      // junto com non_commercial faz a API recusar.
      non_commercial: true,
      platform: 'Aquiete',
      reminder: String(d.referencia || ''),
    },
  }
}

/**
 * Cria o envio no Melhor Envio. Chamado pelo webhook quando o dinheiro
 * cai, e seguro de chamar duas vezes: o Asaas reenvia o webhook quando
 * não recebe 200 na hora, e etiqueta duplicada é dinheiro duplicado.
 */
export async function despachar(referencia) {
  if (!referencia) return { ok: false, motivo: 'sem referência' }

  if (!despachoConfigurado()) {
    const falta = faltaNoRemetente()
    console.log('[envio] despacho desligado%s', falta.length ? ': falta ' + falta.join(', ') : '')
    return { ok: false, motivo: falta.length ? 'remetente incompleto: ' + falta.join(', ') : 'desligado' }
  }

  const store = await loja()
  const d = await store.get(String(referencia), { type: 'json' }).catch(() => null)
  if (!d) {
    console.log('[envio] sem dados guardados para', referencia)
    return { ok: false, motivo: 'pedido não encontrado' }
  }

  // Já foi. Esta é a trava que impede etiqueta duplicada.
  if (d.me?.id) return { ok: true, repetido: true, id: d.me.id }

  // Outra execução do webhook está nisso agora. Dois minutos é mais que
  // o tempo das três chamadas, e menos que o reenvio do Asaas.
  if (d.tentandoEm && Date.now() - d.tentandoEm < 120_000) {
    return { ok: false, motivo: 'já em andamento' }
  }
  // `pagoEm` é o que diz, mais tarde, que este pedido TEM que ir pra
  // transportadora. Sem essa marca a repescagem não saberia diferenciar
  // uma venda paga que falhou de um Pix que nunca foi pago.
  d.pagoEm = d.pagoEm || Date.now()
  await store.setJSON(String(referencia), { ...d, tentandoEm: Date.now() })

  try {
    // Sem serviço escolhido (frete grátis do kit de 2 e 4), cota agora e
    // leva a opção mais barata — `cotar` já devolve ordenado por preço.
    let servico = d.servico
    let servicoNome = d.servicoNome
    if (!servico) {
      const opcoes = await cotar(d.kitId, d.cliente?.cep)
      if (!opcoes.length) throw new Error('nenhum serviço disponível para este CEP')
      servico = opcoes[0].id
      servicoNome = `${opcoes[0].empresa} ${opcoes[0].nome}`.trim()
    }

    const payload = montarPayload({ ...d, referencia }, servico)
    const carrinho = await chamar('/me/cart', { corpo: payload })
    const id = carrinho?.id
    if (!id) throw new Error('o Melhor Envio não devolveu o id do envio')

    const me = {
      id,
      protocolo: carrinho.protocol || '',
      preco: Number(carrinho.price) || null,
      servico: servicoNome,
      estado: carrinho.status || 'pending',
      em: Date.now(),
    }

    // A etiqueta é gravada ANTES de comprar. Se o checkout falhar no meio,
    // o envio já existe no carrinho e a próxima tentativa não cria outro.
    await store.setJSON(String(referencia), { ...d, me, tentandoEm: null, erro: null, erroEm: null })

    if (MODO() !== 'completo') {
      console.log('[envio] %s no carrinho do Melhor Envio (%s)', referencia, servicoNome)
      return { ok: true, id, protocolo: me.protocolo, servico: servicoNome, comprado: false }
    }

    // Daqui pra baixo gasta saldo da carteira. Cada passo depende do
    // anterior e nenhum deles pode ser repetido às cegas, por isso o
    // estado é gravado a cada etapa.
    await chamar('/me/shipment/checkout', { corpo: { orders: [id] } })
    me.estado = 'pago'
    await store.setJSON(String(referencia), { ...d, me, tentandoEm: null, erro: null, erroEm: null })

    await chamar('/me/shipment/generate', { corpo: { orders: [id] } })
    me.estado = 'gerado'

    const impressao = await chamar('/me/shipment/print', { corpo: { mode: 'public', orders: [id] } })
    me.etiqueta = impressao?.url || ''

    // A DACE é o documento da declaração de conteúdo, e vai colada no
    // pacote junto da etiqueta. Link separado, e só existe depois de
    // gerar a etiqueta.
    try {
      const dace = await chamar(`/me/imprimir/dace/pdf/${id}`, { metodo: 'GET' })
      me.dace = dace?.pdf || dace?.url || ''
    } catch (e) {
      console.log('[envio] DACE não veio para', referencia, e.message)
    }

    await store.setJSON(String(referencia), { ...d, me, tentandoEm: null, erro: null, erroEm: null })
    console.log('[envio] %s pago e etiqueta gerada (%s)', referencia, servicoNome)
    return { ok: true, id, protocolo: me.protocolo, servico: servicoNome, comprado: true, etiqueta: me.etiqueta, dace: me.dace }

  } catch (e) {
    // Solta a trava pra próxima tentativa, e guarda o motivo: é o que vai
    // dizer, no painel, por que aquele pedido não foi pra transportadora.
    await store.setJSON(String(referencia), {
      ...d, tentandoEm: null, erro: String(e.message || e).slice(0, 300), erroEm: Date.now(),
    }).catch(() => {})
    console.error('[envio] despacho de', referencia, 'falhou:', e.message)
    return { ok: false, motivo: String(e.message || e) }
  }
}

/**
 * Venda paga cujo envio não foi criado: tenta de novo.
 *
 * O despacho mora no webhook, que tem tempo contado — e um Melhor Envio
 * lento, uma função congelada no meio ou um 500 do lado deles deixavam a
 * encomenda sem existir, com o cliente já pago e esperando. Isto é a
 * rede: roda sozinho e repesca.
 *
 * Só olha quem tem `pagoEm` (dinheiro confirmado) e não tem `me.id`
 * (envio ainda não criado). Pix gerado e não pago nunca entra aqui.
 */
export async function despacharPendentes({ limite = 10 } = {}) {
  if (!despachoConfigurado()) return { ok: false, motivo: 'desligado' }

  const agora = Date.now()
  const pendentes = (await lerDespachos())
    .filter((d) => d.pagoEm && !d.me?.id)
    // Deixa o webhook terminar o que começou antes de pegar no mesmo
    // pedido, e desiste depois de uma semana: aí é caso pra mão.
    .filter((d) => !d.tentandoEm || agora - d.tentandoEm > 120_000)
    .filter((d) => agora - d.pagoEm < 7 * 86_400_000)
    .slice(0, limite)

  const feitos = []
  for (const d of pendentes) {
    const r = await despachar(d.referencia)
    feitos.push({ referencia: d.referencia, ...r })
  }
  return { ok: true, tentados: feitos.length, feitos }
}
