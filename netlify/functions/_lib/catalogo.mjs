/**
 * Fonte de verdade dos preços.
 *
 * Isto roda NO SERVIDOR. O preço que o navegador manda é ignorado —
 * sempre. Sem isso, qualquer pessoa abre o console e compra por R$ 1.
 */

/*
 * Oferta: o segundo frasco sai por R$ 14,91. O kit de 2 custa R$ 99,90 e
 * o avulso R$ 84,99, entao levar o segundo custa quase nada — e e essa
 * diferenca, posta lado a lado, que faz a pessoa subir de kit.
 *
 * Os valores aqui sao ANTES do cupom. Com o PRIMEIRA10 viram
 * 84,99 / 99,90 / 179,90, que sao os numeros que o cliente ve. Escolhidos
 * pra cair redondos depois do desconto.
 */
/**
 * Caixa e peso de cada kit, pesados na balança em 12/10/2026.
 *
 * É a mesma caixa para os três kits, 19 x 12 x 7 cm. O que muda é o peso.
 *
 * A transportadora cobra pelo maior entre o peso real e o cúbico
 * (volume / 6000). Nesta caixa o cúbico dá 266 g, então os kits de 1 e 2
 * são cobrados por 266 g e o de 4 pelos 380 g reais. Os três continuam
 * dentro de faixas baratas, e caixa menor não mudaria nada: abaixo de
 * 16 x 11 x 2 o cálculo sobe pro mínimo dos Correios de qualquer jeito.
 *
 * ---------------------------------------------------------------
 * `caixa` é o que a loja COTA. `caixaEnvio`, quando existe, é o que vai
 * declarado na ETIQUETA.
 *
 * Os dois existem porque o de 1 frasco passou a ir numa caixinha menor,
 * mas a loja continua cobrando pela caixa que cabe qualquer kit — a
 * diferença fica com a loja.
 *
 * Isso é seguro na direção certa e só nela: transportadora cobra a mais
 * quando você declara MENOS do que envia. Declarar o tamanho real, sendo
 * ele menor que o cotado, é o caso bom, e é o único jeito de a etiqueta
 * bater com o pacote se alguém medir no balcão.
 *
 * Nunca o contrário: `caixaEnvio` maior que `caixa` seria vender frete
 * barato e postar pacote grande, e aí a diferença vem cobrada depois.
 *
 * MEDIDO EM 30/10/2026: a caixa menor NÃO economiza frete.
 *
 * A caixinha de 1 frasco é 11 x 11 x 6,5. O cúbico dela cai de 266 g pra
 * 141 g, mas o peso real é 100 g e todas as faixas de preço cobrem os
 * dois. Cotado de verdade contra São Paulo e Mossoró, a diferença foi
 * ZERO em Jadlog, Loggi e Correios — um centavo na Azul e R$ 3 na JeT,
 * que ninguém escolhe porque custa o triplo.
 *
 * Então o `caixaEnvio` do kit de 1 está ligado por OUTRO motivo: a
 * etiqueta passa a declarar o pacote que de fato sai daqui. Se alguém
 * medir no balcão, confere. Não espere economia disto.
 *
 * Pra refazer a conta com outra caixa:
 *   /api/admin-envio?cep=01310100&c=11&l=11&a=7&p=0.1
 * ---------------------------------------------------------------
 */
export const KITS = {
  '1': { rotulo: '1 unidade',  unidades: 1, preco:  69.99, frete: 14.99,
         // Cota pela caixa grande, posta na pequena. Medidas arredondadas
         // pra cima (6,5 vira 7): pra menos a transportadora cobraria a
         // diferenca se medisse no balcao.
         caixa:      { altura: 19, largura: 12, comprimento:  7, peso: 0.10 },
         caixaEnvio: { altura:  7, largura: 11, comprimento: 11, peso: 0.10 } },
  '2': { rotulo: '2 unidades', unidades: 2, preco: 129.90, frete: 0,
         caixa: { altura: 19, largura: 12, comprimento:  7, peso: 0.17 } },
  '4': { rotulo: '4 unidades', unidades: 4, preco: 199.90, frete: 0,
         caixa: { altura: 19, largura: 12, comprimento:  7, peso: 0.38 } },
}

export const METODOS = new Set(['pix', 'card', 'boleto'])

/**
 * Cupons. O desconto incide só sobre o produto, nunca sobre o frete —
 * frete é custo real, desconto em cima dele sai do seu bolso duas vezes.
 *
 * Para desativar um cupom, troque `ativo` para false em vez de apagar:
 * assim os pedidos antigos continuam explicáveis.
 */
export const CUPONS = {
  // Desligado em 05/10: a oferta passou a ser o proprio compre-1-leve-2,
  // e dar 10% por cima dela comia a margem duas vezes.
  PRIMEIRA10: { percentual: 0.10, rotulo: '10% na primeira compra', ativo: false },

  // Desligado — era so para o teste de compra real do dono.
  TESTEAQ0821: { percentual: 1.00, rotulo: 'Pedido de teste', ativo: false },
}

