import sharp from 'sharp'

const SRC = 'pwa3.jpeg'
// white background fill
const BG = { r: 255, g: 255, b: 255, alpha: 1 }
const sizes = [192, 512]

async function generate() {
  // Trim transparent padding so the real logo fills as much as possible
  const trimmed = await sharp(SRC).trim().toBuffer()
  const meta = await sharp(trimmed).metadata()
  console.log('trimmed content:', meta.width, 'x', meta.height)

  for (const size of sizes) {
    const scale = Math.min(size / meta.width, size / meta.height)
    const w = Math.round(meta.width * scale)
    const h = Math.round(meta.height * scale)

    const img = await sharp(trimmed).resize(w, h).png().toBuffer()

    // Regular icon (purpose: any) -> fills the whole canvas
    await sharp({
      create: { width: size, height: size, channels: 4, background: BG }
    })
      .composite([{ input: img, gravity: 'center' }])
      .png()
      .toFile(`public/icon-${size}x${size}.png`)
    console.log(`regular ${size}: logo ${w}x${h} (${((w / size) * 100).toFixed(0)}% width)`)

    // Maskable icon (purpose: maskable) -> keep content inside the 80% safe zone
    const safe = size * 0.8
    const mScale = Math.min(safe / meta.width, safe / meta.height)
    const mw = Math.round(meta.width * mScale)
    const mh = Math.round(meta.height * mScale)
    const mImg = await sharp(trimmed).resize(mw, mh).png().toBuffer()

    await sharp({
      create: { width: size, height: size, channels: 4, background: BG }
    })
      .composite([{ input: mImg, gravity: 'center' }])
      .png()
      .toFile(`public/icon-${size}x${size}-maskable.png`)
    console.log(`maskable ${size}: logo ${mw}x${mh} (safe zone ${safe}px)`)
  }

  // apple-touch-icon (180x180) for consistency
  const atScale = Math.min(180 / meta.width, 180 / meta.height)
  const atW = Math.round(meta.width * atScale)
  const atH = Math.round(meta.height * atScale)
  await sharp({
    create: { width: 180, height: 180, channels: 4, background: BG }
  })
    .composite([{ input: await sharp(trimmed).resize(atW, atH).png().toBuffer(), gravity: 'center' }])
    .png()
    .toFile('public/apple-touch-icon.png')
  console.log('apple-touch-icon: 180x180')
}

generate().catch((e) => {
  console.error(e)
  process.exit(1)
})
