/**
 * Notificação engraçada no celular via ntfy.sh (grátis, sem cadastro).
 * Cada venda confirmada sorteia uma mensagem diferente. Falha aqui
 * nunca pode derrubar o webhook — é só um "toc toc" no celular.
 */

export const NTFY_TOPIC = 'ToderatiAquieteAgora'

const ICONE = 'https://aquieteagora.com.br/img/icon-notificacao.png'

/** Base de tudo: manda um push pro celular via ntfy.sh. Nunca lança erro. */
export async function push(texto, titulo) {
  try {
    await fetch(`https://ntfy.sh/${NTFY_TOPIC}`, {
      method: 'POST',
      body: texto,
      headers: {
        'Title': encodeURIComponent(titulo || 'Aquiete'),
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
export async function notificarResumo({ vendas, total, visitas, checkouts, abandonados }) {
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
  if (abandonados > 0) {
    linhas.push('😬 ' + abandonados + ' carrinho' + (abandonados===1?'':'s') + ' abandonado' + (abandonados===1?'':'s') + ' esperando um zap seu.')
  }
  await push(linhas.join('\n'), 'Aquiete — como tá o dia 📊')
}
