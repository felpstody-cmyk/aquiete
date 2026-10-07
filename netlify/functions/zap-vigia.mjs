/**
 * Ronda da conexão do WhatsApp — de 10 em 10 minutos, agendada pelo
 * Netlify (não tem URL pública).
 *
 * É a rede de segurança. O webhook (zap-conexao) avisa no instante em que
 * a conexão muda e resolve quase sempre primeiro, mas webhook se perde:
 * o provedor pode não mandar, pode chegar enquanto um deploy está
 * trocando as funções, pode falhar no meio. Esta ronda garante que a
 * queda nunca passa de 10 minutos sem alguém olhar.
 *
 * Quem faz o trabalho é vigiar(): olha, religa se der, avisa se não der.
 */

import { vigiar } from './_lib/zapvigia.mjs'

export default async () => {
  const r = await vigiar({ origem: 'ronda' })
  // Log curto: é o que vai dizer, daqui a um mês, se a sessão vive caindo
  // ou se aquilo foi só o susto do primeiro pareamento.
  if (r.ligado && !r.conectado) console.error('[zap-vigia] continua fora do ar')
  else if (r.religou) console.log('[zap-vigia] religou sozinho')
  return new Response('ok')
}

export const config = { schedule: '*/10 * * * *' }
