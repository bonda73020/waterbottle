import { useEffect, useRef, useState } from 'react'
import '@google/model-viewer'
import bottleUrl from './assets/3dModel/bottle.glb?url'
import labelUrl from './assets/3dModel/bottleWrap.png'
import './App.css'

// hex: колір корпусу, label: колір напису на етикетці
const COLORS = [
  { name: 'Vegas Gold',    hex: '#c5b358', label: '#2a2410' },
  { name: 'Athletic Gold', hex: '#fdb827', label: '#2b1d00' },
  { name: 'Lime Green',    hex: '#6cbe45', label: '#10300a' },
  { name: 'Maroon',        hex: '#6b1d2a', label: '#ffffff' },
  { name: 'Red',           hex: '#c8102e', label: '#ffffff' },
  { name: 'Purple',        hex: '#5b2c83', label: '#ffffff' },
  { name: 'Royal Blue',    hex: '#1f4fa3', label: '#ffffff' },
  { name: 'Black',         hex: '#1a1a1a', label: '#ffffff' },
  { name: 'Khaki',         hex: '#c3b091', label: '#2b2418' },
]

const ACTION = 'Action' // клік: рол пляшки

// Наскільки пляшка зміщена вправо від центру екрана (у координатах -1..1).
// 0.236 => центр пляшки на 61.8% ширини (золотий переріз)
const SHIFT = 0.236

// «Кадри» камери по скролу (відносно стартового вигляду).
// at: 0..1 прогрес скролу всієї сторінки
// theta/phi: градуси (поворот навколо / вгору-вниз)
// zoom: множник відстані (0.5 = удвічі ближче)
// x/y/z: зсув точки, на яку дивиться камера, в метрах
const SHOTS = [
  { at: 0,   theta: 0,   phi: 0,  zoom: 1.15, x: 0, y: -0.015, z: 0 },
  { at: 0.4, theta: -25, phi: 5,  zoom: 0.75, x: 0, y: 0.02,   z: 0 },
  { at: 0.75, theta: -45, phi: 10, zoom: 0.45, x: 0, y: 0.06,  z: 0 },
  { at: 1,   theta: -60, phi: 12, zoom: 1.0,  x: 0, y: 0,      z: 0 },
]

// Налаштування «Color Ramp» з Blender
const RAMP = { lo: 0.0, hi: 0.395, invert: true }

const hexToRgb = (hex) =>
  [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16))

const rgbToHex = (rgb) =>
  '#' + rgb.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')

const ease = (t) => 1 - Math.pow(1 - t, 3)
const clamp01 = (v) => Math.min(1, Math.max(0, v))
const lerp = (a, b, t) => a + (b - a) * t
const smooth = (t) => t * t * (3 - 2 * t)
const rad = (deg) => (deg * Math.PI) / 180

function sampleShot(p) {
  for (let i = 0; i < SHOTS.length - 1; i++) {
    const a = SHOTS[i]
    const b = SHOTS[i + 1]
    if (p <= b.at) {
      const t = smooth(clamp01((p - a.at) / (b.at - a.at)))
      const out = {}
      for (const k of ['theta', 'phi', 'zoom', 'x', 'y', 'z']) {
        out[k] = lerp(a[k], b[k], t)
      }
      return out
    }
  }
  return SHOTS[SHOTS.length - 1]
}

// Аналог Image Texture -> Color Ramp -> Alpha: біле «чорнило» + альфа-маска
async function makeLabelTexture(viewer, url) {
  const img = new Image()
  img.src = url
  await img.decode()

  const canvas = document.createElement('canvas')
  canvas.width = img.naturalWidth
  canvas.height = img.naturalHeight
  const ctx = canvas.getContext('2d')
  ctx.drawImage(img, 0, 0)

  const data = ctx.getImageData(0, 0, canvas.width, canvas.height)
  const px = data.data

  for (let i = 0; i < px.length; i += 4) {
    const lum = (0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2]) / 255
    const linear = Math.pow(lum, 2.2) // sRGB -> лінійний, як у Blender

    let a = clamp01((linear - RAMP.lo) / (RAMP.hi - RAMP.lo))
    if (RAMP.invert) a = 1 - a

    px[i] = px[i + 1] = px[i + 2] = 255
    px[i + 3] = Math.round(a * 255)
  }

  ctx.putImageData(data, 0, 0)
  const blob = await new Promise((res) => canvas.toBlob(res, 'image/png'))
  return viewer.createTexture(URL.createObjectURL(blob))
}

