/**
 * Lê a geolocalização que o Netlify anexa nas requisições (header
 * x-nf-geo). Só existe atrás do CDN deles em produção — falha em
 * silêncio se não vier nada.
 *
 * `pais` vem do código do país (BR, US...) — necessário pra separar
 * visita real de bot/scanner estrangeiro, porque a sigla de estado
 * sozinha é ambígua (ex.: "MA" é Maranhão no Brasil e Massachusetts
 * nos EUA, "PA" é Pará e Pennsylvania).
 */
export function geoDe(req) {
  try {
    const bruto = req.headers.get('x-nf-geo')
    if (!bruto) return null
    const g = JSON.parse(Buffer.from(bruto, 'base64').toString('utf8'))
    return { cidade: g?.city || '', uf: g?.subdivision?.code || '', pais: g?.country?.code || '' }
  } catch {
    return null
  }
}
