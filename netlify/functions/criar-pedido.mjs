/**
 * POST /.netlify/functions/criar-pedido
 *
 * Recebe { kit, metodo, cliente } do checkout, valida tudo no servidor
 * e delega a cobrança para o gateway configurado em GATEWAY.
 *
 * O navegador NUNCA manda preço. O total sai do catálogo daqui.
 */

import { montarPedido, validarCliente, ErroDeEntrada } from './_lib/catalogo.mjs'
import { conferir } from './_lib/melhorenvio.mjs'
import { obterGateway, ErroDeGateway } from './_lib/gateways/index.mjs'
import { enviar, htmlAguardando } from './_lib/email.mjs'
import { marcarCarrinhoComPedido, guardarCliqueDoPedido, guardarIdentidadeDoPedido } from './_lib/metricas.mjs'
import { notificarPedidoGerado, podeNotificar } from './_lib/notificar.mjs'
import { enviarZap, textoPixGerado, textoPixCodigo } from './_lib/zap.mjs'
import { registrarZap } from './_lib/zaplog.mjs'
import { enviarPagamento } from './_lib/meta-capi.mjs'
import { geoDe } from './_lib/geo.mjs'
import { registrarPedidoUtmify } from './_lib/utmify.mjs'
import { guardarDespacho } from './_lib/envio.mjs'

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
    // Se o cliente escolheu um servico de entrega, a cotacao e refeita
    // AGORA, no servidor. O preco que o navegador mandou nunca e usado:
    // sem isso da pra escolher SEDEX na tela e pagar PAC na cobranca.
    // Falha na cotacao nao derruba o pedido, cai na tabela fixa.
    const envio = corpo.envio
      ? await conferir(corpo.kit, corpo.cliente?.cep, corpo.envio).catch(() => null)
      : null
    const pedido = montarPedido(corpo.kit, corpo.metodo, corpo.cupom, corpo.cliente?.cep, envio)
    const cliente = validarCliente(corpo.cliente)
    const referencia = gerarReferencia()

    // O IP sai daqui porque tres coisas precisam dele: o antifraude do
    // gateway, o CAPI do Meta e o rastreio da Utmify.
    const ipCliente =
      req.headers.get('x-nf-client-connection-ip') ||
      (req.headers.get('x-forwarded-for') || '').split(',')[0].trim() ||
      null

    const gateway = obterGateway()
    const cobranca = await gateway.criarCobranca({
      pedido, cliente, referencia, origem: corpo.origem, ip: ipCliente,
    })

    // Pedido gerado ainda não é venda: quem gera o Pix e não paga tem que
    // voltar pra lista de abandonados sozinho depois do prazo. Por isso o
    // carrinho NÃO é apagado aqui — ele só sai quando o webhook confirma
    // o pagamento (marcarCarrinhoPago). Nunca derruba o pedido se falhar.
    // Liga este pedido ao clique do anuncio. So sera usado la na frente,
    // quando (e se) o Asaas confirmar o pagamento.
    await guardarCliqueDoPedido(referencia, corpo.clique).catch(() => {})

    // O que o Melhor Envio vai precisar quando o pagamento cair. Guardado
    // AQUI porque o servico de entrega que o cliente escolheu so existe
    // neste ponto: o gateway nao guarda isso, e sem ele o despacho tinha
    // que chutar qual frete a pessoa pagou.
    await guardarDespacho(referencia, { cliente, pedido }).catch(() => {})

    // Atribuicao de campanha, gravada fora da nossa casa. Vai como
    // "aguardando pagamento"; o webhook vira pra "pago" quando o dinheiro
    // cair. Com await de proposito: a funcao congela ao responder, entao
    // promessa solta aqui morreria sem terminar.
    await registrarPedidoUtmify({
      referencia,
      pedido,
      cliente,
      origem: corpo.origem,
      ip: ipCliente,
    })

    // Pix gerado tambem vai pro Meta daqui, nao so do navegador: la o
    // evento so existe pra quem aceitou o cookie, e isso era 13 no mes.
    // Mesmo id (a referencia) que o checkout usa, entao o Meta junta os
    // dois. Quem clicou "So o necessario" fica de fora. Nunca derruba o
    // pedido: medicao e o ultimo da fila.
    // O que o Meta usa pra casar o evento com o clique no anuncio. Vale
    // pros DOIS eventos: o Pix gerado, que sai daqui, e a compra, que sai
    // do webhook quando o dinheiro cai. La nao tem navegador nenhum na
    // frente, por isso isto fica guardado pela referencia do pedido.
    const identidadeMeta = {
      ip: ipCliente,
      ua: req.headers.get('user-agent'),
      fbp: typeof corpo.fbp === 'string' ? corpo.fbp.slice(0, 120) : null,
      fbc: typeof corpo.fbc === 'string' ? corpo.fbc.slice(0, 200) : null,
    }

    if (corpo.consent !== 'essencial') {
      // Com await: a funcao congela ao responder, e promessa solta aqui
      // morreria sem terminar. Quem recusou cookie nao passa por aqui.
      await guardarIdentidadeDoPedido(referencia, identidadeMeta).catch(() => {})

      enviarPagamento({
        referencia,
        total: pedido.total,
        cliente,
        kitId: pedido.kitId,
        unidades: Number(pedido.kitId) || 1,
        ...identidadeMeta,
      }).catch((e) => console.log('[capi] Pix gerado nao foi:', e.message))
    }

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
      // A quebra vai junto do total porque o painel mostra quanto era
      // produto e quanto era frete — sem isso ele só sabe a soma.
      subtotal: pedido.subtotal,
      desconto: pedido.desconto,
      frete: pedido.frete,
      total: pedido.total,
    }).catch(() => {})

    // Preenchido so se o zap do "pedido reservado" for disparado; e lido
    // depois do e-mail, pra mandar o copia-e-cola numa segunda mensagem.
    let codigoDepois = null
    let primeiraMsg = null

    // "Toc toc" na hora, com o botao de chamar no zap ja pronto. Cartao
    // fica de fora: ali a pessoa ja esta na tela de pagamento e nao ha o
    // que perseguir. A trava e por pessoa, nao por referencia: quem gera o
    // Pix, fecha e gera de novo cria duas referencias diferentes, e nao ha
    // motivo pro celular tocar duas vezes pelo mesmo cliente.
    // Guardado antes do if pra poder registrar TAMBEM quando o zap nao e
    // tentado. Era aqui que a investigacao morria: sem isto, "nao recebi"
    // podia ser telefone invalido, sessao caida, erro da API ou a trava de
    // 30 minutos, e nao havia como saber qual.
    const podeZap = pedido.metodo !== 'card' && await podeNotificar('pedido:' + cliente.email, 30)
    if (!podeZap) {
      // Com await de proposito: sem ele a funcao devolve a resposta e o
      // Netlify congela antes de a linha ser gravada. Foi o que escondeu
      // o pedido no cartao do AQ-261012-AF3XL, que ficou sem registro
      // nenhum enquanto outros do mesmo dia registraram.
      await registrarZap({
        referencia,
        nome: cliente.nome,
        telefone: cliente.telefone,
        etapa: 'nao tentou',
        resultado: {
          enviado: false,
          erro: pedido.metodo === 'card' ? 'metodo cartao' : 'trava de 30 min pro mesmo e-mail',
        },
      }).catch(() => {})
    }

    // O aviso no meu celular nao pode depender da trava do zap do
    // cliente. A mesma pessoa gerando tres Pix em meia hora e justamente
    // quando eu mais preciso saber, e pagamento no cartao nao avisava
    // nada. A trava aqui e pela referencia, que e unica por pedido: cobre
    // POST repetido e deixa passar todo pedido de verdade.
    if (await podeNotificar('aviso:' + referencia, 1)) {
      notificarPedidoGerado({
        nome: cliente.nome,
        telefone: cliente.telefone,
        total: pedido.total,
        metodo: pedido.metodo,
        descricao: pedido.descricao,
        cidade: cliente.cidade || geo?.cidade || '',
      }).catch(() => {})
    }

    if (podeZap) {
      // E o zap pro cliente, sozinho, no mesmo segundo. A mesma trava
      // cobre os dois: um POST repetido nao manda dois zaps pra pessoa.
      const codigoPix = cobranca.pix?.payload || null

      // Sai sem await: roda em paralelo com o e-mail aqui embaixo, pra nao
      // somar tempo na tela de quem esta comprando. A promessa fica guardada
      // porque a segunda mensagem SO pode sair depois desta terminar.
      primeiraMsg = enviarZap({
        telefone: cliente.telefone,
        texto: textoPixGerado({
          nome: cliente.nome,
          descricao: pedido.descricao,
          total: pedido.total,
          payload: codigoPix,
        }),
      })
        .then(async (r) => {
          await registrarZap({
            referencia, nome: cliente.nome, telefone: cliente.telefone,
            etapa: 'pix gerado', resultado: r,
          })
          return r
        })
        .catch(async (e) => {
          // Engolir o erro aqui deixava o pedido sem NENHUMA linha no log:
          // nem "enviado", nem "nao tentou". Foi o que aconteceu com um
          // pedido de 12/10, e ficou impossivel saber se a mensagem saiu.
          await registrarZap({
            referencia, nome: cliente.nome, telefone: cliente.telefone,
            etapa: 'pix gerado', resultado: { enviado: false, erro: String(e?.message || e) },
          }).catch(() => {})
        })

      // O copia-e-cola NAO sai aqui. Vai depois do e-mail, la embaixo.
      // Duas mensagens no mesmo instante e padrao de robo, e e o tipo de
      // coisa que faz o WhatsApp derrubar a sessao do dispositivo.
      if (codigoPix && cliente.telefone) {
        codigoDepois = { telefone: cliente.telefone, codigo: codigoPix }
      }
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

    // Agora sim o copia-e-cola do Pix, sozinho numa mensagem.
    //
    // O await na primeira mensagem e o que garante a ORDEM. Na primeira
    // versao eu contava com o tempo do e-mail pra separar as duas, e o
    // codigo chegou ANTES do texto: se a WAME demora 2s pra aceitar a
    // primeira e o e-mail sai em 300ms, a segunda ultrapassa. Ordem de
    // chegada nao se garante com tempo, se garante esperando.
    //
    // O segundo await e porque isto e a ultima coisa antes da resposta:
    // sem ele a funcao pode ser congelada no meio do envio. Nenhum dos
    // dois derruba o pedido se falhar.
    // A primeira mensagem tem que ser esperada SEMPRE, mesmo quando nao
    // existe segunda. Antes esse await vivia dentro do if de baixo: numa
    // cobranca que volta sem codigo de Pix, ninguem esperava, a funcao
    // devolvia a resposta e o Netlify congelava ela no meio do envio. A
    // mensagem nao saia e nao sobrava nem linha no log. Foi o que
    // aconteceu no pedido AQ-261012-AF3XL.
    if (primeiraMsg) await primeiraMsg

    if (codigoDepois) {
      const r = await enviarZap({
        telefone: codigoDepois.telefone,
        texto: textoPixCodigo(codigoDepois.codigo),
      }).catch((e) => ({ enviado: false, erro: String(e?.message || e) }))
      await registrarZap({
        referencia, nome: cliente.nome, telefone: codigoDepois.telefone,
        etapa: 'codigo do pix', resultado: r,
      })
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
