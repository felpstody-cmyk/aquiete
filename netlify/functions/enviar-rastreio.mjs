/**
 * POST /api/enviar-rastreio   (cabeçalho x-admin-token: ADMIN_TOKEN)
 *
 * Cola o código dos Correios no sistema e ele vai direto pro cliente por
 * e-mail. Não busca nada no Asaas — nome, e-mail e referência vêm de quem
 * chamou (o sistema já tem tudo isso listado via admin-dados).
 */

import { enviar, htmlRastreio } from './_lib/email.mjs'
import { enviarZap, textoRastreio } from './_lib/zap.mjs'

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

  const nome = String(corpo.nome ?? '').trim()
  const email = String(corpo.email ?? '').trim()
  const telefone = String(corpo.telefone ?? '').trim()
  const referencia = String(corpo.referencia ?? '').trim()
  const rastreio = String(corpo.rastreio ?? '').trim()

  if (!email) return json({ erro: 'Faltando o e-mail do cliente' }, 400)
  if (!rastreio) return json({ erro: 'Faltando o código de rastreio' }, 400)

  // O zap sai primeiro e não derruba o e-mail se falhar. Quem comprou
  // olha o WhatsApp muito antes de olhar a caixa de entrada.
  const zap = telefone
    ? await enviarZap({ telefone, texto: textoRastreio({ nome, referencia, rastreio }) }).catch(() => ({ enviado: false }))
    : { enviado: false, erro: 'sem telefone' }

  try {
    const resultado = await enviar({
      para: email,
      assunto: `Seu pedido ${referencia || 'Aquiete'} saiu para entrega`,
      html: htmlRastreio({ nome, referencia, rastreio }),
    })
    return json({ ok: true, zap, ...resultado })
  } catch (e) {
    // E-mail falhou mas o zap saiu? Isso não é erro: o cliente foi avisado.
    if (zap.enviado) return json({ ok: true, zap, enviado: false, erro: String(e.message || e) })
    return json({ erro: String(e.message || e) }, 502)
  }
}

export const config = { path: '/api/enviar-rastreio' }
