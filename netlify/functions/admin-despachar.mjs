/**
 * POST /api/admin-despachar   (cabeçalho x-admin-token: ADMIN_TOKEN)
 *
 * Cria o envio no Melhor Envio para um pedido que já está pago.
 *
 * O caminho normal é automático: o webhook despacha no instante em que o
 * dinheiro cai. Isto aqui é para os dois casos em que o automático não
 * alcança:
 *
 *   - venda anterior ao despacho automático existir, que não tem os
 *     dados guardados e por isso precisa que o painel os mande
 *   - venda em que o despacho falhou e ele quer tentar na hora, sem
 *     esperar a ronda de hora em hora
 *
 * Os dados do cliente vêm do painel, que os tem do gateway. Mesmo assim
 * passam por `validarCliente` aqui: o painel é autenticado, mas confiar
 * em payload de cliente é o tipo de atalho que depois cria uma etiqueta
 * com CEP inválido e frete cobrado errado.
 */

import { validarCliente, ErroDeEntrada, KITS } from './_lib/catalogo.mjs'
import { guardarDespacho, despachar, lerDespacho, faltaNoRemetente } from './_lib/envio.mjs'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type, x-admin-token',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const json = (dados, status = 200) =>
  new Response(JSON.stringify(dados), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...CORS },
  })

export default async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS })
  if (req.method !== 'POST') return json({ erro: 'Use POST' }, 405)

  const esperado = process.env.ADMIN_TOKEN
  if (!esperado) return json({ erro: 'ADMIN_TOKEN não configurado no Netlify' }, 500)
  if (req.headers.get('x-admin-token') !== esperado) return json({ erro: 'Token inválido' }, 401)

  let corpo
  try { corpo = await req.json() } catch { return json({ erro: 'JSON inválido' }, 400) }

  const referencia = String(corpo.referencia ?? '').trim()
  if (!referencia) return json({ erro: 'Falta a referência do pedido' }, 400)

  const falta = faltaNoRemetente()
  if (falta.length) {
    return json({
      erro: `O remetente está incompleto. Falta preencher no Netlify: ${falta.join(', ')}`,
    }, 400)
  }

  // Já existe despacho guardado (venda nova que falhou): não remonta nada,
  // só tenta de novo. Remontar sobrescreveria o serviço que o cliente
  // escolheu pelo que o painel achar que é.
  const guardado = await lerDespacho(referencia)
  if (guardado?.me?.id) {
    return json({ ok: true, repetido: true, id: guardado.me.id, me: guardado.me })
  }

  if (!guardado) {
    const kitId = String(corpo.kitId ?? '1')
    const kit = KITS[kitId]
    if (!kit) return json({ erro: `Kit inválido: ${kitId}` }, 400)

    let cliente
    try {
      cliente = validarCliente(corpo.cliente)
    } catch (e) {
      if (e instanceof ErroDeEntrada) return json({ erro: e.message }, 400)
      throw e
    }

    await guardarDespacho(referencia, {
      cliente,
      pedido: {
        kitId,
        descricao: `Aquiete — ${kit.rotulo}`,
        subtotal: kit.preco,
        frete: Number(corpo.frete) || 0,
        // Sem serviço: o despacho cota na hora e leva o mais barato. É o
        // certo aqui, porque qual serviço o cliente pagou não foi
        // guardado nas vendas antigas.
        envio: null,
      },
    })
  }

  const r = await despachar(referencia)
  if (!r.ok) return json({ erro: r.motivo || 'Não foi possível criar o envio' }, 502)
  return json(r)
}

export const config = { path: '/api/admin-despachar' }
