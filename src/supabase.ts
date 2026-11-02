import { createClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined
const key = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined

export const configReady = Boolean(url && key && !url.includes('SEU-PROJETO') && !key.includes('SUA_CHAVE'))
export const supabase = createClient(
  url || 'https://placeholder.supabase.co',
  key || 'placeholder',
  { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } }
)
