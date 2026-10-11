/**
 * GET /api/imagem/<id>.<ext>   aberto, é o endereço que vai no site
 *
 * O id muda a cada envio, então o arquivo nunca muda de conteúdo: dá
 * pra mandar o navegador guardar por um ano e a imagem só vai à rede
 * uma vez por pessoa.
 */

const TIPOS = ['image/webp', 'image/jpeg', 'image/png']

let getStore = null
async function loja() {
  if (!getStore) ({ getStore } = await import('@netlify/blobs'))
  return getStore('imagens')
}

export default async (req, contexto) => {
  const bruto = String(contexto?.params?.id || '')
  // a extensão no fim é só pra parecer arquivo: o tipo de verdade está
  // guardado junto com os bytes
  const id = bruto.split('.')[0].replace(/[^a-z0-9]/gi, '')
  if (!id) return new Response('não achei', { status: 404 })

  const store = await loja()
  const achado = await store
    .getWithMetadata('arq/' + id, { type: 'arrayBuffer' })
    .catch(() => null)
  if (!achado?.data) return new Response('não achei', { status: 404 })

  const tipo = String(achado.metadata?.tipo || '')
  if (!TIPOS.includes(tipo)) return new Response('não achei', { status: 404 })

  return new Response(achado.data, {
    headers: {
      'Content-Type': tipo,
      'Content-Disposition': 'inline',
      'Cache-Control': 'public, max-age=31536000, immutable',
      // o tipo vem de mim, não do navegador adivinhando pelo conteúdo
      'X-Content-Type-Options': 'nosniff',
    },
  })
}

export const config = { path: '/api/imagem/:id' }
