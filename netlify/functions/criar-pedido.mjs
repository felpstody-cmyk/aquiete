/**
 * POST /.netlify/functions/criar-pedido
 *
 * Recebe { kit, metodo, cliente } do checkout, valida tudo no servidor
 * e delega a cobrança para o gateway configurado em GATEWAY.
 *
 * O navegador NUNCA manda preço. O total sai do catálogo daqui.
 */

import { montarPedido, validarCliente, ErroDeEntrada } from './_lib/catalogo.mjs'
import { obterGateway, ErroDeGateway } from './_lib/gateways/index.mjs'
import { enviar, htmlAguardando } from './_lib/email.mjs'
import { marcarCarrinhoComPedido, guardarCliqueDoPedido } from './_lib/metricas.mjs'
import { notificarPedidoGerado, podeNotificar } from './_lib/notificar.mjs'
import { enviarZap, textoPixGerado } from './_lib/zap.mjs'
import { geoDe } from './_lib/geo.mjs'

const json = (dados, status = 200) =>
  new Response(JSON.stringify(dados), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  })

/** Referência legível que aparece no extrato e no painel do gateway. */
function gerarReferencia() {
  const agora = new Date()
  const dia = agora.toISOString().slice(2, 10).replace(/-/g, '')
  const aleatorio = Math.random().toString(36).slice(2, 7).toUpperCase()
  return `AQ-${dia}-${aleatorio}`
}

export default async (req) => {
  if (req.method !== 'POST') return json({ erro: 'Use POST' }, 405)

  try {
    const corpo = await req.json()

    // Ordem importa: valida antes de gastar chamada de API
    // O CEP entra aqui porque o frete do Norte depende dele (ver catalogo.mjs).
    const pedido = montarPedido(corpo.kit, corpo.metodo, corpo.cupom, corpo.cliente?.cep)
    const cliente = validarCliente(corpo.cliente)
    const referencia = gerarReferencia()

    const gateway = obterGateway()
    const cobranca = await gateway.criarCobranca({ pedido, cliente, referencia })

    // Pedido gerado ainda não é venda: quem gera o Pix e não paga tem que
    // voltar pra lista de abandonados sozinho depois do prazo. Por isso o
    // carrinho NÃO é apagado aqui — ele só sai quando o webhook confirma
    // o pagamento (marcarCarrinhoPago). Nunca derruba o pedido se falhar.
    // Liga este pedido ao clique do anuncio. So sera usado la na frente,
    // quando (e se) o Asaas confirmar o pagamento.
    await guardarCliqueDoPedido(referencia, corpo.clique).catch(() => {})

    const geo = geoDe(req)
    await marcarCarrinhoComPedido(cliente.email, {
      nome: cliente.nome,
      telefone: cliente.telefone,
      kit: pedido.kitId,
      cidadeForm: cliente.cidade,
      ...(geo ? { cidadeIp: geo.cidade, uf: geo.uf } : {}),
    }, {
      referencia,
      metodo: pedido.metodo,
      total: pedido.total,
    }).catch(() => {})

    // "Toc toc" na hora, com o botao de chamar no zap ja pronto. Cartao
    // fica de fora: ali a pessoa ja esta na tela de pagamento e nao ha o
    // que perseguir. A trava e por pessoa, nao por referencia: quem gera o
    // Pix, fecha e gera de novo cria duas referencias diferentes, e nao ha
    // motivo pro celular tocar duas vezes pelo mesmo cliente.
    if (pedido.metodo !== 'card' && await podeNotificar('pedido:' + cliente.email, 30)) {
      notificarPedidoGerado({
        nome: cliente.nome,
        telefone: cliente.telefone,
        total: pedido.total,
        metodo: pedido.metodo,
        descricao: pedido.descricao,
        cidade: cliente.cidade || geo?.cidade || '',
      }).catch(() => {})

      // E o zap pro cliente, sozinho, no mesmo segundo. A mesma trava
      // cobre os dois: um POST repetido nao manda dois zaps pra pessoa.
      enviarZap({
        telefone: cliente.telefone,
        texto: textoPixGerado({
          nome: cliente.nome,
          descricao: pedido.descricao,
          total: pedido.total,
        }),
      }).catch(() => {})
    }

    // Manda o codigo por e-mail para quem vai pagar depois. Sem isto, quem
    // fecha a pagina do Pix perde a cobranca e precisa refazer o pedido.
    // Cartao nao entra: ali a pessoa ja e levada para a tela de pagamento.
    if (pedido.metodo !== 'card') {
      try {
        await enviar({
          para: cliente.email,
          // Assunto com valor e prazo: e o que decide se o e-mail e aberto
          // no meio de uma caixa de entrada cheia.
          assunto: pedido.metodo === 'pix'
            ? `Falta só o pagamento: seu Pix de R$ ${pedido.total.toFixed(2).replace('.', ',')} vence em 24h`
            : `Seu boleto de R$ ${pedido.total.toFixed(2).replace('.', ',')} está pronto`,
          html: htmlAguardando({
            nome: cliente.nome,
            referencia,
            descricao: pedido.descricao,
            total: pedido.total,
            metodo: pedido.metodo,
            payload: cobranca.pix?.payload || null,
            link: cobranca.redirectUrl || cobranca.invoiceUrl || null,
          }),
        })
      } catch (e) {
        // Falha de e-mail nunca derruba um pedido que ja foi criado.
        console.error('[criar-pedido] e-mail de cobranca falhou:', e.message)
      }
    }

    return json({
      ok: true,
      referencia,
      gateway: gateway.nome,
      // O total volta pro navegador porque e ele que a conversao do Google
      // usa. Valor calculado aqui: considera kit, cupom e o frete do Norte.
      total: pedido.total,
      ...cobranca,
    })

  } catch (e) {
    if (e instanceof ErroDeEntrada || e instanceof ErroDeGateway) {
      // Erro de gateway vira log: pode conter detalhe de integração
      if (e instanceof ErroDeGateway) console.error('[gateway]', e.message)
      return json({ ok: false, erro: e.message }, e.status ?? 400)
    }
    console.error('[criar-pedido]', e)
    return json({ ok: false, erro: 'Não foi possível criar o pedido. Tente novamente.' }, 500)
  }
}

export const config = { path: '/api/criar-pedido' }