/**
 * Devolve o cupom válido ou null. Código inválido nunca derruba o pedido.
 *
 * Object.hasOwn é obrigatório: sem ele, um código como "constructor" ou
 * "toString" acharia uma propriedade herdada do prototype em vez de um cupom.
 */
export function acharCupom(codigo) {
  const chave = String(codigo ?? '').trim().toUpperCase()
  if (!chave || !Object.hasOwn(CUPONS, chave)) return null
  const cupom = CUPONS[chave]
  return cupom.ativo ? { codigo: chave, ...cupom } : null
}

/**
 * Frete do Norte.
 *
 * Mandar pro Norte custa muito mais que o frete padrão, e o frete grátis
 * dos kits de 2 e 4 comeria a margem inteira do pedido. Em vez de recusar
 * a venda, o pedido sai com frete cobrado nesses estados.
 *
 * As faixas são de CEP, não de nome de estado, porque nome vem do
 * formulário e dá pra digitar qualquer coisa:
 *   66000–69999  PA, AP, AM, RR e AC
 *   76800–76999  RO   (76000–76799 é Goiás e continua no frete normal)
 *   77000–77999  TO
 */
export const FRETE_NORTE = 19.99
const CEPS_NORTE = [[66000, 69999], [76800, 76999], [77000, 77999]]

export function ehNorte(cep) {
  const n = Number(String(cep ?? '').replace(/\D/g, '').slice(0, 5))
  if (!n) return false
  return CEPS_NORTE.some(([de, ate]) => n >= de && n <= ate)
}

/** Frete que vale pra esse kit nesse CEP. */
export function freteDoKit(kit, cep) {
  return ehNorte(cep) ? FRETE_NORTE : kit.frete
}

/** Monta o pedido a partir do id do kit. Lança se o kit não existir. */
/**
 * `envio` e a opcao ja CONFERIDA no Melhor Envio por quem chamou — nunca
 * o que o navegador mandou. Sem ela, cai na tabela fixa de sempre, que e
 * o que mantem a loja vendendo se a integracao estiver fora.
 */
export function montarPedido(kitId, metodo, codigoCupom, cep, envio = null) {
  const kit = KITS[String(kitId)]
  if (!kit) throw new ErroDeEntrada(`Kit inválido: ${kitId}`)
  if (!METODOS.has(metodo)) throw new ErroDeEntrada(`Método inválido: ${metodo}`)

  const cupom = acharCupom(codigoCupom)
  const centavos = (v) => Number(v.toFixed(2))
  const desconto = cupom ? centavos(kit.preco * cupom.percentual) : 0
  const frete = envio ? centavos(envio.preco) : freteDoKit(kit, cep)

  return {
    kitId: String(kitId),
    metodo,
    descricao: `Aquiete — ${kit.rotulo}`,
    subtotal: kit.preco,
    cupom: cupom?.codigo ?? null,
    desconto,
    frete,
    // Guardado pra etiqueta: na hora de postar ele precisa saber qual
    // servico o cliente pagou, nao so quanto.
    envio: envio ? { id: envio.id, nome: envio.nome, empresa: envio.empresa, prazo: envio.prazo } : null,
    total: centavos(kit.preco - desconto + frete),
  }
}

export class ErroDeEntrada extends Error {
  constructor(msg) { super(msg); this.name = 'ErroDeEntrada'; this.status = 400 }
}

/* ---------------- Validação dos dados do cliente ---------------- */

const digitos = (v) => String(v ?? '').replace(/\D/g, '')

export function cpfValido(valor) {
  const v = digitos(valor)
  if (v.length !== 11 || /^(\d)\1{10}$/.test(v)) return false
  for (let t = 9; t < 11; t++) {
    let soma = 0
    for (let i = 0; i < t; i++) soma += Number(v[i]) * (t + 1 - i)
    if (((soma * 10) % 11) % 10 !== Number(v[t])) return false
  }
  return true
}

export function validarCliente(c = {}) {
  const faltando = []
  if (!String(c.nome ?? '').trim().includes(' ')) faltando.push('nome completo')
  if (!cpfValido(c.cpf))                          faltando.push('CPF')
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/.test(c.email ?? '')) faltando.push('e-mail')
  if (digitos(c.telefone).length < 10)            faltando.push('celular')
  if (digitos(c.cep).length !== 8)                faltando.push('CEP')
  for (const campo of ['rua', 'numero', 'bairro', 'cidade']) {
    if (!String(c[campo] ?? '').trim()) faltando.push(campo)
  }
  if (faltando.length) {
    throw new ErroDeEntrada(`Dados incompletos: ${faltando.join(', ')}`)
  }

  return {
    nome: String(c.nome).trim(),
    cpf: digitos(c.cpf),
    email: String(c.email).trim().toLowerCase(),
    telefone: digitos(c.telefone),
    cep: digitos(c.cep),
    rua: String(c.rua).trim(),
    numero: String(c.numero).trim(),
    complemento: String(c.complemento ?? '').trim(),
    bairro: String(c.bairro).trim(),
    cidade: String(c.cidade).trim(),
  }
}
