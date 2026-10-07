/**
 * Vigia da conexão do WhatsApp da loja.
 *
 * O problema que isto resolve não é a sessão cair — é ela cair e ninguém
 * ficar sabendo. A loja continua vendendo, gerando Pix e mandando e-mail
 * normalmente, e o zap simplesmente para. Sem isto aqui, só se descobre
 * por acaso, dias depois.
 *
 * Três camadas:
 *   1. queda de socket / instância descarregada  →  religa sozinho,
 *      sem QR, sem ninguém. É a maioria das quedas.
 *   2. logout de verdade (o WhatsApp desvinculou o aparelho)  →  push no
 *      celular com o código de 8 caracteres pra digitar. Só isso precisa
 *      de gente, e é uma regra do WhatsApp: nenhum provedor pareia um
 *      aparelho sozinho, senão qualquer um sequestrava o número.
 *   3. e-mail nunca para. A loja degrada, não emudece.
 *
 * Quem chama: zap-vigia (de 10 em 10 minutos) e zap-conexao (o webhook da
 * WAME, que avisa no instante em que a conexão muda).
 */

import { estadoZap, reiniciarZap, codigoPareamento, pausa, zapAtivo } from './zap.mjs'
import { push, podeNotificar } from './notificar.mjs'

/** Quanto esperar o restart assentar antes de conferir de novo. */
const ESPERA_RESTART_MS = 6000

/** Não enche o saco: no máximo um push de "caiu" a cada 6 horas. */
const MINUTOS_ENTRE_AVISOS = 360

let getStore = null
async function loja() {
  if (!getStore) ({ getStore } = await import('@netlify/blobs'))
  return getStore('zap-estado')
}

/** O que o painel mostra. Nunca lança: painel não pode quebrar por isto. */
export async function lerEstadoZap() {
  try {
    const store = await loja()
    return (await store.get('atual', { type: 'json' })) || null
  } catch {
    return null
  }
}

async function guardar(dados) {
  try {
    const store = await loja()
    await store.setJSON('atual', { ...dados, em: Date.now() })
  } catch { /* não saber guardar não pode derrubar o vigia */ }
}

/**
 * Olha, conserta se der, avisa se não der.
 *
 * `origem` só entra no registro, pra depois dar pra saber se quem pegou a
 * queda foi o webhook (instantâneo) ou a ronda de 10 em 10 minutos.
 */
export async function vigiar({ origem = 'agendado' } = {}) {
  if (!zapAtivo()) return { ligado: false }

  const antes = await lerEstadoZap()
  const estado = await estadoZap()

  // A WAME não respondeu, ou o provedor não tem como checar. Não dá pra
  // saber se caiu — e agir no escuro aqui significa reiniciar uma sessão
  // que estava boa. Fica quieto e tenta de novo na próxima ronda.
  if (!estado.sabe) {
    await guardar({ ...(antes || {}), origem, incerto: true, erro: estado.erro })
    return { ligado: true, sabe: false, erro: estado.erro }
  }

  if (estado.conectado) {
    await guardar({
      conectado: true,
      numero: estado.numero || antes?.numero || '',
      origem,
      ultimoOk: Date.now(),
    })
    return { ligado: true, conectado: true }
  }

  // Caiu. Primeiro tenta o jeito que não precisa de ninguém.
  await reiniciarZap()
  await pausa(ESPERA_RESTART_MS)
  const depois = await estadoZap()

  if (depois.conectado) {
    await guardar({
      conectado: true,
      numero: depois.numero || antes?.numero || '',
      origem,
      ultimoOk: Date.now(),
      religouSozinho: Date.now(),
    })
    return { ligado: true, conectado: true, religou: true }
  }

  // Não voltou: é logout de verdade. Aí precisa do celular.
  // O número vem do último estado bom — assim não há número chumbado no
  // código, e se o chip trocar um dia isto continua certo.
  const numero = antes?.numero || estado.numero || process.env.ZAP_NUMERO_LOJA || ''
  let codigo = ''
  if (numero) {
    const r = await codigoPareamento(numero)
    if (r.ok) codigo = r.codigo
  }

  await guardar({
    conectado: false,
    numero,
    origem,
    caiuEm: antes?.conectado === false ? antes?.caiuEm || Date.now() : Date.now(),
    ultimoOk: antes?.ultimoOk || null,
  })

  if (await podeNotificar('zap-caiu', MINUTOS_ENTRE_AVISOS)) {
    const linhas = [
      '📵 O WhatsApp da loja desconectou e não voltou sozinho.',
      '',
      'Os pedidos e os e-mails seguem normais — só o zap parou.',
      '',
      codigo
        ? `Religa assim, pelo celular mesmo:\n\nWhatsApp Business → Configurações → Dispositivos conectados → Conectar um dispositivo → Conectar com número de telefone\n\nCódigo: ${codigo}`
        : 'Abre o painel da WAME e lê o QR code de novo pra religar.',
    ]
    await push(linhas.join('\n'), 'Aquiete — zap caiu', { tags: 'warning' })
  }

  return { ligado: true, conectado: false, codigo: codigo || null }
}
