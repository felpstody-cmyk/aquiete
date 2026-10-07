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
 *   ZAP_PROVEDOR  "wame" (padrão), "zapi" ou "evolution"
 *   ZAP_KEY       wame: a chave da instância
 *                 zapi: o id da instância
 *                 evolution: o NOME da instância que você criou
 *   ZAP_TOKEN     zapi: o token · evolution: a AUTHENTICATION_API_KEY
 *   ZAP_CLIENT    só a Z-API usa (Client-Token da conta)
 *   ZAP_URL       base do serviço. Obrigatória no evolution, porque aí o
 *                 servidor é o seu e só você sabe o endereço dele.
 *
 * Sem ZAP_KEY isto vira no-op: ninguém recebe zap e o site segue
 * mandando e-mail exatamente como mandava antes. Nenhuma função quebra
 * por causa disso — é assim de propósito, pra poder subir o código antes
 * de a conta existir.
 */

/* A base de cada servico. O painel do provedor mostra a URL da SUA
 * instancia; se for diferente destas, e so botar em ZAP_URL que o
 * padrao daqui e ignorado.
 * A WAME trocou o site de api-wa.me pra wame.api.br, mas o SERVIDOR
 * da instancia continua em us.api-wa.me — foi conferido no painel da
 * conta da Aquiete em 07/10/2026. O site novo documenta outro host;
 * vale o que o painel mostra. */
