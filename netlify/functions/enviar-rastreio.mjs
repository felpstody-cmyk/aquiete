/**
 * POST /api/enviar-rastreio   (cabeçalho x-admin-token: ADMIN_TOKEN)
 *
 * Cola o código dos Correios no sistema e ele vai direto pro cliente por
 * e-mail. Não busca nada no Asaas — nome, e-mail e referência vêm de quem
 * chamou (o sistema já tem tudo isso listado via admin-dados).
 *
 * O código fica ANOTADO (ver _lib/rastreio.mjs). Antes ele era digitado,
 * mandado e esquecido, e não havia como responder quem ainda faltava.
 *
 * `so: true` no corpo ANOTA SEM AVISAR NINGUÉM. Existe pro pedido que já
 * foi postado antes deste registro existir: sem isso, acertar o sistema
 * significaria disparar de novo zap e e-mail pra quem já recebeu o código
 * há dias.
 */

import { enviar, htmlRastreio } from './_lib/email.mjs'
import { enviarZap, textoRastreio } from './_lib/zap.mjs'
import { guardarRastreio } from './_lib/rastreio.mjs'
import { registrarZap } from './_lib/zaplog.mjs'

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
  // Quem está levando. Vem do painel, que já sabe pelo despacho — e sem
  // isso o cliente lia "já está com os Correios" num pacote da Jadlog.
  const transportadora = String(corpo.transportadora ?? '').trim().slice(0, 60)

  // Só registrar não precisa de e-mail: ninguém vai ser avisado.
  const soRegistrar = corpo.so === true
  if (!rastreio) return json({ erro: 'Faltando o código de rastreio' }, 400)
  if (!referencia) return json({ erro: 'Faltando a referência do pedido' }, 400)
  if (!email && !soRegistrar) return json({ erro: 'Faltando o e-mail do cliente' }, 400)

  /*
   * Acerto de pedido que já saiu: anota e pronto.
   *
   * Este caminho existe porque o registro nasceu DEPOIS de uns pedidos já
   * estarem em trânsito. Sem ele, a única forma de o sistema saber que a
   * Vivian já tem o código dela seria mandar o código de novo pra ela.
   */
  if (soRegistrar) {
    await guardarRastreio({
      referencia, codigo: rastreio, transportadora, nome,
      zap: false, email: false, so: true,
    })
    await registrarZap({
      referencia, nome, telefone,
      etapa: 'rastreio',
      resultado: { enviado: false, erro: 'so registrado, cliente ja tinha o codigo' },
    }).catch(() => {})
    return json({ ok: true, soRegistro: true, rastreio })
  }

  // O zap sai primeiro e não derruba o e-mail se falhar. Quem comprou
  // olha o WhatsApp muito antes de olhar a caixa de entrada.
  const zap = telefone
    ? await enviarZap({ telefone, texto: textoRastreio({ nome, referencia, rastreio, transportadora }) }).catch(() => ({ enviado: false }))
    : { enviado: false, erro: 'sem telefone' }

  let porEmail = { enviado: false, erro: '' }
  try {
    porEmail = await enviar({
      para: email,
      assunto: `Seu pedido ${referencia || 'Aquiete'} saiu para entrega`,
      html: htmlRastreio({ nome, referencia, rastreio, transportadora }),
    })
  } catch (e) {
    porEmail = { enviado: false, erro: String(e.message || e) }
  }

  /*
   * Anota mesmo quando os dois avisos falham, e isso é de propósito.
   *
   * O código FOI aplicado ao pedido: a etiqueta está impressa e o pacote
   * vai sair. Deixar de anotar porque a mensagem não entregou faria o
   * pedido reaparecer eternamente na lista de "falta rastreio", e ele seria
   * postado duas vezes. O que entregou e o que não entregou fica gravado
   * nos campos `zap` e `email`, pra dar pra reenviar só o que falhou.
   *
   * Com await: a função congela ao responder, e promessa solta aqui
   * morreria sem terminar.
   */
  await guardarRastreio({
    referencia, codigo: rastreio, transportadora, nome,
    zap: Boolean(zap.enviado), email: Boolean(porEmail.enviado),
  })

  // Entra no mesmo log dos outros envios. Era o único envio da loja que
  // não registrava, e por isso "não recebi o rastreio" não tinha onde ser
  // conferido.
  await registrarZap({
    referencia, nome, telefone, etapa: 'rastreio', resultado: zap,
  }).catch(() => {})

  // E-mail falhou mas o zap saiu? Isso não é erro: o cliente foi avisado.
  if (porEmail.enviado || zap.enviado) {
    return json({ ok: true, zap, enviado: Boolean(porEmail.enviado), erro: porEmail.erro || '' })
  }
  return json({ erro: porEmail.erro || 'nem o zap nem o e-mail sairam', zap }, 502)
}

export const config = { path: '/api/enviar-rastreio' }
