/**
 * Lê a geolocalização que o Netlify anexa nas requisições (header
 * x-nf-geo). Só existe atrás do CDN deles em produção — falha em
 * silêncio se não vier nada.
 */
export function geoDe(req) {
  try {
    const bruto = req.headers.get('x-nf-geo')
    if (!bruto) return null
    const g = JSON.parse(Buffer.from(bruto, 'base64').toString('utf8'))
    return { cidade: g?.city || '', uf: g?.subdivision?.code || '' }
  } catch {
    return null
  }
}
