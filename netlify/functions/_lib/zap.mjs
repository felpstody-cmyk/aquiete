/**
 * Mensagem de WhatsApp pelo número da loja.
 *
 * Não é a API oficial da Meta. É um serviço que mantém a conexão do
 * WhatsApp Web de pé pelo chip da loja e expõe um endpoint HTTP — por
 * isso aqui não tem modelo aprovado, verificação de empresa nem custo
 * por mensagem, e o texto é livre.
 *
 * O número usado aqui é SEMPRE o chip da loja. Nunca um número pessoal:
 * isso contraria as regras do WhatsApp e o risco é o número ser banido.
 * Com o chip da loja o prejuízo de um ban é R$15 e um domingo perdido.
 *
 * Variáveis no painel do Netlify:
 *   ZAP_PROVEDOR  "wame" (padrão) ou "zapi"
 *   ZAP_KEY       a chave da instância (wame) ou o id da instância (zapi)
 *   ZAP_TOKEN     só a Z-API usa
 *   ZAP_CLIENT    só a Z-API usa (Client-Token da conta)
 *   ZAP_URL       base do serviço, se for diferente do padrão
 *
 * Sem ZAP_KEY isto vira no-op: ninguém recebe zap e o site segue
 * mandando e-mail exatamente como mandava antes. Nenhuma função quebra
 * por causa disso — é assim de propósito, pra poder subir o código antes
 * de a conta existir.
 */

const BASE_PADRAO = {
  wame: 'https://us.api-wa.me',
  zapi: 'https://api.z-api.io',
}

/** Só os dígitos com 55 na frente, do jeito que os serviços querem. */
export function numeroZap(telefone) {
  let d = String(telefone ?? '').replace(/\D/g, '')
  if (d.startsWith('55')) d = d.slice(2)
  if (d.length < 10 || d.length > 11) return ''   // não é celular BR
  return '55' + d
}

export function zapAtivo() {
  return Boolean(process.env.ZAP_KEY)
}

function config() {
  const provedor = (process.env.ZAP_PROVEDOR || 'wame').toLowerCase()
  const base = (process.env.ZAP_URL || BASE_PADRAO[provedor] || BASE_PADRAO.wame).replace(/\/+$/, '')
  return { provedor, base, key: process.env.ZAP_KEY }
}

/**
 * Manda a mensagem. NUNCA lança erro: zap que falha não pode derrubar um
 * pedido que já foi criado nem um webhook de pagamento. Devolve o que
 * aconteceu pra quem quiser logar.
 */
export async function enviarZap({ telefone, texto }) {
  const to = numeroZap(telefone)
  if (!to) return { enviado: false, erro: 'telefone inválido' }
  if (!texto) return { enviado: false, erro: 'texto vazio' }
  if (!zapAtivo()) return { enviado: false, erro: 'ZAP_KEY não configurada' }

  const { provedor, base, key } = config()

  let url, corpo, headers = { 'Content-Type': 'application/json' }
  if (provedor === 'zapi') {
    url = `${base}/instances/${key}/token/${process.env.ZAP_TOKEN}/send-text`
    corpo = { phone: to, message: texto }
    if (process.env.ZAP_CLIENT) headers['Client-Token'] = process.env.ZAP_CLIENT
  } else {
    url = `${base}/${key}/message/text`
    corpo = { to, text: texto }
  }

  try {
    // Timeout curto: melhor a mensagem não sair do que a pessoa ficar
    // olhando pra tela de "gerando seu Pix" porque o serviço travou.
    const corta = AbortSignal.timeout ? AbortSignal.timeout(8000) : undefined
    const r = await fetch(url, { method: 'POST', headers, body: JSON.stringify(corpo), signal: corta })
    if (!r.ok) {
      const detalhe = await r.text().catch(() => '')
      console.error('[zap]', r.status, detalhe.slice(0, 200))
      return { enviado: false, erro: `HTTP ${r.status}` }
    }
    return { enviado: true }
  } catch (e) {
    console.error('[zap] falhou:', e.message)
    return { enviado: false, erro: e.message }
  }
}

/* ============================ os textos ============================
 * Voz da loja, mas escrita como gente escreve. Frase curta, sem
 * travessão e sem "prezado cliente" — o que chega no WhatsApp com cara
 * de circular de banco a pessoa nem abre.
 */

const brl = (v) => 'R$ ' + Number(v || 0).toFixed(2).replace('.', ',')
const primeiroNome = (n) => String(n ?? '').trim().split(' ')[0] || ''
const oi = (nome) => (primeiroNome(nome) ? `Oi, ${primeiroNome(nome)}!` : 'Oi!')

/** Na hora que o Pix é gerado. */
export function textoPixGerado({ nome, descricao, total }) {
  return [
    `${oi(nome)} Aqui é da Aquiete 🌿`,
    '',
    `Seu pedido tá reservado (${descricao || 'Aquiete'}, ${brl(total)}), só falta o Pix cair.`,
    '',
    'Se travou alguma coisa na hora de pagar, é só responder aqui que a gente resolve. O código vence em 24h.',
  ].join('\n')
}

/** Umas horas depois, se o Pix continua sem pagar. */
export function textoLembretePix({ nome, total, payload }) {
  return [
    `${oi(nome)} Passando só pra lembrar: seu Pix de ${brl(total)} ainda não caiu.`,
    '',
    'Se tu perdeu o código, é esse aqui, é só copiar e colar no app do banco:',
    '',
    payload || '(o código foi pro seu e-mail também)',
    '',
    'Qualquer dúvida antes de pagar, manda aqui.',
  ].join('\n')
}

/** Quem digitou os dados e sumiu antes de gerar pagamento. */
export function textoCarrinhoParado({ nome, descricao }) {
  return [
    `${oi(nome)} Aqui é da Aquiete.`,
    '',
    `Vi que tu montou o pedido aqui${descricao ? ` (${descricao})` : ''} e parou no meio do caminho.`,
    '',
    'Deu algum problema no pagamento, ou ficou alguma dúvida sobre o produto?',
    '',
    'Pode perguntar por aqui que a gente responde. Teu carrinho continua guardado: https://aquieteagora.com.br/oferta.html',
  ].join('\n')
}

/** Pagamento confirmado. */
export function textoPago({ nome, referencia }) {
  return [
    `Pagamento confirmado, ${primeiroNome(nome) || 'tudo certo'}! 🎉`,
    '',
    `Seu pedido ${referencia || ''} já entrou na fila de envio e sai em até 2 dias úteis.`,
    '',
    'Assim que postar, o código de rastreio chega aqui mesmo.',
  ].join('\n')
}

/** Código dos Correios. */
export function textoRastreio({ nome, referencia, rastreio }) {
  return [
    `${oi(nome)} Seu pedido ${referencia || ''} saiu pra entrega 📦`,
    '',
    `Código de rastreio: ${rastreio}`,
    'Acompanha em: https://rastreamento.correios.com.br',
    '',
    'Qualquer coisa na entrega, fala comigo por aqui.',
  ].join('\n')
}
