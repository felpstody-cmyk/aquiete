/**
 * Envio de e-mail transacional.
 *
 * Variáveis de ambiente:
 *   RESEND_API_KEY   chave da Resend (https://resend.com) — opcional
 *   EMAIL_REMETENTE  ex.: "Aquiete <contato@aquieteagora.com.br>"
 *   EMAIL_LOJISTA    para onde vai o aviso de venda
 *
 * Sem RESEND_API_KEY nada é enviado e nada quebra: a função registra no
 * log e segue. Confirmação de pedido não pode derrubar um pagamento que
 * já foi aprovado.
 */

const API = 'https://api.resend.com/emails'

const brl = (v) => 'R$ ' + Number(v).toFixed(2).replace('.', ',')

/** Escapa texto que entra no HTML do e-mail — nome vem do cliente. */
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
))

export async function enviar({ para, assunto, html }) {
  const chave = process.env.RESEND_API_KEY
  const de = process.env.EMAIL_REMETENTE || 'Aquiete <contato@aquieteagora.com.br>'

  if (!chave) {
    console.log('[email] RESEND_API_KEY ausente — não enviado:', assunto, '->', para)
    return { enviado: false, motivo: 'sem provedor' }
  }

  const r = await fetch(API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${chave}` },
    body: JSON.stringify({ from: de, to: [para], subject: assunto, html }),
  })

  if (!r.ok) {
    const detalhe = await r.text().catch(() => '')
    throw new Error(`Resend ${r.status}: ${detalhe.slice(0, 200)}`)
  }
  return { enviado: true }
}

/* ------------------------------------------------------------------ */

const MOLDURA = (miolo) => `
<div style="margin:0;padding:24px 12px;background:#FDF8F6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif">
  <div style="max-width:520px;margin:0 auto;background:#fff;border:1px solid #F1DFD9;border-radius:22px;overflow:hidden">
    <div style="padding:28px 28px 0;text-align:center">
      <div style="font-family:Georgia,serif;font-size:26px;color:#3B2B29;line-height:1">aquiete</div>
      <div style="font-size:10px;letter-spacing:.26em;text-transform:uppercase;color:#8B6F6C;margin-top:6px">Gotas Florais</div>
    </div>
    <div style="padding:28px;color:#5C4340;font-size:15px;line-height:1.65">${miolo}</div>
    <div style="padding:18px 28px;background:#FBEDE9;font-size:12px;color:#82655F;text-align:center">
      Dúvidas? Responda este e-mail ou escreva para
      <a href="mailto:contato@aquieteagora.com.br" style="color:#A8352F">contato@aquieteagora.com.br</a>
    </div>
  </div>
</div>`

/** Confirmação para quem comprou. */
export function htmlConfirmacao({ nome, referencia, descricao, total }) {
  const primeiro = esc(String(nome || '').split(' ')[0] || 'Olá')
  return MOLDURA(`
    <h1 style="font-family:Georgia,serif;font-size:22px;color:#2A1613;margin:0 0 16px;font-weight:normal">
      ${primeiro}, seu pagamento caiu.
    </h1>
    <p style="margin:0 0 16px">
      Recebemos a confirmação e já estamos preparando seu pedido. Ele é despachado
      em até <strong style="color:#2A1613">2 dias úteis</strong>, e assim que sair
      você recebe o código de rastreio por aqui.
    </p>
    <table style="width:100%;border-collapse:collapse;margin:20px 0;font-size:14px">
      <tr><td style="padding:8px 0;border-bottom:1px solid #F1DFD9;color:#82655F">Pedido</td>
          <td style="padding:8px 0;border-bottom:1px solid #F1DFD9;text-align:right;color:#2A1613"><strong>${esc(referencia)}</strong></td></tr>
      <tr><td style="padding:8px 0;border-bottom:1px solid #F1DFD9;color:#82655F">Item</td>
          <td style="padding:8px 0;border-bottom:1px solid #F1DFD9;text-align:right;color:#2A1613">${esc(descricao)}</td></tr>
      <tr><td style="padding:8px 0;color:#82655F">Total pago</td>
          <td style="padding:8px 0;text-align:right;color:#A8352F;font-size:18px"><strong>${brl(total)}</strong></td></tr>
    </table>
    <div style="background:#FDEBE8;border:1px solid #F8CFC9;border-radius:14px;padding:16px;margin:20px 0">
      <p style="margin:0;font-size:14px">
        <strong style="color:#2A1613">Como usar:</strong> 4 gotas embaixo da língua,
        segure alguns segundos antes de engolir. Pode repetir quantas vezes precisar
        ao longo do dia.
      </p>
    </div>
    <p style="margin:16px 0 0;font-size:13px;color:#82655F">
      Você tem 30 dias de garantia. As condições estão em
      <a href="https://aquieteagora.com.br/termos#garantia" style="color:#A8352F">aquieteagora.com.br/termos</a>.
    </p>`)
}

/** Aviso interno de venda. */
export function htmlVenda({ referencia, descricao, total, cliente }) {
  return MOLDURA(`
    <h1 style="font-family:Georgia,serif;font-size:22px;color:#2A1613;margin:0 0 16px;font-weight:normal">
      Venda confirmada — ${brl(total)}
    </h1>
    <table style="width:100%;border-collapse:collapse;font-size:14px">
      <tr><td style="padding:6px 0;color:#82655F">Pedido</td><td style="padding:6px 0;text-align:right"><strong>${esc(referencia)}</strong></td></tr>
      <tr><td style="padding:6px 0;color:#82655F">Item</td><td style="padding:6px 0;text-align:right">${esc(descricao)}</td></tr>
      <tr><td style="padding:6px 0;color:#82655F">Cliente</td><td style="padding:6px 0;text-align:right">${esc(cliente.nome)}</td></tr>
      <tr><td style="padding:6px 0;color:#82655F">E-mail</td><td style="padding:6px 0;text-align:right">${esc(cliente.email)}</td></tr>
      <tr><td style="padding:6px 0;color:#82655F">Telefone</td><td style="padding:6px 0;text-align:right">${esc(cliente.telefone)}</td></tr>
      <tr><td style="padding:6px 0;color:#82655F;vertical-align:top">Endereço</td>
          <td style="padding:6px 0;text-align:right">${esc(cliente.endereco)}</td></tr>
    </table>
    <p style="margin:20px 0 0;font-size:13px;color:#82655F">Despachar em até 2 dias úteis.</p>`)
}
