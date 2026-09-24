/**
 * Fonte de verdade dos preços.
 *
 * Isto roda NO SERVIDOR. O preço que o navegador manda é ignorado —
 * sempre. Sem isso, qualquer pessoa abre o console e compra por R$ 1.
 */

export const KITS = {
  '1': { rotulo: '1 unidade',  unidades: 1, preco:  84.90, frete: 14.99 },
  '2': { rotulo: '2 unidades', unidades: 2, preco: 149.90, frete: 0 },
  '4': { rotulo: '4 unidades', unidades: 4, preco: 259.90, frete: 0 },
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
  PRIMEIRA10: { percentual: 0.10, rotulo: '10% na primeira compra', ativo: true },

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
export const FRETE_NORTE = 14.99
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
export function montarPedido(kitId, metodo, codigoCupom, cep) {
  const kit = KITS[String(kitId)]
  if (!kit) throw new ErroDeEntrada(`Kit inválido: ${kitId}`)
  if (!METODOS.has(metodo)) throw new ErroDeEntrada(`Método inválido: ${metodo}`)

  const cupom = acharCupom(codigoCupom)
  const centavos = (v) => Number(v.toFixed(2))
  const desconto = cupom ? centavos(kit.preco * cupom.percentual) : 0
  const frete = freteDoKit(kit, cep)

  return {
    kitId: String(kitId),
    metodo,
    descricao: `Aquiete — ${kit.rotulo}`,
    subtotal: kit.preco,
    cupom: cupom?.codigo ?? null,
    desconto,
    frete,
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
