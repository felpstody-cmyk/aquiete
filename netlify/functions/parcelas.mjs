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
     * So entra na lista a parcela que o Asaas confirmou E cujo total bate
     * com alguma coisa que faca sentido cobrar. `paymentValue` e o que o
     * cliente paga no fim; quando a conta repassa juros ele vem MAIOR que
     * o total do pedido, e e esse numero que tem que aparecer na tela.
     */
    const opcoes = cru.map(({ parcelas, resposta }) => {
      const inst = resposta?.installment || {}
      const totalCliente = num(inst.paymentValue) ?? num(resposta?.value) ?? pedido.total
      if (!(totalCliente > 0)) return null
      return {
        parcelas,
        total: Number(totalCliente.toFixed(2)),
        valorParcela: Number((totalCliente / parcelas).toFixed(2)),
        // Verdadeiro quando a conta repassa o juro pro cliente. O texto da
        // tela depende disto, entao vem pronto daqui.
        comJuros: Number(totalCliente.toFixed(2)) > Number(pedido.total.toFixed(2)),
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
