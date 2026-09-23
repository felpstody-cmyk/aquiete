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
export async function push(texto, titulo, extras = {}) {
  try {
    const headers = {
      'Title': tituloNtfy(titulo || 'Aquiete'),
      'Tags': extras.tags || 'moneybag',
      'Icon': ICONE,
    }
    // Botão dentro da notificação. O valor tem que ser ASCII puro: link
    // já vem percent-encoded, e o rótulo é escrito sem acento de propósito.
    if (extras.acoes) headers['Actions'] = extras.acoes
    await fetch(`https://ntfy.sh/${NTFY_TOPIC}`, { method: 'POST', body: texto, headers })
  } catch { /* notificação nunca pode derrubar quem chamou */ }
}

/** Só os dígitos, com 55 na frente — do jeito que o wa.me quer. */
export function zapNumero(telefone) {
  let d = String(telefone ?? '').replace(/\D/g, '')
  if (!d) return ''
  if (d.startsWith('55')) d = d.slice(2)
  if (d.length < 10 || d.length > 11) return ''   // não é celular BR válido
  return '55' + d
}

/**
 * A mensagem que o Felipe manda pra quem gerou o Pix e ainda não pagou.
 *
 * Escrita em primeira pessoa e curta de propósito: chega como mensagem de
 * gente, não como robô de loja, e é isso que faz a pessoa responder.
 */
export function textoZapPix({ nome, descricao, total }) {
  const primeiro = String(nome ?? '').trim().split(' ')[0] || ''
  const valor = 'R$ ' + Number(total || 0).toFixed(2).replace('.', ',')
  return [
    (primeiro ? `Oi, ${primeiro}! ` : 'Oi! ') + 'Aqui é o Felipe, do Aquiete.',
    '',
    `Seu pedido saiu certinho aqui (${descricao || 'Aquiete'}, ${valor}), só falta o Pix cair.`,
    '',
    'Se travou alguma coisa na hora de pagar ou ficou alguma dúvida, me chama por aqui mesmo que eu te ajudo. O código vence em 24h.',
  ].join('\n')
}

/** Link do WhatsApp já com a mensagem escrita. Vazio se não tem telefone. */
export function linkZapPix({ telefone, nome, descricao, total }) {
  const numero = zapNumero(telefone)
  if (!numero) return ''
  return `https://wa.me/${numero}?text=${encodeURIComponent(textoZapPix({ nome, descricao, total }))}`
}

/**
 * "Fulano gerou um Pix agora." Chega na hora, com o botão de chamar no
 * zap já pronto — o toque que decide entre a venda cair e o código vencer
 * é o que acontece nos primeiros minutos, enquanto a pessoa ainda está
 * com o celular na mão.
 */
