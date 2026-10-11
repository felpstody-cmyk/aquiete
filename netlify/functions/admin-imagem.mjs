/**
 * GET    /api/admin-imagem          (x-admin-token)  lista o que já subiu
 * POST   /api/admin-imagem          (x-admin-token)  manda uma imagem nova
 *        { nome, tipo, largura, altura, dados }   dados = base64 puro
 * DELETE /api/admin-imagem?id=...   (x-admin-token)  apaga
 *
 * Existe pra trocar imagem do site sem commit e sem deploy. Todo deploy
 * gasta crédito no Netlify, e trocar uma foto não deveria custar um
 * build inteiro. O arquivo fica guardado em blob e sai pelo endereço
 * público /api/imagem/<id>.
 */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type, x-admin-token',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
}

const json = (dados, status = 200) =>
  new Response(JSON.stringify(dados), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...CORS },
  })

let getStore = null
async function loja() {
  if (!getStore) ({ getStore } = await import('@netlify/blobs'))
  return getStore('imagens')
}

const TIPOS = { 'image/webp': 'webp', 'image/jpeg': 'jpg', 'image/png': 'png' }
const LIMITE = 3 * 1024 * 1024
const MAXIMO = 300

/**
 * O tipo chega dito pelo navegador, e navegador acredita na extensão do
 * arquivo. Como o endereço que serve a imagem fica no meu domínio, um
 * arquivo renomeado viraria página servida por aquieteagora.com.br. Por
 * isso confiro a assinatura dos primeiros bytes antes de guardar.
 */
function assinaturaBate(b, tipo) {
  if (tipo === 'image/png') {
    return b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47
  }
  if (tipo === 'image/jpeg') {
    return b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff
  }
  if (tipo === 'image/webp') {
    return b.length > 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP'
  }
  return false
}

export default async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS })

  const esperado = process.env.ADMIN_TOKEN
  if (!esperado) return json({ erro: 'ADMIN_TOKEN não configurado no Netlify' }, 500)
  if (req.headers.get('x-admin-token') !== esperado) return json({ erro: 'Token inválido' }, 401)

  const store = await loja()
  const lista = (await store.get('lista', { type: 'json' }).catch(() => null)) || []

  if (req.method === 'GET') return json({ imagens: lista })

  if (req.method === 'DELETE') {
    const id = new URL(req.url).searchParams.get('id') || ''
    const i = lista.findIndex((x) => x.id === id)
    if (i < 0) return json({ erro: 'Imagem não encontrada' }, 404)
    await store.delete('arq/' + id).catch(() => {})
    lista.splice(i, 1)
    await store.setJSON('lista', lista)
    return json({ ok: true, imagens: lista })
  }

  if (req.method !== 'POST') return json({ erro: 'Use GET, POST ou DELETE' }, 405)

  const corpo = await req.json().catch(() => null)
  if (!corpo?.dados) return json({ erro: 'Faltando a imagem' }, 400)

  const tipo = String(corpo.tipo || '').toLowerCase()
  if (!TIPOS[tipo]) return json({ erro: 'Só aceito webp, jpg ou png' }, 400)

  let bytes
  try {
    bytes = Buffer.from(String(corpo.dados), 'base64')
  } catch {
    return json({ erro: 'Não consegui ler a imagem' }, 400)
  }
  if (!bytes.length) return json({ erro: 'Imagem vazia' }, 400)
  if (bytes.length > LIMITE) return json({ erro: 'Imagem grande demais, o limite é 3 MB' }, 413)
  if (!assinaturaBate(bytes, tipo)) return json({ erro: 'Esse arquivo não é uma imagem ' + TIPOS[tipo] }, 400)
  if (lista.length >= MAXIMO) {
    return json({ erro: 'Já são ' + MAXIMO + ' imagens guardadas. Apague alguma antes.' }, 400)
  }

  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 7)
  await store.set('arq/' + id, bytes, { metadata: { tipo } })

  const registro = {
    id,
    nome: String(corpo.nome || 'imagem').trim().slice(0, 80),
    tipo,
    bytes: bytes.length,
    largura: Number(corpo.largura) || null,
    altura: Number(corpo.altura) || null,
    em: Date.now(),
    url: '/api/imagem/' + id + '.' + TIPOS[tipo],
  }
  lista.unshift(registro)
  await store.setJSON('lista', lista)

  return json({ ok: true, imagem: registro })
}

export const config = { path: '/api/admin-imagem' }
