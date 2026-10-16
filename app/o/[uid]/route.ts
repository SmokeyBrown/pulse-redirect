import { createClient } from '@supabase/supabase-js'
import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'
export const revalidate = 0

const EMAIL_LIKE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const PHONE_LIKE = /^\+?[\d\s().-]{10,}$/

function normalizeOutboundUrl(raw: string, modeType: string | null): string | null {
  const trimmed = raw.trim()
  if (!trimmed) return null
  const lower = trimmed.toLowerCase()
  if (
    lower.startsWith('http://') ||
    lower.startsWith('https://') ||
    lower.startsWith('mailto:') ||
    lower.startsWith('tel:') ||
    lower.startsWith('sms:') ||
    lower.startsWith('geo:')
  ) {
    return trimmed
  }
  if (EMAIL_LIKE.test(trimmed)) return `mailto:${trimmed}`
  const compact = trimmed.replace(/\s/g, '')
  if (PHONE_LIKE.test(compact)) {
    return trimmed.startsWith('+') ? `tel:${trimmed}` : `tel:${compact.replace(/[^\d+]/g, '')}`
  }
  if (/^[\w.-]+\.[a-z]{2,}([/?#].*)?$/i.test(trimmed)) {
    return `https://${trimmed}`
  }
  const t = (modeType || 'social').toLowerCase()
  if (t === 'social' || t === 'media' || t === 'pitch') {
    return `https://${trimmed}`
  }
  return trimmed
}

/**
 * GET /o/[uid]
 * Server-side redirect for smart links: object → mode target_url, log tap_events.
 * Env: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */
export async function GET(
  _req: Request,
  context: { params: { uid: string } }
) {
  const { uid: rawUid } = context.params
  const uid = rawUid?.trim()
  if (!uid) {
    return NextResponse.json({ error: 'missing uid' }, { status: 400 })
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!supabaseUrl || !serviceKey) {
    return NextResponse.json({ error: 'server misconfigured' }, { status: 500 })
  }

  const supabase = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })

  const { data: obj, error: objErr } = await supabase
    .from('objects')
    .select('id, user_id, active_mode_id, mode_config')
    .eq('uid', uid)
    .maybeSingle()

  if (objErr || !obj?.id) {
    return NextResponse.json({ error: 'not found' }, { status: 404 })
  }

  if (!obj.user_id) {
    // Unclaimed object. If it carries a lost-and-found flag, show the finder
    // a "please return this" page instead of a 404. Once the object is claimed
    // again this branch is skipped and normal routing resumes.
    const lost = parseLostConfig(obj.mode_config)
    if (!lost) {
      return NextResponse.json({ error: 'not found' }, { status: 404 })
    }

    await supabase.from('unclaimed_tap_events').insert({
      object_id: obj.id,
      uid,
    })

    return new NextResponse(lostRingPage(lost), {
      status: 200,
      headers: {
        'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
        'Pragma': 'no-cache',
        'X-Robots-Tag': 'noindex, nofollow',
        'Content-Type': 'text/html; charset=utf-8',
      },
    })
  }

  let modeId: string | null = null

  const { data: omRow, error: omErr } = await supabase
    .from('object_modes')
    .select('mode_id')
    .eq('object_id', obj.id)
    .maybeSingle()

  if (!omErr && omRow?.mode_id) {
    modeId = omRow.mode_id as string
  } else if (obj.active_mode_id) {
    modeId = obj.active_mode_id as string
  }

  if (!modeId) {
    return NextResponse.json({ error: 'no active mode' }, { status: 404 })
  }

  const { data: mode, error: modeErr } = await supabase
    .from('modes')
    .select('id, target_url, mode_type')
    .eq('id', modeId)
    .eq('user_id', obj.user_id)
    .maybeSingle()

  if (modeErr || !mode) {
    return NextResponse.json({ error: 'mode not found' }, { status: 404 })
  }

  const rawUrl = mode.target_url as string | null
  const modeType = (mode.mode_type as string | null) ?? null
  const href = rawUrl ? normalizeOutboundUrl(rawUrl, modeType) : null
  if (!href) {
    return NextResponse.json({ error: 'no destination URL' }, { status: 404 })
  }

  const intent = (modeType && String(modeType).trim()) || 'link'

  await supabase.from('tap_events').insert({
    object_id: obj.id,
    uid,
    user_id: obj.user_id,
    intent,
  })

  const headers = {
    'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
    'Pragma': 'no-cache',
  }

  // LinkedIn: iOS and Android only hand a link to the app on a real user tap,
  // never on a server redirect. Serve a minimal page with one big button that
  // is a plain linkedin.com link so the tap opens the app.
  if (isLinkedInUrl(href)) {
    return new NextResponse(linkedInButtonPage(href), {
      status: 200,
      headers: {
        ...headers,
        'Content-Type': 'text/html; charset=utf-8',
      },
    })
  }

  return NextResponse.redirect(href, {
    status: 302,
    headers,
  })
}

type LostConfig = {
  name: string
  phone: string | null
  email: string | null
  message: string | null
}

/**
 * Reads objects.mode_config.lost. Shape:
 * { enabled: true, name: string, phone?: string, email?: string, message?: string }
 * Returns null unless enabled with a name and at least one way to reach the owner.
 */
function parseLostConfig(modeConfig: unknown): LostConfig | null {
  if (!modeConfig || typeof modeConfig !== 'object') return null
  const lost = (modeConfig as Record<string, unknown>).lost
  if (!lost || typeof lost !== 'object') return null
  const l = lost as Record<string, unknown>
  if (l.enabled !== true) return null

  const str = (v: unknown): string | null =>
    typeof v === 'string' && v.trim() ? v.trim().slice(0, 300) : null

  const name = str(l.name)
  const phone = str(l.phone)
  const email = str(l.email)
  if (!name || (!phone && !email)) return null

  return { name, phone, email, message: str(l.message) }
}

