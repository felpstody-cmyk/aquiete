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
    const pedido = montarPedido(corpo.kit, corpo.metodo, corpo.cupom)
    const cliente = validarCliente(corpo.cliente)
    const referencia = gerarReferencia()

    const gateway = obterGateway()
    const cobranca = await gateway.criarCobranca({ pedido, cliente, referencia })

    // Manda o codigo por e-mail para quem vai pagar depois. Sem isto, quem
    // fecha a pagina do Pix perde a cobranca e precisa refazer o pedido.
    // Cartao nao entra: ali a pessoa ja e levada para a tela de pagamento.
    if (pedido.metodo !== 'card') {
      try {
        await enviar({
          para: cliente.email,
          assunto: pedido.metodo === 'pix'
            ? `Seu Pix do pedido ${referencia}`
            : `Seu boleto do pedido ${referencia}`,
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