const BASE_PADRAO = {
  wame: 'https://us.api-wa.me',
  zapi: 'https://api.z-api.io',
  evolution: '',            // sem padrão: o servidor é o do dono
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
  const padrao = BASE_PADRAO[provedor] ?? BASE_PADRAO.wame
  const base = String(process.env.ZAP_URL || padrao).replace(/\/+$/, '')
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
  if (!base) return { enviado: false, erro: 'falta ZAP_URL' }

  let url, corpo, headers = { 'Content-Type': 'application/json' }
  if (provedor === 'evolution') {
    url = `${base}/message/sendText/${key}`
    corpo = { number: to, text: texto }
    headers.apikey = process.env.ZAP_TOKEN || ''
  } else if (provedor === 'zapi') {
    url = `${base}/instances/${key}/token/${process.env.ZAP_TOKEN}/send-text`
    corpo = { phone: to, message: texto }
    if (process.env.ZAP_CLIENT) headers['Client-Token'] = process.env.ZAP_CLIENT
  } else {
    url = `${base}/${key}/message/text`
    corpo = { to, text: texto, provider: 'whatsapp' }
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

/* ==================== saude da conexao ====================
 * A sessao do WhatsApp e um dispositivo conectado, igual ao WhatsApp Web.
 * Ela cai: blip de rede, instancia descarregada no provedor, ou o proprio
 * WhatsApp deslogando o aparelho. As duas primeiras o restart resolve
 * sozinho; a ultima so com alguem segurando o celular — isso e uma regra
 * do WhatsApp, nenhum provedor burla.
 *
 * Estas tres chamadas so existem na WAME. Nos outros provedores devolvem
 * "nao sei checar", que o vigia trata como "nao mexe".
 */

async function chamarInstancia(caminho, metodo = 'GET', corpo = null) {
  if (!zapAtivo()) return { ok: false, erro: 'ZAP_KEY nao configurada' }
  const { provedor, base, key } = config()
  if (provedor !== 'wame') return { ok: false, erro: 'provedor sem checagem de conexao' }
  if (!base) return { ok: false, erro: 'falta ZAP_URL' }
  try {
    const r = await fetch(`${base}/${key}${caminho}`, {
      method: metodo,
      headers: corpo ? { 'Content-Type': 'application/json' } : undefined,
      body: corpo ? JSON.stringify(corpo) : undefined,
      signal: AbortSignal.timeout ? AbortSignal.timeout(10000) : undefined,
    })
    const dados = await r.json().catch(() => ({}))
    if (!r.ok) return { ok: false, erro: `HTTP ${r.status}`, dados }
    return { ok: true, dados }
  } catch (e) {
    return { ok: false, erro: e.message }
  }
}

/** O chip da loja ainda esta conectado? Chamada barata, feita pra isso. */
export async function estadoZap() {
  const r = await chamarInstancia('/instance/health')
  if (!r.ok) return { sabe: false, conectado: false, erro: r.erro }
  const i = r.dados?.instance || {}
  return {
    sabe: true,
    conectado: Boolean(i.connected && i.phoneConnected),
    numero: String(i.user?.id || '').split(':')[0] || '',
  }
}

/** Religa a instancia SEM pedir QR. Resolve a maioria das quedas. */
export async function reiniciarZap() {
  const r = await chamarInstancia('/instance/restart', 'POST')
  return { ok: r.ok, erro: r.erro }
}

/**
 * Codigo de 8 caracteres pra digitar no celular, quando so o religar nao
 * resolveu. Melhor que QR aqui: nao exige estar na frente do computador.
 */
export async function codigoPareamento(telefone) {
  const numero = numeroZap(telefone)
  if (!numero) return { ok: false, erro: 'telefone invalido' }
  const r = await chamarInstancia('/instance/pairing-code', 'POST', { phoneNumber: numero })
  if (!r.ok) return { ok: false, erro: r.erro }
  const d = r.dados || {}
  const codigo = d.code || d.pairingCode || d.pairing_code || d.codigo || ''
  return { ok: Boolean(codigo), codigo: String(codigo), erro: codigo ? null : 'resposta sem codigo' }
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
export function textoPixGerado({ nome, descricao, total, payload }) {
  const fim = payload
    ? 'Te mando o código do Pix na mensagem de baixo: é só copiar e colar no app do banco. Vence em 24h.'
    : 'Se travou alguma coisa na hora de pagar, é só responder aqui que a gente resolve. O código vence em 24h.'
  return [
    `${oi(nome)} Aqui é da Aquiete 🌿`,
    '',
    `Seu pedido tá reservado (${descricao || 'Aquiete'}, ${brl(total)}), só falta o Pix cair.`,
    '',
    fim,
  ].join('\n')
}

/**
 * Pausa entre dois envios pro mesmo numero.
 *
 * Mandar duas mensagens no mesmo instante e padrao de robo. Em API nao
 * oficial isso nao da "erro": o WhatsApp simplesmente derruba a sessao do
 * dispositivo conectado, a loja fica muda e ninguem percebe. So use onde
 * dá pra esperar (funcao agendada), nunca no meio do checkout.
 */
export const pausa = (ms = 2500) => new Promise((r) => setTimeout(r, ms))

/**
 * O copia-e-cola do Pix, SOZINHO numa mensagem.
 *
 * Tem que ir separado mesmo. No WhatsApp, copiar uma mensagem copia o
 * texto inteiro dela: se o codigo vier junto com a conversa, a pessoa
 * cola tudo no app do banco e o banco recusa. Sozinho, ela segura o
 * dedo, copia e cola limpo.
 *
 * O QR nao vai como imagem de proposito. Quem recebe isto esta olhando
 * o proprio celular e nao tem como escanear a propria tela.
 */
export function textoPixCodigo(payload) {
  return String(payload || '').trim()
}

/** Umas horas depois, se o Pix continua sem pagar. */
export function textoLembretePix({ nome, total, payload }) {
  return [
    `${oi(nome)} Passando só pra lembrar: seu Pix de ${brl(total)} ainda não caiu.`,
    '',
    payload
      ? 'Mandei o código aqui embaixo de novo, é só copiar e colar no app do banco.'
      : 'O código foi pro teu e-mail também.',
    '',
    'Qualquer dúvida antes de pagar, manda aqui.',
  ].join('\n')
}

/**
 * Quem digitou os dados e sumiu antes de gerar pagamento.
 *
 * Texto ditado pelo Felipe. Trata por "você" e não por "tu": o cliente
 * é de todo o Brasil, não de Santa Catarina.
 *
 * O link leva utm_source/utm_medium pra venda recuperada aparecer como
 * recuperada no painel. Sem isso ela entra como "direto" e ninguém fica
 * sabendo que foi o zap que trouxe a pessoa de volta.
 */
export function textoCarrinhoParado({ nome }) {
  const primeiro = primeiroNome(nome)
  return [
    primeiro ? `Oi, ${primeiro}, tudo bem?` : 'Oi, tudo bem?',
    '',
    'Vi que você iniciou seu pedido aqui no site, colocou suas informações, mas não finalizou.',
    '',
    'Ficou com alguma dúvida sobre o produto, ou deu algum problema no pagamento?',
    '',
    'Caso queira retomar, o link está aqui: https://aquieteagora.com.br/oferta?utm_source=whatsapp&utm_medium=carrinho',
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
