/**
 * Notificação engraçada no celular via ntfy.sh (grátis, sem cadastro).
 * Cada venda confirmada sorteia uma mensagem diferente. Falha aqui
 * nunca pode derrubar o webhook — é só um "toc toc" no celular.
 */

export const NTFY_TOPIC = 'ToderatiAquieteAgora'

const ICONE = 'https://aquieteagora.com.br/img/icon-notificacao.png'

/**
 * O ntfy só garante header sem bugar com RFC 2047 (o mesmo padrão que
 * e-mail usa pra acento em "Assunto") — `encodeURIComponent` NÃO é
 * decodificado por ele, e o título aparecia literalmente como
 * "Aquiete%20%E2%80%94..." (o que no fim virava aquele nome com número e
 * símbolo estranho no celular). Isso aqui empacota o texto do jeito que o
 * ntfy espera: =?UTF-8?B?<base64>?=
 */
function tituloNtfy(titulo) {
  const bytes = new TextEncoder().encode(titulo)
  let binario = ''
  bytes.forEach((b) => { binario += String.fromCharCode(b) })
  return `=?UTF-8?B?${btoa(binario)}?=`
}

/** Base de tudo: manda um push pro celular via ntfy.sh. Nunca lança erro. */
export async function push(texto, titulo) {
  try {
    await fetch(`https://ntfy.sh/${NTFY_TOPIC}`, {
      method: 'POST',
      body: texto,
      headers: {
        'Title': tituloNtfy(titulo || 'Aquiete'),
        'Tags': 'moneybag',
        'Icon': ICONE,
      },
    })
  } catch { /* notificação nunca pode derrubar quem chamou */ }
}

const METODO_TXT = { PIX: 'Pix', CREDIT_CARD: 'Cartão', BOLETO: 'Boleto' }
const METODO_EMOJI = { PIX: '⚡', CREDIT_CARD: '💳', BOLETO: '🧾' }

/** Só o gancho engraçado — nome, valor e método vêm sempre nas linhas fixas embaixo. */
const GANCHOS = [
  '🚗💨 Rumo à Mercedes!',
  '🍔👑 Pagou o burguão hoje!',
  '💰🤑 CAIU GRANA!',
  '🔥😤 Vendeu de novo, cabuloso!',
  '🐍💅 Menor do ódio vendeu de novo!',
  '🥂✨ Aquiete bombando!',
  '🚀🌕 To the moon!',
  '🏆🎯 Boa demais!',
  '🍾🎊 Bora comemorar!',
  '😎💸 Entrou grana!',
  '📈🤑 Gráfico só sobe!',
  '👑💎 Realeza gastando!',
]

/** Manda o "toc toc" de venda no celular. Nunca lança erro pra fora. */
export async function notificarVenda({ nome, total, billingType }) {
  const valor = 'R$ ' + Number(total).toFixed(2).replace('.', ',')
  const metodo = METODO_TXT[String(billingType ?? '').toUpperCase()] || 'algum método aí'
  const metodoEmoji = METODO_EMOJI[String(billingType ?? '').toUpperCase()] || '💰'
  const primeiro = String(nome ?? '').trim().split(' ')[0] || 'Alguém'
  const gancho = GANCHOS[Math.floor(Math.random() * GANCHOS.length)]

  const texto = [
    gancho,
    '👤 ' + primeiro,
    '💰 ' + valor + '  ' + metodoEmoji + ' ' + metodo,
  ].join('\n')

  await push(texto, 'Aquiete — venda confirmada 💸')
}

const brl = (v) => 'R$ ' + Number(v).toFixed(2).replace('.', ',')

/** Resumo de "como tá o dia", com o tom variando conforme o movimento. */
export async function notificarResumo({ vendas, total, visitas, checkouts, carrinhos, abandonados, online }) {
  const linhas = []
  if (vendas === 0 && visitas === 0) {
    linhas.push('😴 Site quietinho até agora, ninguém passou por aqui ainda.')
  } else if (vendas === 0) {
    linhas.push('👀 ' + visitas + ' visita' + (visitas===1?'':'s') + ' hoje, mas nenhuma venda ainda. Calma que o dia não acabou.')
  } else if (vendas <= 2) {
    linhas.push('🙂 ' + vendas + ' venda' + (vendas===1?'':'s') + ' hoje, ' + brl(total) + ' na conta. Devagar e sempre.')
  } else if (vendas <= 5) {
    linhas.push('🔥 ' + vendas + ' vendas hoje, ' + brl(total) + ' faturado! Dia bom.')
  } else {
    linhas.push('🚀🚀 ' + vendas + ' VENDAS hoje, ' + brl(total) + '! Bora que hoje é dia de Mercedes.')
  }
  linhas.push('📈 ' + visitas + ' visita' + (visitas===1?'':'s') + ' · ' + checkouts + ' checkout' + (checkouts===1?'':'s') + ' iniciado' + (checkouts===1?'':'s'))
  if (carrinhos > 0) {
    linhas.push('🛒 ' + carrinhos + ' carrinho' + (carrinhos===1?'':'s') + ' novo' + (carrinhos===1?'':'s') + ' hoje')
  }
  if (abandonados > 0) {
    linhas.push('😬 ' + abandonados + ' carrinho' + (abandonados===1?'':'s') + ' abandonado' + (abandonados===1?'':'s') + ' esperando um zap seu.')
  }
  if (online > 0) {
    linhas.push('🟢 ' + online + ' pessoa' + (online===1?'':'s') + ' no site AGORA')
  }
  await push(linhas.join('\n'), 'Aquiete — como tá o dia 📊')
}
