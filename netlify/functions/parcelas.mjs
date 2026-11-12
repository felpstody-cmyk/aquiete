/**
 * GET /api/parcelas?kit=1&bump=0&cupom=&cep=&envio=
 *
 * As opcoes de parcela que o checkout transparente mostra.
 *
 * ---------------------------------------------------------------
 *  POR QUE ISTO EXISTE, E POR QUE NAO CALCULA NADA
 * ---------------------------------------------------------------
 * Ate aqui o cartao ia pra pagina hospedada do Asaas, e era LA que a
 * pessoa escolhia em quantas vezes pagar. Quem montava aquela tabela, com
 * a taxa desta conta e a regra de repasse de juros dela, era o Asaas.
 *
 * Trazendo o cartao pra dentro do site, alguem tem que montar a mesma
 * tabela. Se fosse eu, com um percentual chutado no codigo, qualquer
 * diferenca entre o meu numero e o do Asaas sairia do bolso dele, em
 * silencio, em toda venda parcelada. Entao a tabela continua sendo do
 * Asaas: este endpoint so repassa o que o simulador deles responde.
 *
 * O valor NAO vem do navegador. Vem do catalogo, pelo mesmo montarPedido
 * que a cobranca usa — senao daria pra simular um total e pagar outro.
 *
 * Degrada, nao quebra: qualquer falha devolve lista vazia, e o checkout
 * cai pra "a vista". Perder o parcelado e ruim; derrubar o checkout e
 * pior.
 */

import { montarPedido } from './_lib/catalogo.mjs'
import { conferir } from './_lib/melhorenvio.mjs'
import { obterGateway } from './_lib/gateways/index.mjs'

const json = (dados, status = 200, publico = true) =>
  new Response(JSON.stringify(dados), {
    status,
    headers: {
      'Content-Type': 'application/json',
      // Dois minutos no caso publico: a tabela so muda quando o Asaas muda
      // taxa, e sem nenhum cache cada clique no cartao viram 12 chamadas na
      // API deles.
      //
      // `no-store` quando a resposta leva o cru, porque ali dentro vai o
      // `netValue` — quanto sobra pra ele depois da taxa. Isso nao pode
      // ficar guardado num CDN publico onde qualquer um pega depois.
      'Cache-Control': publico ? 'public, max-age=120' : 'no-store',
    },
  })

/** Numero que veio de fora, so se for numero mesmo. */
function num(v) {
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

export default async (req) => {
  /*
   * `transparente` viaja junto de proposito.
   *
   * A pagina nao enxerga variavel de ambiente, e sem este campo ela teria
   * que adivinhar se mostra os campos de cartao ou o texto antigo de
   * "voce digita na proxima tela". Adivinhando errado, a pessoa digitaria
   * o cartao aqui e seria jogada pra pagina do Asaas pra digitar DE NOVO.
   *
   * Com o campo vindo daqui, a variavel CARTAO_TRANSPARENTE e a unica
   * fonte da verdade pros dois lados, e virar a chave no Netlify muda a
   * tela sem deploy nenhum.
   */
  const ligado = process.env.CARTAO_TRANSPARENTE === '1'
  const vazio = { total: null, opcoes: [], transparente: ligado }
  try {
    const url = new URL(req.url)
    const q = url.searchParams

    const gateway = obterGateway()
    if (typeof gateway.simularParcelas !== 'function') return json(vazio)

    // Mesmo caminho da cobranca: o frete escolhido e reconferido no
    // servidor, e falha de cotacao cai na tabela fixa em vez de derrubar.
    const cep = q.get('cep') || ''
    const idEnvio = q.get('envio')
    const envio = idEnvio
      ? await conferir(q.get('kit'), cep, idEnvio).catch(() => null)
      : null

    const pedido = montarPedido(
      q.get('kit'), 'card', q.get('cupom') || null, cep, envio, q.get('bump') === '1',
    )

    const cru = await gateway.simularParcelas(pedido.total, 12)

    /*
     * Onde cada numero mora na resposta, conferido na conta dele em
     * 12/11/2026 com uma simulacao de R$ 129,90 em 3x:
     *
     *   { "value": 129.90,
     *     "creditCard": { "netValue": 126.21, "feePercentage": 2.49,
     *                     "operationFee": 0.49,
     *                     "installment": { "paymentValue": 43.30,
     *                                      "paymentNetValue": 42.07 } } }
     *
     *   value                        o TOTAL que o cliente paga
     *   creditCard.installment
     *     .paymentValue              o valor de UMA parcela
     *     .paymentNetValue           o que sobra pra ele em cada parcela
     *
     * O `installment` fica DENTRO de `creditCard`, nao na raiz. Ler ele da
     * raiz fazia a lista cair no `value` e a parcela passava a ser
     * calculada aqui, por divisao — 129,90 / 12 da R$ 10,83 e o Asaas diz
     * R$ 10,82. Um centavo, mas era conta minha aparecendo onde o combinado
     * e so repassar a deles.
     *
     * Parcela que vier sem `paymentValue` SAI DA LISTA em vez de virar
     * divisao. Mostrar uma opcao a menos e um problema pequeno; mostrar um
     * valor de parcela que o Asaas nunca disse e um problema grande.
     */
    const opcoes = cru.map(({ parcelas, resposta }) => {
      const cc = resposta?.creditCard || {}
      const total = num(resposta?.value) ?? pedido.total
      // Em 1x nao existe `installment`: a parcela e o total.
      const parcela = parcelas === 1 ? total : num(cc.installment?.paymentValue)
      if (!(total > 0) || !(parcela > 0)) return null
      return {
        parcelas,
        total: Number(total.toFixed(2)),
        valorParcela: Number(parcela.toFixed(2)),
        /*
         * Verdadeiro so quando a conta repassa juro pro cliente, ou seja
         * quando a soma das parcelas passa do total. Na conta dele hoje
         * isto e sempre falso: ele paga a taxa, o cliente paga o mesmo
         * valor em qualquer parcelamento.
         *
         * A folga existe porque a diferenca de arredondamento vai pra
         * ultima parcela: 12 x 10,82 = 129,84, que e MENOR que o total e
         * nao tem nada de juro.
         */
        comJuros: Number((parcela * parcelas).toFixed(2)) > Number(total.toFixed(2)) + 0.02,
      }
    }).filter(Boolean)

    const corpo = { total: pedido.total, opcoes, transparente: ligado }

    /*
     * A resposta crua so pra mim, com o token do painel. Ela carrega
     * `netValue` — quanto sobra pra ele depois da taxa — e isso nao e
     * assunto de quem esta comprando.
     */
    const esperado = process.env.ADMIN_TOKEN
    const souEu = Boolean(esperado) && req.headers.get('x-admin-token') === esperado
    if (souEu) corpo.cru = cru

    return json(corpo, 200, !souEu)
  } catch (e) {
    console.error('[parcelas]', e?.message || e)
    return json(vazio)
  }
}

export const config = { path: '/api/parcelas' }
