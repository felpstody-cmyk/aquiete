/**
 * GET /api/falar?de=duvida|rastreio|golpe   →  302 pro WhatsApp da loja
 *
 * O menu da home tinha "Falar conosco" apontando pra
 * `https://wa.me/55SEUNUMERO` — o placeholder do template, no ar desde
 * que a página nasceu. Quem clicava recebia "número de telefone
 * inválido" do próprio WhatsApp. E "Rastrear pedido" era `href="#"`.
 *
 * Isso importa mais do que parece: em 31/10/2026 apareceram dois
 * comentários no anúncio, "não tem comentário" e "alguém já comprou ou é
 * golpe". Quem desconfia vai no site e clica justamente nesses dois
 * links pra ver se existe gente do outro lado. Os dois estavam quebrados,
 * o que confirmava a desconfiança em vez de desmontar ela.
 *
 * O número NÃO fica chumbado aqui. Vem do chip que está conectado na
 * instância, que é a única fonte que não envelhece: se ele trocar de
 * chip, isto continua certo sem ninguém lembrar de editar.
 *
 * E tem um ganho de operação em cima: a instância saiu do tipo OFICIAL
 * por engano e só entrega mensagem pra quem escreveu primeiro, dentro da
 * janela de 24h. Um link que faz o CLIENTE abrir a conversa não é só
 * conveniência — é o que torna a resposta possível.
 */

import { numeroZap, estadoZap } from './_lib/zap.mjs'
import { lerEstadoZap } from './_lib/zapvigia.mjs'

const EMAIL = 'contato@aquieteagora.com.br'

/** O que já vai escrito, pra pessoa só apertar enviar. */
const TEXTOS = {
  duvida: 'Oi! Tenho uma dúvida sobre o Aquiete.',
  rastreio: 'Oi! Quero acompanhar meu pedido da Aquiete. Meu pedido é o AQ-',
  golpe: 'Oi! Vi o anúncio do Aquiete e queria falar com alguém antes de comprar.',
}

/**
 * Quem é o chip da loja.
 *
 * Na ordem do mais barato pro mais caro: o blob que o vigia já mantém
 * atualizado, depois a instância ao vivo, e por último a variável — que
 * é só rede de segurança pra quando a instância estiver fora do ar.
 */
async function numeroDaLoja() {
  const salvo = numeroZap((await lerEstadoZap().catch(() => null))?.numero)
  if (salvo) return salvo

  const vivo = numeroZap((await estadoZap().catch(() => null))?.numero)
  if (vivo) return vivo

  return numeroZap(process.env.ZAP_NUMERO_LOJA)
}

export default async (req) => {
  const q = new URL(req.url).searchParams
  const texto = TEXTOS[q.get('de')] || TEXTOS.duvida

  const numero = await numeroDaLoja()

  /*
   * Sem número, o link vira e-mail em vez de erro.
   *
   * Um "Falar conosco" que abre o cliente de e-mail é pior que o
   * WhatsApp e melhor que tudo o que havia antes. O que não pode voltar
   * a existir é o clique que não leva a lugar nenhum.
   */
  const destino = numero
    ? `https://wa.me/${numero}?text=${encodeURIComponent(texto)}`
    : `mailto:${EMAIL}?subject=${encodeURIComponent('Aquiete')}&body=${encodeURIComponent(texto)}`

  return new Response(null, {
    status: 302,
    headers: {
      Location: destino,
      // Dez minutos de cache quando achou o número: economiza a leitura
      // do blob em cada clique. Sem número, não cacheia — a instância
      // pode voltar a qualquer momento e o próximo clique merece o zap.
      'Cache-Control': numero ? 'public, max-age=600' : 'no-store',
    },
  })
}

export const config = { path: '/api/falar' }
