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
    .select('id, user_id, active_mode_id')
    .eq('uid', uid)
    .maybeSingle()

  if (objErr || !obj?.id || !obj.user_id) {
    return NextResponse.json({ error: 'not found' }, { status: 404 })
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

  return NextResponse.redirect(href, {
    status: 302,
    headers,
  })
}
