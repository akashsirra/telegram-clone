import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

export function createSupabaseClient(rememberMe: boolean) {
  return createClient(supabaseUrl, supabaseAnonKey, {
    auth: {
      persistSession: true,
      storage: rememberMe ? localStorage : sessionStorage,
    },
  });
}

// Default client (remembers by default until login page sets preference)
export const supabase = createClient(supabaseUrl, supabaseAnonKey);