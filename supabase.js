const SUPABASE_URL = 'https://okjqasuwcvrumvyakulo.supabase.co';
const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_fEAgFfwXMWSDjA2T0UO-aQ_5ZY5ChLn';

let supabaseClient = null;

if (window.supabase && typeof window.supabase.createClient === 'function') {
    supabaseClient = window.supabase.createClient(
        SUPABASE_URL,
        SUPABASE_PUBLISHABLE_KEY,
        {
            auth: {
                persistSession: true,
                autoRefreshToken: true,
                detectSessionInUrl: true
            }
        }
    );
} else {
    window.__kngBootError?.('Supabase library is unavailable. The schedule cannot connect to its database.');
}
