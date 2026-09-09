/**
 * Notificação engraçada no celular via ntfy.sh (grátis, sem cadastro).
 * Cada venda confirmada sorteia uma mensagem diferente. Falha aqui
 * nunca pode derrubar o webhook — é só um "toc toc" no celular.
 */

export const NTFY_TOPIC = 'ToderatiAquieteAgora'

/** Base de tudo: manda um push pro celular via ntfy.sh. Nunca lança erro. */
export async function push(texto, titulo) {
  try {
    await fetch(`https://ntfy.sh/${NTFY_TOPIC}`, {
      method: 'POST',
      body: texto,
      headers: { 'Title': encodeURIComponent(titulo || 'Aquiete'), 'Tags': 'moneybag' },
    })
  } catch { /* notificação nunca pode derrubar quem chamou */ }
}

const METODO_TXT = { PIX: 'Pix', CREDIT_CARD: 'Cartão', BOLETO: 'Boleto' }

const MENSAGENS = [
  (n, v, m) => `🚗💨 Rumo à Mercedes! ${n} acabou de pagar ${v} no ${m}`,
  (n, v, m) => `🍔👑 Pagou o burguão hoje! ${v} de ${n} (${m})`,
  (n, v, m) => `💰🤑 CAIU GRANA! ${n} mandou ${v} no ${m}`,
  (n, v, m) => `🔥 Vendeu de novo, cabuloso! ${v} de ${n} via ${m}`,
  (n, v, m) => `🐍 Menor do ódio vendeu de novo! ${v} de ${n} no ${m}`,
  (n, v, m) => `🥂 Aquiete bombando! ${n} fechou ${v} no ${m}`,
  (n, v, m) => `🚀 To the moon! ${v} de ${n} via ${m}`,
  (n, v, m) => `🏆 Boa demais! ${n} confiou e pagou ${v} no ${m}`,
  (n, v, m) => `🍾 Mais ${v} na conta, cortesia de ${n} (${m})`,
  (n, v, m) => `😎💵 Entrou grana: ${n} — ${v} (${m})`,
  (n, v, m) => `🤑📈 Gráfico só sobe: ${n} pagou ${v} no ${m}`,
  (n, v, m) => `👑 Realeza gastando: ${n} — ${v} via ${m}`,
]

/** Manda o "toc toc" de venda no celular. Nunca lança erro pra fora. */
export async function notificarVenda({ nome, total, billingType }) {
  const valor = 'R$ ' + Number(total).toFixed(2).replace('.', ',')
  const metodo = METODO_TXT[String(billingType ?? '').toUpperCase()] || 'algum método aí'
  const primeiro = String(nome ?? '').trim().split(' ')[0] || 'Alguém'
  const monta = MENSAGENS[Math.floor(Math.random() * MENSAGENS.length)]
  await push(monta(primeiro, valor, metodo), 'Aquiete — venda confirmada 💸')
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