export async function notificarPedidoGerado({ nome, telefone, total, metodo, descricao, cidade }) {
  const primeiro = String(nome ?? '').trim().split(' ')[0] || 'Alguém'
  const valor = 'R$ ' + Number(total || 0).toFixed(2).replace('.', ',')
  const forma = metodo === 'boleto' ? 'Boleto' : (metodo === 'card' ? 'Cartão' : 'Pix')

  const texto = [
    `⏳ ${primeiro} gerou um ${forma} de ${valor}` + (cidade ? ` — ${cidade}` : ''),
    descricao ? `🧴 ${descricao}` : null,
    'Ainda não pagou. Um zap agora resolve metade delas.',
  ].filter(Boolean).join('\n')

  const link = linkZapPix({ telefone, nome, descricao, total })
  await push(texto, `Aquiete — ${forma} gerado`, {
    tags: 'hourglass_flowing_sand',
    acoes: link ? `view, Chamar no zap, ${link}, clear=true` : undefined,
  })
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
const plural = (n, um, muitos) => n + ' ' + (n === 1 ? um : (muitos || um + 's'))
const sorteio = (lista) => lista[Math.floor(Math.random() * lista.length)]

/**
 * Trava contra notificação repetida.
 *
 * O agendador do Netlify garante "pelo menos uma vez": quando a função
 * demora (esta busca dados no Asaas), ele roda de novo e a mesma
 * notificação chegava duas vezes com 1 minuto de diferença. A chave fica
 * guardada no Blobs, então vale mesmo entre execuções diferentes.
 *
 * Devolve true se PODE mandar (ainda não mandou essa).
 */
export async function podeNotificar(chave, minutos = 30) {
  try {
    const { getStore } = await import('@netlify/blobs')
    const store = getStore('notificacoes')
    const antes = Number(await store.get(chave)) || 0
    if (antes && (Date.now() - antes) / 60_000 < minutos) return false
    await store.set(chave, String(Date.now()))
    return true
  } catch {
    // Sem Blobs é melhor notificar (e talvez repetir) do que ficar mudo.
    return true
  }
}

/* ---- pedaços soltos, pra mensagem não sair sempre igual ---- */
const linhaVendas = ({ vendas, total }) => {
  if (vendas === 0) return null
  if (vendas <= 2) return sorteio([
    '🙂 ' + plural(vendas, 'venda') + ' hoje, ' + brl(total) + ' na conta.',
    '💸 Entrou ' + brl(total) + ' hoje, em ' + plural(vendas, 'venda') + '.',
    '🙂 ' + plural(vendas, 'venda') + ' fechada' + (vendas === 1 ? '' : 's') + '. ' + brl(total) + '.',
  ])
  if (vendas <= 5) return sorteio([
    '🔥 ' + vendas + ' vendas hoje, ' + brl(total) + ' faturado. Dia bom.',
    '💵 ' + vendas + ' vendas e ' + brl(total) + ' no caixa. Tá andando.',
  ])
  return sorteio([
    '🚀 ' + vendas + ' VENDAS hoje, ' + brl(total) + '. Dia de Mercedes.',
    '👑 ' + vendas + ' vendas, ' + brl(total) + '. Hoje o gráfico subiu feio.',
  ])
}
const linhaTrafego = ({ visitas, checkouts }) =>
  '📈 ' + plural(visitas, 'visita') + ' · ' + plural(checkouts, 'checkout') + ' iniciado' + (checkouts === 1 ? '' : 's')
const linhaOferta = ({ ofertaVisitas, ofertaCheckouts }) =>
  ofertaVisitas > 0 ? '🎯 Página de venda: ' + plural(ofertaVisitas, 'visita') + ' · ' + plural(ofertaCheckouts, 'checkout') : null
const linhaCarrinhos = ({ carrinhos }) =>
  carrinhos > 0 ? '🛒 ' + plural(carrinhos, 'carrinho') + ' novo' + (carrinhos === 1 ? '' : 's') + ' hoje' : null
const linhaAbandonados = ({ abandonados }) =>
  abandonados > 0 ? '😬 ' + plural(abandonados, 'carrinho') + ' abandonado' + (abandonados === 1 ? '' : 's') + ' esperando um zap seu.' : null
const linhaOnline = ({ online }) =>
  online > 0 ? '🟢 ' + plural(online, 'pessoa') + ' no site AGORA' : null

/**
 * Resumo de "como tá o dia". Cada horário sorteia um formato diferente —
 * às vezes o resumo inteiro, às vezes uma linha só, às vezes só o que
 * pede ação (gente online, carrinho abandonado). Mensagem sempre igual
 * vira paisagem e a pessoa para de abrir.
 */
export async function notificarResumo(d) {
  const { vendas, visitas, online, abandonados, ontemVisitas } = d

  // Venda é notícia grande: quando tem, sempre aparece.
  const formatos = []
  if (vendas > 0) {
    formatos.push(
      { titulo: 'Aquiete — como tá o dia 📊', linhas: [linhaVendas(d), linhaTrafego(d), linhaOferta(d), linhaCarrinhos(d), linhaAbandonados(d), linhaOnline(d)] },
      { titulo: 'Aquiete — vendeu hoje 💸', linhas: [linhaVendas(d)] },
      { titulo: 'Aquiete — resumo rápido', linhas: [linhaVendas(d), linhaTrafego(d)] },
    )
  } else {
    formatos.push(
      { titulo: 'Aquiete — como tá o dia 📊', linhas: [linhaTrafego(d), linhaOferta(d), linhaCarrinhos(d), linhaAbandonados(d), linhaOnline(d)] },
      { titulo: 'Aquiete — movimento agora', linhas: [linhaTrafego(d)] },
    )
    if (online > 0) formatos.push({ titulo: 'Aquiete — tem gente no site 👀', linhas: [linhaOnline(d)] })
    if (abandonados > 0) formatos.push({ titulo: 'Aquiete — carrinho esperando 🛒', linhas: [linhaAbandonados(d), linhaCarrinhos(d)] })
    if (ontemVisitas > 0 && visitas > 0) {
      const dif = visitas - ontemVisitas
      formatos.push({
        titulo: 'Aquiete — contra ontem',
        linhas: [
          '📊 ' + plural(visitas, 'visita') + ' hoje. Ontem o dia inteiro deu ' + ontemVisitas + '.',
          dif >= 0 ? '↗️ Já passou o de ontem.' : '↘️ Faltam ' + Math.abs(dif) + ' pra empatar com ontem.',
        ],
      })
    }
    if (visitas === 0) {
      formatos.length = 0
      formatos.push({ titulo: 'Aquiete — silêncio', linhas: [sorteio([
        '😴 Ninguém passou no site até agora.',
        '🦗 Zero visita até aqui. Anúncio tá rodando?',
      ])] })
    }
  }

  const escolhido = sorteio(formatos)
  const linhas = escolhido.linhas.filter(Boolean)
  if (!linhas.length) return
  await push(linhas.join('\n'), escolhido.titulo)
}