function formatPhoneDisplay(raw: string): string {
  const digits = raw.replace(/\D/g, '')
  if (digits.length === 10) {
    return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`
  }
  if (digits.length === 11 && digits.startsWith('1')) {
    return `+1 (${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7)}`
  }
  return raw
}

function phoneDialHref(raw: string): string {
  const digits = raw.replace(/\D/g, '')
  if (raw.trim().startsWith('+')) return `+${digits}`
  if (digits.length === 10) return `+1${digits}`
  return digits
}

function lostRingPage(lost: LostConfig): string {
  const name = escapeHtmlAttr(lost.name)
  const firstName = escapeHtmlAttr(lost.name.split(/\s+/)[0] || lost.name)
  const note = lost.message
    ? escapeHtmlAttr(lost.message)
    : `If you found it, please help get it back to ${firstName}. Thank you!`

  const buttons: string[] = []
  if (lost.phone) {
    const dial = escapeHtmlAttr(phoneDialHref(lost.phone))
    buttons.push(
      `<a class="btn primary" href="tel:${dial}">Call ${firstName}</a>`,
      `<a class="btn" href="sms:${dial}">Text ${firstName}</a>`
    )
  }
  if (lost.email) {
    const mail = escapeHtmlAttr(lost.email)
    buttons.push(`<a class="btn" href="mailto:${mail}?subject=${encodeURIComponent('I found your Pulse ring')}">Email ${firstName}</a>`)
  }

  const details: string[] = []
  if (lost.phone) {
    details.push(`<div class="row"><span>Phone</span><strong>${escapeHtmlAttr(formatPhoneDisplay(lost.phone))}</strong></div>`)
  }
  if (lost.email) {
    details.push(`<div class="row"><span>Email</span><strong>${escapeHtmlAttr(lost.email)}</strong></div>`)
  }

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex, nofollow">
<title>Lost ring: please return</title>
<style>
  :root { color-scheme: light dark; --bg:#ffffff; --fg:#0a0a0a; --muted:#6b6b6b; --card:#f3f3f1; --line:#e3e3df; }
  @media (prefers-color-scheme: dark) { :root { --bg:#0a0a0a; --fg:#ffffff; --muted:#a3a3a3; --card:#161616; --line:#262626; } }
  * { box-sizing: border-box; }
  html, body { margin: 0; min-height: 100%; }
  body {
    display: flex; align-items: center; justify-content: center;
    padding: 24px; background: var(--bg); color: var(--fg);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  main { width: 100%; max-width: 400px; text-align: center; }
  .badge {
    display: inline-block; padding: 6px 14px; border-radius: 999px;
    background: var(--card); border: 1px solid var(--line);
    font-size: 12px; font-weight: 600; letter-spacing: .08em; text-transform: uppercase; color: var(--muted);
  }
  h1 { margin: 20px 0 10px; font-size: 30px; line-height: 1.15; font-weight: 700; letter-spacing: -.02em; }
  p.note { margin: 0 0 28px; font-size: 17px; line-height: 1.5; color: var(--muted); }
  .actions { display: grid; gap: 12px; margin-bottom: 24px; }
  a.btn {
    display: block; padding: 17px 20px; border-radius: 999px;
    border: 1px solid var(--line); background: var(--card); color: var(--fg);
    font-size: 17px; font-weight: 600; text-decoration: none;
    -webkit-tap-highlight-color: transparent;
  }
  a.btn.primary { background: var(--fg); color: var(--bg); border-color: var(--fg); }
  a.btn:active { opacity: .8; }
  .card { text-align: left; border: 1px solid var(--line); background: var(--card); border-radius: 16px; padding: 4px 18px; }
  .row { display: flex; justify-content: space-between; gap: 16px; padding: 14px 0; font-size: 15px; }
  .row + .row { border-top: 1px solid var(--line); }
  .row span { color: var(--muted); }
  .row strong { font-weight: 600; text-align: right; overflow-wrap: anywhere; }
</style>
</head>
<body>
<main>
  <div class="badge">Lost ring</div>
  <h1>This ring belongs to ${name}</h1>
  <p class="note">${note}</p>
  <div class="actions">${buttons.join('')}</div>
  <div class="card">${details.join('')}</div>
</main>
</body>
</html>`
}

function isLinkedInUrl(href: string): boolean {
  try {
    const u = new URL(href)
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return false
    const host = u.hostname.toLowerCase()
    return (
      host === 'linkedin.com' ||
      host.endsWith('.linkedin.com') ||
      host === 'lnkd.in'
    )
  } catch {
    return false
  }
}

function escapeHtmlAttr(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function linkedInButtonPage(href: string): string {
  const safe = escapeHtmlAttr(href)
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex">
<title>Open LinkedIn</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  html, body { height: 100%; margin: 0; }
  body {
    display: flex; align-items: center; justify-content: center;
    padding: 24px; background: #ffffff;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  }
  @media (prefers-color-scheme: dark) { body { background: #000000; } }
  a.btn {
    display: block; width: 100%; max-width: 360px;
    padding: 20px 24px; border-radius: 999px;
    background: #0a66c2; color: #ffffff;
    font-size: 20px; font-weight: 600; text-align: center; text-decoration: none;
    -webkit-tap-highlight-color: transparent;
  }
  a.btn:active { background: #004182; }
</style>
</head>
<body>
<a class="btn" href="${safe}">Open LinkedIn</a>
</body>
</html>`
}