function App() {
  const viewerRef = useRef(null)
  const bodyMaterial = useRef(null)
  const labelMaterial = useRef(null)
  const currentBody = useRef(hexToRgb(COLORS[0].hex))
  const currentLabel = useRef(hexToRgb(COLORS[0].label))
  const frame = useRef(null)

  // скрол -> камера
  const targetProgress = useRef(0)
  const shownProgress = useRef(0)
  const baseView = useRef(null) // стартовий вигляд камери
  const needsApply = useRef(false)
  const raf = useRef(null)

  const [active, setActive] = useState(0)

  useEffect(() => {
    const viewer = viewerRef.current

    const applyCamera = (p) => {
      const base = baseView.current
      if (!base) return

      const s = sampleShot(p)
      const theta = base.theta + rad(s.theta)
      const phi = base.phi + rad(s.phi)
      const radius = base.radius * s.zoom

      // зсув пляшки вправо: рухаємо точку погляду вліво в екранних координатах
      const vfov = rad(viewer.getFieldOfView())
      const aspect = viewer.clientWidth / viewer.clientHeight
      const halfWidth = radius * Math.tan(vfov / 2) * aspect
      const shift = (window.innerWidth > 700 ? SHIFT : 0) * halfWidth

      const tx = base.x + s.x - Math.cos(theta) * shift
      const ty = base.y + s.y
      const tz = base.z + s.z + Math.sin(theta) * shift

      viewer.cameraOrbit = `${theta}rad ${phi}rad ${radius}m`
      viewer.cameraTarget = `${tx}m ${ty}m ${tz}m`
      viewer.jumpCameraToGoal()
    }

    const onLoad = async () => {
      const materials = viewer.model.materials
      console.log('Materials in GLB:', materials.map((m) => m.name))
      console.log('Animations in GLB:', viewer.availableAnimations)

      labelMaterial.current = materials.find((m) =>
        m.name.toLowerCase().includes('label'),
      )
      bodyMaterial.current =
        materials.find((m) => m.name.toLowerCase().includes('body')) ||
        materials[0]

      if (labelMaterial.current) {
        const tex = await makeLabelTexture(viewer, labelUrl)
        labelMaterial.current.pbrMetallicRoughness.baseColorTexture.setTexture(tex)
        labelMaterial.current.setAlphaMode('BLEND')
      }

      bodyMaterial.current?.pbrMetallicRoughness.setBaseColorFactor(
        COLORS[0].hex,
      )
      labelMaterial.current?.pbrMetallicRoughness.setBaseColorFactor(
        COLORS[0].label,
      )

      if (viewer.availableAnimations.includes(ACTION)) {
        viewer.animationName = ACTION
        viewer.pause()
        viewer.currentTime = 0
      }

      // запам'ятати стартовий вигляд камери
      const o = viewer.getCameraOrbit()
      const t = viewer.getCameraTarget()
      baseView.current = {
        theta: o.theta,
        phi: o.phi,
        radius: o.radius,
        x: t.x,
        y: t.y,
        z: t.z,
      }
      needsApply.current = true
    }

    const onFinished = () => {
      viewer.pause()
    }

    // прогрес = скрол усієї сторінки
    const onScroll = () => {
      const max = document.documentElement.scrollHeight - window.innerHeight
      targetProgress.current = max > 0 ? clamp01(window.scrollY / max) : 0
    }

    const onResize = () => {
      onScroll()
      needsApply.current = true
    }

    const tick = () => {
      const diff = targetProgress.current - shownProgress.current
      if (baseView.current && (Math.abs(diff) > 0.0005 || needsApply.current)) {
        shownProgress.current += diff * 0.12 // плавність: більше = різкіше
        applyCamera(shownProgress.current)
        needsApply.current = false
      }
      raf.current = requestAnimationFrame(tick)
    }

    viewer.addEventListener('load', onLoad)
    viewer.addEventListener('finished', onFinished)
    window.addEventListener('scroll', onScroll, { passive: true })
    window.addEventListener('resize', onResize)
    onScroll()
    raf.current = requestAnimationFrame(tick)

    return () => {
      viewer.removeEventListener('load', onLoad)
      viewer.removeEventListener('finished', onFinished)
      window.removeEventListener('scroll', onScroll)
      window.removeEventListener('resize', onResize)
      cancelAnimationFrame(raf.current)
      cancelAnimationFrame(frame.current)
    }
  }, [])

  const changeColor = (index) => {
    setActive(index)

    window.parent.postMessage(
      { type: 'orrin:color', color: COLORS[index].name },
      '*',
    )

    const viewer = viewerRef.current
    if (viewer && viewer.availableAnimations.includes(ACTION)) {
      viewer.animationName = ACTION
      viewer.pause()
      viewer.currentTime = 0
      viewer.play({ repetitions: 1 })
    }

    cancelAnimationFrame(frame.current)

    const targets = [
      {
        material: bodyMaterial.current,
        ref: currentBody,
        to: hexToRgb(COLORS[index].hex),
      },
      {
        material: labelMaterial.current,
        ref: currentLabel,
        to: hexToRgb(COLORS[index].label),
      },
    ].filter((t) => t.material)

    const startColors = targets.map((t) => [...t.ref.current])
    const duration = 450
    const start = performance.now()

    const step = (now) => {
      const t = Math.min((now - start) / duration, 1)
      const k = ease(t)

      targets.forEach((target, n) => {
        const rgb = startColors[n].map((v, i) => v + (target.to[i] - v) * k)
        target.ref.current = rgb
        target.material.pbrMetallicRoughness.setBaseColorFactor(rgbToHex(rgb))
      })

      if (t < 1) frame.current = requestAnimationFrame(step)
    }

    frame.current = requestAnimationFrame(step)
  }

  return (
    <>
      {/* 3D на весь екран, під усім контентом */}
      <model-viewer
        ref={viewerRef}
        src={bottleUrl}
        alt="Orrin Trail Flask 3D model"
        disable-pan
        interaction-prompt="none"
        camera-orbit="45deg 75deg 105%"
        min-camera-orbit="auto 0deg 1%"
        max-camera-orbit="auto 180deg 500%"
        shadow-intensity="1"
        environment-image="neutral"
      />

      {/* кольори, зафіксовані під пляшкою */}
      <div className="colors">
        {COLORS.map((c, i) => (
          <button
            key={c.name}
            className={i === active ? 'swatch active' : 'swatch'}
            style={{ background: c.hex }}
            onClick={() => changeColor(i)}
            aria-label={c.name}
            title={c.name}
          />
        ))}
        <span className="color-name">{COLORS[active].name}</span>
      </div>

      {/* текст скролиться поверх моделі, зліва */}
      <main className="content">
        <section className="section">
          <div className="panel">
            <span className="eyebrow">Orrin / Trail Series</span>
            <h1>Trail Flask</h1>
            <p>
              Double-wall steel keeps water cold for 24 hours and hot for 12.
              A wide mouth fits ice, a cork cap seals in one twist, and the
              matte finish stays quiet on the trail.
            </p>
            <div className="price">$34</div>
            <span className="scroll-hint">Scroll to explore ↓</span>
          </div>
        </section>

        <section className="section">
          <div className="panel">
            <span className="eyebrow">Built to last</span>
            <h2>Details that earn their place.</h2>
            <ul className="specs">
              <li>750 mL / 25.4 fl oz</li>
              <li>18/8 stainless steel, double-wall</li>
              <li>Cork &amp; silicone cap</li>
              <li>Powder-coat finish, dishwasher safe</li>
            </ul>
            <p>
              Every surface is designed to be picked up, dropped and used
              again tomorrow. The wrap label is printed in a single ink that
              adapts to the color underneath.
            </p>
          </div>
        </section>

        <section className="section">
          <div className="panel">
            <span className="eyebrow">Finishes</span>
            <h2>Nine colors, one flask.</h2>
            <p>{COLORS.map((c) => c.name).join(', ')}.</p>
            <p>
              Pick a swatch below the bottle and watch the body, label and
              cap respond in real time. Same model, same lighting, nothing
              pre-rendered.
            </p>
          </div>
        </section>

        <section className="section">
          <div className="panel">
            <span className="eyebrow">About this project</span>
            <h2>Made to be looked at.</h2>
            <p>
              This page is a small showcase of interactive 3D product
              visualization: one model, built and animated in Blender, then
              driven by scroll and color in the browser.
            </p>
            <p className="disclaimer">
              Orrin is a fictional brand. This is an art project for
              demonstrative purposes only. The product does not exist, and
              nothing on this page is for sale.
            </p>
            <footer className="footer">
              3D model, animation and interactive viewer by Bohdan Myronets
            </footer>
          </div>
        </section>
      </main>
    </>
  )
}

export default App