/**
 * POST /api/sinal   { evento, id, pagina, valor?, consent?, fbp?, fbc? }
 *
 * Caminho de primeira parte pro Meta. O navegador chama aqui, e daqui o
 * servidor repassa pro CAPI com o IP e o navegador de verdade.
 *
 * Por que não mandar direto do navegador: o pixel só carrega pra quem
 * aceita o cookie, e na prática isso era 12% do movimento. Este endereço
 * é do próprio domínio, então ele responde pra todo mundo.
 *
 * Quem clicou "Só o necessário" é barrado aqui. Aquele botão é uma
 * promessa escrita na tela da pessoa; se ele não fizer nada, o aviso de
 * cookie vira mentira. Quem apenas ignorou o aviso não decidiu nada, e
 * esse é o caso da maioria.
 *
 * Nunca responde erro: medição não pode atrapalhar quem está comprando.
 */

import { enviarSinal } from './_lib/meta-capi.mjs'

const vazio = () => new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } })

export default async (req, contexto) => {
  if (req.method !== 'POST') return vazio()

  const corpo = await req.json().catch(() => null)
  if (!corpo?.evento || !corpo?.id) return vazio()
  if (corpo.consent === 'essencial') return vazio()

  const ip =
    req.headers.get('x-nf-client-connection-ip') ||
    contexto?.ip ||
    (req.headers.get('x-forwarded-for') || '').split(',')[0].trim() ||
    null

  try {
    await enviarSinal({
      nome: String(corpo.evento),
      eventId: String(corpo.id).slice(0, 120),
      url: typeof corpo.pagina === 'string' ? corpo.pagina.slice(0, 300) : null,
      ip,
      ua: req.headers.get('user-agent'),
      fbp: typeof corpo.fbp === 'string' ? corpo.fbp.slice(0, 120) : null,
      fbc: typeof corpo.fbc === 'string' ? corpo.fbc.slice(0, 200) : null,
      valor: corpo.valor != null ? Number(corpo.valor) : null,
    })
  } catch (e) {
    console.log('[sinal] falhou:', e.message)
  }

  return vazio()
}

export const config = { path: '/api/sinal' }
