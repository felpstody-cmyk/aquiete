/**
 * De onde veio a visita: anúncio, orgânico, direto etc.
 *
 * Importante: o cabeçalho HTTP "Referer" da própria chamada fetch() é a
 * página que fez a chamada (o próprio site), não quem trouxe a pessoa até
 * aqui — por isso o front manda document.referrer como parâmetro `ref`.
 */
/**
 * Nome da campanha do anúncio, vindo de `utm_campaign`.
 *
 * Existe separado de `origemDe` de propósito: origem responde "veio de
 * anúncio ou orgânico", campanha responde "qual criativo trouxe". Sem isso
 * todo anúncio do Meta cai no mesmo balde e não dá pra comparar um contra
 * o outro sem depender do gerenciador.
 */
export function campanhaDe(url) {
  const bruto = (url.searchParams.get('utm_campaign') || '').trim().toLowerCase()
  if (!bruto) return null
  // Corta tamanho e tira ":" porque a chave do contador é separada por ":"
  return bruto.replace(/:/g, '-').slice(0, 60)
}

export function origemDe(url) {
  const p = url.searchParams
  const utmSource = (p.get('utm_source') || '').toLowerCase()
  const utmMedium = (p.get('utm_medium') || '').toLowerCase()
  const pago = utmMedium.includes('cpc') || utmMedium.includes('paid') || utmMedium.includes('ad')

  if (p.get('fbclid')) return 'Facebook/Instagram (anúncio)'
  if (p.get('gclid')) return 'Google (anúncio)'

  if (utmSource) {
    if (['facebook', 'fb', 'instagram', 'ig'].includes(utmSource)) {
      return pago ? 'Facebook/Instagram (anúncio)' : 'Instagram/Facebook (orgânico)'
    }
    if (utmSource === 'google') return pago ? 'Google (anúncio)' : 'Google (orgânico)'
    if (utmSource === 'whatsapp') return 'WhatsApp'
    return utmSource.charAt(0).toUpperCase() + utmSource.slice(1)
  }

  const ref = p.get('ref') || ''
  let host = ''
  try { host = new URL(ref).hostname.replace(/^www\./, '') } catch { host = '' }
  if (!host) return 'Direto ou desconhecido'
  if (host.includes('instagram.com')) return 'Instagram (orgânico)'
  if (host.includes('facebook.com') || host.includes('fb.com')) return 'Facebook (orgânico)'
  if (host.includes('google.')) return 'Google (orgânico)'
  if (host.includes('whatsapp.com') || host.includes('wa.me')) return 'WhatsApp'
  if (host.includes('aquieteagora.com.br')) return null // navegação interna, não conta de novo
  return host
}
